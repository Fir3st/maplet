#!/usr/bin/env python3
"""One-time development cache of real raster tiles from public providers.

The Maplet browser checks must run against real bitmaps (PNG and JPEG) without
hitting public tile servers on every run. This script downloads a small, curated
set (whole world up to z2, the Prague region at z3-z8; see `coords()`) into
`demo/tiles-providers/<id>/` and writes a manifest with the exact URLs, sizes and
SHA-256 hashes.

Usage policy: this is a single, small, resumable fetch for local development and
testing - not a bulk download and not a tile proxy. Attribution for every
provider is recorded in the manifest and must be shown when the tiles are
displayed (see `demo/index.html`). Re-running is idempotent (existing valid
files are skipped), and requests are sequential with a delay.

Deliberately not cached here, but available as live URLs in the demo (exactly
like Leaflet's quick start does it - the browser requests those tiles directly):
  - tile.openstreetmap.org: the OSM operations team blocks scripted fetching of
    the standard layer and answers with an "Access blocked" tile at HTTP 200
    (the duplicate-payload check below detects that state).
  - basemaps.cartocdn.com: anonymous requests now receive an "API KEY REQUIRED"
    placeholder image.

    python3 demo/fetch-tiles.py                  # all providers
    python3 demo/fetch-tiles.py --dry-run        # print plan only
    python3 demo/fetch-tiles.py --providers osm,esri-imagery
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone

ROOT = os.path.join(os.path.dirname(__file__), "tiles-providers")
ANCHOR = {"lat": 50.08, "lng": 14.44}  # Prague, the demo's initial view
USER_AGENT = (
    "maplet-local-test/0.1.0-alpha.1 (one-time offline tile cache for development checks; "
    "not a service; tiles remain (c) their providers)"
)

PROVIDERS: list[dict[str, object]] = [
    {
        "id": "osm-de",
        "template": "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
        "extension": "png",
        "attribution": "\u00a9 OpenStreetMap contributors, openstreetmap.de style",
        "policy": "https://www.openstreetmap.de/germanstyle.html",
        "note": "German-label variant of the OSM Carto style.",
    },
    {
        "id": "opentopomap",
        "template": "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
        "subdomains": "abc",
        "extension": "png",
        "attribution": "\u00a9 OpenTopoMap (CC-BY-SA)",
        "policy": "https://opentopomap.org/about#faq",
        "note": "Topographic style with hillshading and contours.",
    },
    {
        "id": "esri-imagery",
        "template": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        "extension": "jpg",
        "attribution": "Powered by Esri \u2014 Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        "policy": "https://www.esri.com/en-us/legal/terms/full-master-agreement",
        "note": "Satellite raster, note the {z}/{y}/{x} URL order and JPEG codec.",
    },
]

MAGIC = {"png": b"\x89PNG\r\n\x1a\n", "jpg": b"\xff\xd8\xff"}


def tile_for(lat: float, lng: float, z: int) -> tuple[int, int]:
    n = 2**z
    x = int((lng + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    clamp = lambda v: max(0, min(n - 1, v))  # noqa: E731
    return clamp(x), clamp(y)


def coords() -> list[tuple[int, int, int]]:
    out: set[tuple[int, int, int]] = set()
    for z in range(0, 3):
        for x in range(2**z):
            for y in range(2**z):
                out.add((z, x, y))
    blocks = {3: (1, 1), 4: (1, 1), 5: (1, 1), 6: (1, 1), 7: (2, 1), 8: (2, 1)}
    for z, (dx, dy) in blocks.items():
        ax, ay = tile_for(ANCHOR["lat"], ANCHOR["lng"], z)
        limit = 2**z - 1
        for x in range(ax - dx, ax + dx + 1):
            for y in range(ay - dy, ay + dy + 1):
                out.add((z, max(0, min(limit, x)), max(0, min(limit, y))))
    return sorted(out)


def format_url(provider: dict[str, object], z: int, x: int, y: int) -> str:
    template = str(provider["template"])
    subdomains = str(provider.get("subdomains", ""))
    if subdomains:
        template = template.replace("{s}", subdomains[abs(x + y) % len(subdomains)])
    return (
        template.replace("{z}", str(z))
        .replace("{x}", str(x))
        .replace("{y}", str(y))
    )


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def valid_file(path: str, extension: str) -> bool:
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        return False
    with open(path, "rb") as handle:
        return handle.read(len(MAGIC[extension])) == MAGIC[extension]


def fetch(url: str, delay: float) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "image/*,*/*"})
    last_error: Exception | None = None
    for attempt in range(3):
        time.sleep(delay)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                content_type = response.headers.get("Content-Type", "")
                body = response.read()
                if not content_type.startswith("image/"):
                    raise RuntimeError(f"unexpected content type {content_type!r}")
                return body
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(3.0 * (attempt + 1))
                continue
            raise RuntimeError(f"HTTP {error.code} for {url}") from error
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
            time.sleep(3.0 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}: {last_error}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--providers", default="", help="comma-separated provider ids (default: all)")
    parser.add_argument("--delay", type=float, default=0.4, help="seconds between requests (default 0.4)")
    parser.add_argument("--dry-run", action="store_true", help="print the plan without downloading")
    args = parser.parse_args()

    selected = [p for p in PROVIDERS if not args.providers or p["id"] in args.providers.split(",")]
    if not selected:
        print(f"no provider matches {args.providers!r}; known ids: {', '.join(str(p['id']) for p in PROVIDERS)}")
        return 2

    plan = coords()
    print(f"{len(plan)} tiles per provider x {len(selected)} providers")
    if args.dry_run:
        for provider in selected:
            first = plan[0]
            last = plan[-1]
            print(f"  {provider['id']}: {format_url(provider, *first)} ... {format_url(provider, *last)}")
        return 0

    manifest: dict[str, object] = {
        "generatedBy": "demo/fetch-tiles.py",
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "usage": "One-time small development cache for offline Maplet checks; not for serving traffic. "
        "Tiles remain the property of their providers; attribution is listed per provider.",
        "anchor": ANCHOR,
        "providers": [],
    }
    failures = 0
    for provider in selected:
        pid = str(provider["id"])
        extension = str(provider["extension"])
        directory = os.path.join(ROOT, pid)
        entries: list[dict[str, object]] = []
        for index, (z, x, y) in enumerate(plan, start=1):
            path = os.path.join(directory, str(z), str(x), f"{y}.{extension}")
            url = format_url(provider, z, x, y)
            if valid_file(path, extension):
                status = "cached"
            else:
                try:
                    body = fetch(url, args.delay)
                except RuntimeError as error:
                    print(f"  FAIL {pid} {z}/{x}/{y}: {error}", file=sys.stderr)
                    failures += 1
                    break
                if not body.startswith(MAGIC[extension]):
                    print(f"  FAIL {pid} {z}/{x}/{y}: payload is not {extension}", file=sys.stderr)
                    failures += 1
                    break
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as handle:
                    handle.write(body)
                status = "fetched"
            entries.append(
                {
                    "z": z,
                    "x": x,
                    "y": y,
                    "file": f"{z}/{x}/{y}.{extension}",
                    "url": url,
                    "bytes": os.path.getsize(path),
                    "sha256": sha256(path),
                }
            )
            marker = " " if status == "cached" else "+"
            print(f"  {marker} {pid} {z}/{x}/{y} ({index}/{len(plan)})", flush=True)

        # Block/placeholder pages arrive with HTTP 200 and the same payload for
        # every coordinate; real map tiles do not repeat on this scale.
        counts = Counter(str(entry["sha256"]) for entry in entries)
        top_hash, top_count = counts.most_common(1)[0] if counts else ("", 0)
        if top_count > max(3, len(entries) // 4):
            print(
                f"  FAIL {pid}: {top_count}/{len(entries)} tiles share the payload {top_hash[:12]}\u2026 - "
                "the server most likely served block/placeholder tiles (HTTP 200). "
                f"Delete {os.path.join(ROOT, pid)} and do not cache this provider.",
                file=sys.stderr,
            )
            failures += 1
            continue

        total_bytes = sum(int(entry["bytes"]) for entry in entries)
        manifest["providers"].append(
            {
                "id": pid,
                "template": provider["template"],
                "extension": extension,
                "attribution": provider["attribution"],
                "policy": provider["policy"],
                "note": provider.get("note", ""),
                "tiles": len(entries),
                "bytes": total_bytes,
                "entries": entries,
            }
        )
        print(f"{pid}: {len(entries)} tiles, {total_bytes} bytes")

    os.makedirs(ROOT, exist_ok=True)
    with open(os.path.join(ROOT, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=1)
        handle.write("\n")
    print(f"manifest written to {os.path.join(ROOT, 'manifest.json')}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
