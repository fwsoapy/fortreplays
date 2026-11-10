"""Reads the parts of a replay that only the network stream contains.

The event chunks this app parses in Python give match stats and the killfeed,
but they do not say which team anyone was on, and they identify players by
account id rather than name. Both of those live in the network stream, which is
Oodle compressed and encoded as Unreal replication data.

Rather than reimplement that, a small helper executable built on the maintained
FortniteReplayReader library is shipped alongside, and invoked per replay. It
prints one JSON object and exits.

If the helper is missing or fails, everything else still works: teams fall back
to the killfeed heuristic and names fall back to the optional online lookup.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

EXE_NAME = "FortReplayExtract.exe"
TIMEOUT_SECONDS = 120


def _search_roots() -> list[str]:
    """Where the helper might live, frozen or running from source."""
    roots = []
    if getattr(sys, "frozen", False):
        roots.append(os.path.dirname(sys.executable))
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            roots.append(meipass)
    here = os.path.dirname(os.path.abspath(__file__))
    roots.extend([here, os.path.join(here, "tools"), os.path.join(here, "..", "tools")])
    return roots


def extractor_path() -> str | None:
    for root in _search_roots():
        candidate = os.path.join(root, EXE_NAME)
        if os.path.isfile(candidate):
            return candidate
        candidate = os.path.join(root, "tools", EXE_NAME)
        if os.path.isfile(candidate):
            return candidate
    return None


def available() -> bool:
    return extractor_path() is not None


def read(replay_path: str) -> dict:
    """Return {'ok': bool, 'players': [...], 'error': str}."""
    exe = extractor_path()
    if not exe:
        return {"ok": False, "error": "helper not found", "players": []}
    if not os.path.isfile(replay_path):
        return {"ok": False, "error": "replay file not on disk", "players": []}

    try:
        completed = subprocess.run(
            [exe, replay_path],
            capture_output=True,
            timeout=TIMEOUT_SECONDS,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "helper timed out", "players": []}
    except OSError as exc:
        return {"ok": False, "error": str(exc), "players": []}

    text = completed.stdout.decode("utf-8", "replace").strip()
    if not text:
        return {"ok": False, "error": "helper returned nothing", "players": []}
    try:
        payload = json.loads(text.splitlines()[-1])
    except json.JSONDecodeError:
        return {"ok": False, "error": "helper output was not readable", "players": []}

    payload.setdefault("players", [])
    payload.setdefault("ok", False)
    return payload
