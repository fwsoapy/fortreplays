"""Local HTTP server: JSON API plus the static frontend.

Everything runs on the machine that has the replays. Nothing is uploaded
anywhere and the server binds to localhost only.
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
import tempfile
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

import lookup
import netstream
import store
from replay.parser import ReplayError, parse_replay, parse_replay_bytes


def _web_dir() -> str:
    """Frontend location: bundled inside the exe when frozen by PyInstaller."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "web")


WEB_DIR = _web_dir()
MAX_UPLOAD_BYTES = 256 * 1024 * 1024


class Api:
    """Request handling that has nothing to do with HTTP plumbing."""

    def __init__(self, conn):
        self.conn = conn

    # -- helpers ----------------------------------------------------------


    def account_id(self) -> str | None:
        return store.ensure_account_id(self.conn)

    # -- endpoints --------------------------------------------------------

    def matches(self):
        # Repairs libraries where a teammate's replay landed as a separate match
        # under the old matching. Merging needs to know who recorded each one,
        # so fill in any that predate that being stored, a few at a time.
        self._backfill_recorders(limit=3)
        store.merge_duplicate_matches(self.conn, self.account_id())
        return {
            "matches": store.list_matches(self.conn, {"stats_only": False}),
            "library": store.library_stats(self.conn),
            "account_id": self.account_id(),
        }

    def match(self, replay_id):
        result = store.get_match(self.conn, replay_id, self.account_id())
        if not result:
            raise KeyError(replay_id)
        return result

    def settings(self):
        detected, meta = store.detect_account_id(self.conn)
        return {
            "demos_dir": store.get_demos_dir(self.conn),
            "demos_dir_default": store.DEFAULT_DEMOS_DIR,
            "account_id": store.get_setting(self.conn, "account_id"),
            "detected_account_id": detected,
            "detection": meta,
            "library": store.library_stats(self.conn),
            "modes": store.modes(self.conn),
            "weapons": store.weapon_catalog(self.conn, self.account_id()),
            "aes_backend": __import__("replay.aes", fromlist=["BACKEND_NAME"]).BACKEND_NAME,
            # Only whether a key is present, never the key itself.
            "has_lookup_key": bool(store.get_setting(self.conn, "lookup_api_key")),
            "names": store.name_stats(self.conn),
        }

    def save_settings(self, body: dict):
        if "lookup_api_key" in body:
            store.set_setting(
                self.conn, "lookup_api_key", (body["lookup_api_key"] or "").strip() or None
            )
        if "demos_dir" in body:
            store.set_setting(self.conn, "demos_dir", (body["demos_dir"] or "").strip() or None)
        if "account_id" in body:
            value = (body["account_id"] or "").strip()
            store.set_setting(self.conn, "account_id", value or None)
            # Remember that this was chosen by hand, so importing more replays
            # never silently replaces it with a detected value.
            store.set_setting(self.conn, "account_id_manual", "1" if value else None)
        return self.settings()

    def set_teammate(self, body: dict):
        player_id = (body.get("player_id") or "").strip()
        if not player_id:
            return {"error": "player_id is required"}
        store.set_teammate(self.conn, player_id, bool(body.get("is_teammate")))
        return {"player_id": player_id, "is_teammate": bool(body.get("is_teammate"))}

    def rename_player(self, body: dict):
        player_id = (body.get("player_id") or "").strip()
        if not player_id:
            return {"error": "player_id is required"}
        store.set_player_name(self.conn, player_id, body.get("name"))
        return {"player_id": player_id, "name": (body.get("name") or "").strip() or None}

    def lookup_names(self, body: dict):
        """Resolve account ids to display names. Requires a key; never automatic."""
        api_key = store.get_setting(self.conn, "lookup_api_key") or ""
        replay_id = body.get("replay_id")
        ids = body.get("player_ids") or store.unresolved_player_ids(self.conn, replay_id)
        try:
            result = lookup.resolve_many(self.conn, ids, api_key)
        except lookup.LookupError as exc:
            return {"error": str(exc)}
        result["names"] = store.get_player_names(self.conn, ids)
        return result

    def test_lookup_key(self, body: dict):
        api_key = (body.get("api_key") or store.get_setting(self.conn, "lookup_api_key") or "").strip()
        sample = self.account_id() or next(iter(store.unresolved_player_ids(self.conn)), None)
        return lookup.test_key(api_key, sample)

    def save_weapon_labels(self, body: dict):
        store.set_weapon_labels(self.conn, body.get("labels") or {})
        return {"weapons": store.weapon_catalog(self.conn, self.account_id())}

    def clear_library(self):
        return {"cleared": store.clear_library(self.conn)}

    def backfill(self):
        return store.backfill_metadata(self.conn, parse_replay)

    def _read_netstream(self, replay_id: str, replay_path: str) -> int:
        """Pull exact teams, real names and the recording player, if we can."""
        if not replay_path or not netstream.available():
            return 0
        result = netstream.read(replay_path)
        if not result.get("ok"):
            return 0
        store.set_recorder(self.conn, replay_id, result.get("recorderId"))
        return store.save_roster(self.conn, replay_id, result.get("players") or [])

    def _backfill_recorders(self, limit: int = 3) -> int:
        """Fill in the recording player for matches imported before it was stored."""
        if not netstream.available():
            return 0
        rows = self.conn.execute(
            "SELECT replay_id, file_path FROM matches"
            " WHERE recorder_id IS NULL AND file_path IS NOT NULL LIMIT ?",
            (limit,),
        ).fetchall()
        done = 0
        for row in rows:
            if not os.path.isfile(row["file_path"]):
                # Nothing to read, so mark it as attempted rather than retrying
                # this row on every page load.
                store.set_recorder(self.conn, row["replay_id"], "unknown")
                continue
            result = netstream.read(row["file_path"])
            store.set_recorder(
                self.conn, row["replay_id"], result.get("recorderId") or "unknown"
            )
            done += 1
        return done

    def _recorder_of(self, data: bytes) -> str | None:
        """Which account recorded this replay, from the network stream.

        This is what tells a teammate's file apart from your own.
        """
        if not netstream.available():
            return None
        handle, temp_path = tempfile.mkstemp(suffix=".replay")
        try:
            with os.fdopen(handle, "wb") as out:
                out.write(data)
            result = netstream.read(temp_path)
            return (result.get("recorderId") or "").lower() or None
        finally:
            try:
                os.remove(temp_path)
            except OSError:
                pass

    def _retain(self, replay_id: str, data: bytes) -> str | None:
        """Keep an uploaded replay alongside the library.

        Fortnite deletes its own copies as you keep playing, and holding on to
        the file means a match never has to be re-imported.
        """
        folder = os.path.join(store.APP_DIR, "replays")
        try:
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, f"{replay_id}.replay")
            if not os.path.exists(path):
                with open(path, "wb") as handle:
                    handle.write(data)
            return path
        except OSError:
            return None

    def _read_netstream_from_bytes(self, replay_id: str, data: bytes) -> int:
        if not netstream.available():
            return 0
        handle, temp_path = tempfile.mkstemp(suffix=".replay")
        try:
            with os.fdopen(handle, "wb") as out:
                out.write(data)
            return self._read_netstream(replay_id, temp_path)
        finally:
            try:
                os.remove(temp_path)
            except OSError:
                pass

    def _redetect_account(self) -> None:
        if store.get_setting(self.conn, "account_id_manual"):
            return
        store.set_setting(self.conn, "account_id", None)
        store.ensure_account_id(self.conn)

    def scan(self, body: dict):
        """Import every replay in the demos folder that isn't already stored."""
        directory = (body.get("directory") or store.get_demos_dir(self.conn)).strip()
        if not os.path.isdir(directory):
            return {"error": f"Folder not found: {directory}"}

        known_paths = {
            (row["file_path"], row["file_size"])
            for row in self.conn.execute("SELECT file_path, file_size FROM matches")
        }
        known_ids = store.known_replay_ids(self.conn)

        added = duplicate = failed = skipped = 0
        no_stats: list[str] = []
        errors: list[dict] = []
        started = time.time()

        for name in sorted(os.listdir(directory)):
            if not name.lower().endswith(".replay"):
                continue
            path = os.path.join(directory, name)
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            if (path, size) in known_paths:
                skipped += 1
                continue

            try:
                replay = parse_replay(path)
            except (ReplayError, OSError, ValueError) as exc:
                failed += 1
                errors.append({"file": name, "error": str(exc)})
                continue

            if replay.replay_id in known_ids:
                duplicate += 1
                continue
            if store.import_replay(self.conn, replay) == "added":
                added += 1
                known_ids.add(replay.replay_id)
                self._read_netstream(replay.replay_id, path)
                if not replay.has_stats:
                    no_stats.append(name)
            else:
                duplicate += 1

        if added:
            self._redetect_account()

        return {
            "directory": directory,
            "added": added,
            "duplicate": duplicate,
            "already_imported": skipped,
            "failed": failed,
            "no_stats": no_stats,
            "errors": errors[:20],
            "seconds": round(time.time() - started, 2),
        }

    def upload(self, filename: str, data: bytes):
        try:
            replay = parse_replay_bytes(data, filename)
        except (ReplayError, ValueError) as exc:
            return {"status": "failed", "file": filename, "error": str(exc)}

        # A teammate's replay of a match already in the library is not a new
        # match. It is that match seen from their seat, and its stats block is
        # theirs, which is the one exact way to get their damage.
        existing_id, similarity = store.match_similarity(self.conn, replay)
        if similarity < 0.6:
            existing_id = None
            owner = self._recorder_of(data) or ""
            if not owner:
                return {
                    "status": "failed",
                    "file": filename,
                    "error": "This looks like the same match, but the recording player could "
                    "not be identified, so its stats could not be attributed.",
                }
            if owner == (self.account_id() or "").lower():
                return {"status": "duplicate", "file": filename, "replay_id": existing_id}

            store.add_contribution(self.conn, existing_id, owner, replay, replay.replay_id)
            names = store.get_player_names(self.conn, [owner])
            return {
                "status": "teammate",
                "file": filename,
                "replay_id": existing_id,
                "owner_id": owner,
                "owner_name": names.get(owner),
                "has_stats": replay.has_stats,
            }

        result = store.import_replay(self.conn, replay)
        roster = 0
        if result == "added":
            # Uploads are kept, both so Fortnite deleting its own copy does not
            # matter and so squad damage can be fetched later without asking
            # for the file again.
            stored = self._retain(replay.replay_id, data)
            if stored:
                self.conn.execute(
                    "UPDATE matches SET file_path = ? WHERE replay_id = ?",
                    (stored, replay.replay_id),
                )
                self.conn.commit()
                roster = self._read_netstream(replay.replay_id, stored)
            else:
                roster = self._read_netstream_from_bytes(replay.replay_id, data)
            self._redetect_account()
            # Anything imported earlier that turns out to be the same game gets
            # folded in now, including replays added before the merge existed.
            store.merge_duplicate_matches(self.conn, self.account_id())
        return {
            "roster": roster,
            # So a failure to merge can be diagnosed instead of guessed at.
            "similarity": round(similarity, 3),
            "shared_eliminations": len(store.fingerprint_of(replay)),
            "status": result,
            "file": filename,
            "replay_id": replay.replay_id,
            "has_stats": replay.has_stats,
            "eliminations": len(replay.eliminations),
        }

    def delete(self, replay_id):
        return {"deleted": store.delete_match(self.conn, replay_id)}



