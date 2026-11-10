#!/usr/bin/env python3
"""Assemble FortReplays.html: one self-contained file you can just open.

    python build_html.py

Inlines the stylesheet, the font as a data URI, and the three scripts, so the
result works from a file:// page with no server, no install and no internet.
"""

from __future__ import annotations

import base64
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
# docs/ is what GitHub Pages serves. FortReplays.html is the same page for
# people who want to keep a copy and double-click it offline.
OUTPUTS = [os.path.join(ROOT, "docs", "index.html"), os.path.join(ROOT, "FortReplays.html")]
SITE_URL = "https://fwsoapy.github.io/fortreplays/"

SCRIPTS = ["standalone/replay.js", "standalone/app.js", "standalone/ui.js"]
STYLES = ["web/styles.css", "standalone/site.css"]

ICON = (
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E"
    "%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%232a78d6'/%3E"
    "%3Cstop offset='1' stop-color='%237b5cff'/%3E%3C/linearGradient%3E%3C/defs%3E"
    "%3Crect width='64' height='64' rx='14' fill='url(%23g)'/%3E"
    "%3Cpath d='M18 46V18h22v7H26v5h12v7H26v9z' fill='%23fff'/%3E%3Ccircle cx='45' cy='42' r='5' fill='%23fff'/%3E%3C/svg%3E"
)

NAV_ICONS = {
    "overview": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    "matches": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    "import": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>',
    "settings": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
}


def nav(route: str, label: str, extra: str = "") -> str:
    return (
        f'<button class="nav-item" data-route="{route}"><span class="nav-label">'
        f"{NAV_ICONS[route]}{label}</span>{extra}</button>"
    )


DESCRIPTION = (
    "Free Fortnite replay stats in your browser. Drop in your .replay files to see damage, "
    "accuracy, placements, kill feeds and trends. Nothing is uploaded."
)

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FortReplays: Fortnite replay stats</title>
<meta name="description" content="__DESC__">
<meta name="theme-color" content="#2a78d6">
<meta property="og:type" content="website">
<meta property="og:title" content="FortReplays: Fortnite replay stats">
<meta property="og:description" content="__DESC__">
<meta property="og:url" content="__URL__">
<meta property="og:image" content="__URL__og.png">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="640">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="FortReplays: Fortnite replay stats">
<meta name="twitter:description" content="__DESC__">
<meta name="twitter:image" content="__URL__og.png">
<link rel="icon" href="__ICON__">
<script>
  // Applied before first paint so the page never flashes the wrong theme.
  (function () {
    try {
      var saved = localStorage.getItem("fr.theme");
      if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
    } catch (e) {}
  })();
</script>
<style>
__STYLES__
</style>
</head>
<body>
  <div class="app">
    <nav class="sidebar" aria-label="Main">
      <div class="brand"><span class="brand-mark">FR</span><strong>FortReplays</strong></div>
      __NAV__
      <div class="sidebar-foot">
        <div class="segmented" role="group" aria-label="Theme">
          <button data-theme-set="light">Light</button>
          <button data-theme-set="dark">Dark</button>
          <button data-theme-set="system">Auto</button>
        </div>
        <p class="privacy">Runs entirely in your browser. Your replays never leave your PC.
          <a href="https://github.com/fwsoapy/fortreplays" target="_blank" rel="noopener">Source on GitHub</a></p>
      </div>
    </nav>
    <main class="main" id="view"><div class="empty"><span class="spinner"></span></div></main>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>
__SCRIPTS__
</script>
</body>
</html>
"""


def main() -> int:
    font_path = os.path.join(ROOT, "web", "fonts", "inter-latin.woff2")
    sources = [os.path.join(ROOT, name) for name in STYLES + SCRIPTS] + [font_path]
    for path in sources:
        if not os.path.exists(path):
            print(f"Missing {path}")
            return 1

    styles = ""
    for name in STYLES:
        with open(os.path.join(ROOT, name), encoding="utf-8") as handle:
            styles += handle.read() + "\n"

    with open(font_path, "rb") as handle:
        font_b64 = base64.b64encode(handle.read()).decode("ascii")

    # Point the existing @font-face at the embedded copy instead of a URL.
    styles, count = re.subn(
        r'src:\s*url\("/fonts/inter-latin\.woff2"\)\s*format\("woff2"\);',
        f'src: url("data:font/woff2;base64,{font_b64}") format("woff2");',
        styles,
    )
    if count != 1:
        print("Could not find the @font-face rule to inline.")
        return 1

    parts = []
    for name in SCRIPTS:
        with open(os.path.join(ROOT, name), encoding="utf-8") as handle:
            parts.append(f"/* ===== {name} ===== */\n{handle.read()}")

    navigation = "\n      ".join(
        [
            nav("overview", "Overview"),
            nav("matches", "Matches", '<span class="count" id="nav-match-count"></span>'),
            nav("import", "Add replays"),
            nav("settings", "Settings"),
        ]
    )
    page = (
        PAGE.replace("__DESC__", DESCRIPTION)
        .replace("__URL__", SITE_URL)
        .replace("__ICON__", ICON)
        .replace("__NAV__", navigation)
        .replace("__STYLES__", styles)
        .replace("__SCRIPTS__", "\n\n".join(parts))
    )
    for output in OUTPUTS:
        os.makedirs(os.path.dirname(output), exist_ok=True)
        with open(output, "w", encoding="utf-8") as handle:
            handle.write(page)
        print(f"Built {os.path.relpath(output, ROOT)} ({os.path.getsize(output) / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
