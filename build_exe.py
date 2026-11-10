#!/usr/bin/env python3
"""Build FortReplays.exe: a single self-contained Windows executable.

    python -m pip install pyinstaller
    python build_exe.py

The result lands in dist/FortReplays.exe and needs no Python installed to run.
The web frontend (HTML/CSS/JS and the bundled font) is packed inside it.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
NAME = "FortReplays"


def main() -> int:
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("PyInstaller is not installed. Run:  python -m pip install pyinstaller")
        return 1

    # PyInstaller wants os.pathsep between source and destination.
    web_spec = f"{os.path.join(ROOT, 'web')}{os.pathsep}web"

    command = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--name", NAME,
        "--add-data", web_spec,
        "--hidden-import", "lookup",
        "--hidden-import", "netstream",
        "--hidden-import", "replay.aes",
        "--hidden-import", "replay.archive",
        "--hidden-import", "replay.parser",
        "--noconfirm",
        "--clean",
        "--distpath", os.path.join(ROOT, "dist"),
        "--workpath", os.path.join(ROOT, "build"),
        "--specpath", os.path.join(ROOT, "build"),
        os.path.join(ROOT, "fortreplays.py"),
    ]

    print("Building. This takes a minute or two...\n")
    result = subprocess.run(command, cwd=ROOT)
    if result.returncode != 0:
        return result.returncode

    exe = os.path.join(ROOT, "dist", f"{NAME}.exe")
    if not os.path.exists(exe):
        print("Build reported success but the exe is missing.")
        return 1

    # The network-stream helper sits beside the exe rather than inside it, so
    # startup does not have to unpack another 37 MB every launch.
    helper = os.path.join(ROOT, "tools", "FortReplayExtract.exe")
    if os.path.exists(helper):
        target = os.path.join(ROOT, "dist", "tools")
        os.makedirs(target, exist_ok=True)
        shutil.copy2(helper, os.path.join(target, "FortReplayExtract.exe"))
        print("Copied the team and name helper into dist/tools.")
    else:
        print("WARNING: tools/FortReplayExtract.exe missing, so teams and names")
        print("         will fall back to guessing. Build it with:")
        print("         dotnet publish extractor -c Release -r win-x64 --self-contained "
              "-p:PublishSingleFile=true -o tools")

    size_mb = os.path.getsize(exe) / (1024 * 1024)
    print(f"\nBuilt {exe} ({size_mb:.1f} MB)")

    # The build tree is large and disposable.
    shutil.rmtree(os.path.join(ROOT, "build"), ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
