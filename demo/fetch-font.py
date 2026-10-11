#!/usr/bin/env python3
"""Fixture subset font for the label/font browser checks (TEXT-02/03/05).

Downloads a small Roboto subset (Apache License 2.0, Copyright 2011 Google
Inc.) from the Google Fonts CSS API containing exactly the glyphs the checks
use plus the combining acute accent (U+0301). The subset keeps the fixture
small and its glyph set known.

    python3 demo/fetch-font.py            # writes demo/fonts/maplet-subset.woff2
    python3 demo/fetch-font.py --force    # re-downloads

Attribution and license notes live in `demo/fonts/NOTICE.txt`.
"""
from __future__ import annotations

import argparse
import pathlib
import re
import urllib.parse
import urllib.request

TEXT = "Maplet fonts test Příliš žluťoučký kůň 0123456789"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120 Safari/537.36"
)
OUT = pathlib.Path(__file__).parent / "fonts" / "maplet-subset.woff2"


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="re-download even if present")
    args = parser.parse_args()

    if OUT.exists() and not args.force:
        print(f"{OUT} already exists ({OUT.stat().st_size} bytes); use --force to refresh")
        return

    css_url = (
        "https://fonts.googleapis.com/css2?family=Roboto:wght@400&text="
        + urllib.parse.quote(TEXT)
    )
    css = fetch(css_url).decode("utf-8")
    match = re.search(r"url\((https://[^)]+)\)", css)
    if not match:
        raise SystemExit(f"no font URL found in the CSS response from {css_url}")
    data = fetch(match.group(1))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(data)
    print(f"wrote {OUT} ({len(data)} bytes) for text: {TEXT!r}")


if __name__ == "__main__":
    main()