class Handler(BaseHTTPRequestHandler):
    server_version = "FortReplays"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter console
        pass

    # -- responses --------------------------------------------------------

    def _send(self, status, body: bytes, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data, status=200):
        self._send(status, json.dumps(data, default=str).encode("utf-8"))

    def _static(self, rel_path: str):
        rel_path = rel_path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(WEB_DIR, rel_path))
        if not full.startswith(WEB_DIR) or not os.path.isfile(full):
            return self._send(404, b"Not found", "text/plain")
        content_type = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type == "application/javascript":
            content_type += "; charset=utf-8"
        with open(full, "rb") as handle:
            self._send(200, handle.read(), content_type)

    # -- routing ----------------------------------------------------------

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        api = self.server.api
        try:
            if path == "/api/matches":
                return self._json(api.matches())
            if path.startswith("/api/match/"):
                return self._json(api.match(unquote(path[len("/api/match/"):])))
            if path == "/api/settings":
                return self._json(api.settings())
            if path.startswith("/api/"):
                return self._json({"error": "unknown endpoint"}, 404)
            return self._static(path)
        except KeyError:
            self._json({"error": "not found"}, 404)
        except Exception as exc:  # surface real errors to the UI
            traceback.print_exc()
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        api = self.server.api
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD_BYTES:
            return self._json({"error": "file too large"}, 413)
        raw = self.rfile.read(length) if length else b""

        try:
            if path == "/api/upload":
                filename = unquote(self.headers.get("X-File-Name", "upload.replay"))
                return self._json(api.upload(os.path.basename(filename), raw))

            body = json.loads(raw or b"{}")
            if path == "/api/scan":
                return self._json(api.scan(body))
            if path == "/api/settings":
                return self._json(api.save_settings(body))
            if path == "/api/weapons":
                return self._json(api.save_weapon_labels(body))
            if path == "/api/players/name":
                return self._json(api.rename_player(body))
            if path == "/api/players/teammate":
                return self._json(api.set_teammate(body))
            if path == "/api/players/lookup":
                return self._json(api.lookup_names(body))
            if path == "/api/players/test-key":
                return self._json(api.test_lookup_key(body))
            if path == "/api/clear":
                return self._json(api.clear_library())
            if path == "/api/backfill":
                return self._json(api.backfill())
            return self._json({"error": "unknown endpoint"}, 404)
        except json.JSONDecodeError:
            self._json({"error": "invalid JSON body"}, 400)
        except Exception as exc:
            traceback.print_exc()
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def do_DELETE(self):
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/match/"):
                return self._json(self.server.api.delete(unquote(path[len("/api/match/"):])))
            self._json({"error": "unknown endpoint"}, 404)
        except Exception as exc:
            traceback.print_exc()
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)


def create_server(host: str, port: int, conn) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.api = Api(conn)
    return httpd
