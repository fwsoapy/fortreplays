"""Optional resolution of Epic account ids to current display names.

Display names are not in the part of a replay this app reads. They live in the
network stream, which is Oodle-compressed and would need a full Unreal
replication decoder to reach. The practical alternative is an online lookup.

This is opt-in and does nothing without an API key, because using it means
account ids leave the machine, which is otherwise never true of this app.

Endpoint: GET https://prod.api-fortnite.com/api/v1/account/{accountId}
          header x-api-key: <key>
Response: {"id": "...", "displayName": "...", "externalAuths": {}}

Account ids must be lower case. The service treats an upper case id as a
different account and returns 404 for it.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

import store

ENDPOINT = "https://prod.api-fortnite.com/api/v1/account/{account_id}"
USER_AGENT = "FortReplays/1.0 (local replay stats tool)"
REQUEST_TIMEOUT = 12
# The service auto-throttles bursts, so requests are spaced out. Measured: a
# tight loop trips the throttle after roughly twenty calls. Names are cached
# permanently once resolved, so this cost is paid once per account, not per view.
DELAY_SECONDS = 0.9
# How long to wait before the single retry after a throttle response.
BACKOFF_SECONDS = 6.0


class LookupError(Exception):
    """The service could not be used at all, as opposed to one id not resolving."""


def _extract_name(payload) -> str | None:
    """Pull a display name out of the response without assuming one exact shape."""
    if not isinstance(payload, dict):
        return None
    for source in (payload, payload.get("data") if isinstance(payload.get("data"), dict) else None,
                   payload.get("account") if isinstance(payload.get("account"), dict) else None):
        if not isinstance(source, dict):
            continue
        for key in ("displayName", "display_name", "name"):
            value = source.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def resolve_one(account_id: str, api_key: str) -> tuple[str | None, str]:
    """Resolve a single id. Returns (name or None, status word)."""
    request = urllib.request.Request(
        ENDPOINT.format(account_id=account_id.lower()),
        headers={"x-api-key": api_key, "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            detail = ""
            try:
                body = json.loads(exc.read().decode("utf-8", "replace"))
                detail = body.get("error") or ""
            except Exception:
                pass
            raise LookupError(
                f"Lookup service rejected the request ({exc.code})."
                + (f" {detail}" if detail else " Check the API key in Settings.")
            ) from exc
        if exc.code == 429:
            raise LookupError(
                "Rate limited by the lookup service. It throttles bursts, so wait a "
                "few minutes and press the button again to carry on."
            ) from exc
        if exc.code == 404:
            return None, "no such account, or hidden"
        return None, f"http {exc.code}"
    except urllib.error.URLError as exc:
        raise LookupError(f"Could not reach the lookup service: {exc.reason}") from exc
    except (json.JSONDecodeError, ValueError):
        return None, "unreadable response"

    name = _extract_name(payload)
    return (name, "ok") if name else (None, "no name in response")


def resolve_many(conn, account_ids: list[str], api_key: str, limit: int = 150) -> dict:
    """Resolve ids that are not already known, caching every outcome.

    Free API tiers rate limit quickly, so a 429 stops the run and reports what
    was already resolved rather than discarding it. Names resolved before the
    limit are cached, so pressing the button again picks up where it left off.
    """
    if not api_key:
        raise LookupError("No API key set. Add one in Settings to look up names.")

    known = store.get_player_names(conn, account_ids)
    pending = [i for i in account_ids if i and i not in known][:limit]

    resolved = misses = 0
    failures: list[dict] = []
    rate_limited = False
    attempted = 0

    for index, account_id in enumerate(pending):
        if index:
            time.sleep(DELAY_SECONDS)
        try:
            name, status = resolve_one(account_id, api_key)
        except LookupError as exc:
            if "Rate limited" in str(exc):
                # One backoff, then give up for this run and keep the progress.
                time.sleep(BACKOFF_SECONDS)
                try:
                    name, status = resolve_one(account_id, api_key)
                except LookupError:
                    rate_limited = True
                    break
            else:
                if resolved:
                    break  # keep what we have; the caller reports the partial run
                raise
        attempted += 1
        if name:
            store.set_lookup_name(conn, account_id, name)
            resolved += 1
        else:
            store.record_lookup_miss(conn, account_id)
            misses += 1
            if len(failures) < 5:
                failures.append({"player_id": account_id, "reason": status})

    return {
        "requested": len(account_ids),
        "already_known": len(known),
        "attempted": attempted,
        "resolved": resolved,
        "unresolved": misses,
        "remaining": max(0, len(account_ids) - len(known) - attempted),
        "rate_limited": rate_limited,
        "examples": failures,
    }


def test_key(api_key: str, sample_account_id: str | None) -> dict:
    """One call, so the key can be verified from Settings before a bulk run."""
    if not api_key:
        return {"ok": False, "message": "Enter an API key first."}
    if not sample_account_id:
        return {"ok": False, "message": "Import at least one replay first."}
    try:
        name, status = resolve_one(sample_account_id, api_key)
    except LookupError as exc:
        return {"ok": False, "message": str(exc)}
    if name:
        return {"ok": True, "message": f"Working. That account resolves to {name}."}
    return {
        "ok": True,
        "message": f"Key accepted, but that account returned no name ({status}).",
    }
