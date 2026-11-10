#!/usr/bin/env python3
"""FortReplays: local Fortnite replay stats.

Usage:
    python fortreplays.py                 start the app and open a browser
    python fortreplays.py --scan          import from the demos folder, then start
    python fortreplays.py --no-browser    start without opening a browser
    python fortreplays.py --port 8123     use a different port
"""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser

import store
from replay import aes
from server import create_server

DEFAULT_PORT = 8420


def run_scan(conn) -> None:
    from server import Api

    directory = store.get_demos_dir(conn)
    print(f"Scanning {directory} ...")
    result = Api(conn).scan({})
    if result.get("error"):
        print(f"  {result['error']}")
        return
    print(
        f"  added {result['added']}, already imported "
        f"{result['already_imported'] + result['duplicate']}, "
        f"failed {result['failed']} ({result['seconds']}s)"
    )
    if result["no_stats"]:
        print(f"  {len(result['no_stats'])} replay(s) had no match-stats block")


def main() -> int:
    parser = argparse.ArgumentParser(description="Local Fortnite replay stats")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--scan", action="store_true", help="import new replays on startup")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    aes.self_test()

    conn = store.connect()
    library = store.library_stats(conn)
    # flush=True so the console shows progress immediately when frozen into an exe.
    print(f"FortReplays: library at {store.DB_PATH}", flush=True)
    print(f"  {library['total'] or 0} match(es) stored, AES backend: {aes.BACKEND_NAME}", flush=True)

    if args.scan:
        run_scan(conn)

    try:
        httpd = create_server(args.host, args.port, conn)
    except OSError as exc:
        print(f"Could not bind {args.host}:{args.port} ({exc})")
        print("Another copy may already be running. Try --port 8421.")
        return 1

    url = f"http://{args.host}:{args.port}/"
    print(f"  serving {url}  (close this window or press Ctrl+C to stop)", flush=True)
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
