#!/usr/bin/env python3
"""Static development server for the demos plus a deterministic WMS endpoint.

Serves the repository root on port 8400 like `python -m http.server`, but sends
`Cache-Control: no-store` for HTML/JS/CSS/JSON. Chromium otherwise heuristically
caches module files without revalidating (plain http.server sends no cache
headers), so `npm run build` followed by a reload could keep running stale
modules.

`/wms` answers GetMap requests with an image that encodes the *interpreted*
geography, using an independent Python implementation of the WMS semantics
(version/CRS axis order, BBOX units, spherical Mercator):

- red follows longitude across the interpreted BBOX, green follows latitude;
- blue carries the request identity: +32 for version 1.3.0, +64 for a projected
  CRS (EPSG:3857), +16 for CRS:84, 255 for `layers` containing `alt`;
- `MARK=lng,lat` paints a magenta square at that position.

`demo/wms.html` samples GPU pixels against the same expectations, so a wrong
BBOX (swapped axes, linear-degree "metres") shows up as shifted colour or a
missing marker. The generic `?delay=<ms>` hook applies here too (WMS-05).
"""
from __future__ import annotations

import functools
import http.server
import math
import os
import struct
import time
import urllib.parse
import zlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
NO_STORE = (".html", ".js", ".css", ".json", ".woff2")
WMS_PATH = "/wms"
# Sent on every response so the e2e runner can detect a stale server process
# (e.g. started before this file gained the `/wms` route or the `?csp=` hook)
# and say so instead of failing batteries confusingly. Bump when the server
# contract changes.
SERVER_MARKER = "wms-fixture-2"

EARTH_RADIUS = 6378137.0
MAX_MERCATOR_LATITUDE = 85.0511287798
MARKER_RADIUS = 8


def _png(width: int, height: int, rows: bytes) -> bytes:
    def chunk(tag: bytes, payload: bytes) -> bytes:
        data = tag + payload
        return struct.pack(">I", len(payload)) + data + struct.pack(">I", zlib.crc32(data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows, 6))
        + chunk(b"IEND", b"")
    )


def _mercator_y(lat: float) -> float:
    phi = math.radians(max(min(lat, MAX_MERCATOR_LATITUDE), -MAX_MERCATOR_LATITUDE))
    return EARTH_RADIUS * math.log(math.tan(math.pi / 4 + phi / 2))


def _inverse_mercator_lat(y: float) -> float:
    return math.degrees(math.atan(math.sinh(y / EARTH_RADIUS)))


def _wms_image(query: str) -> bytes | None:
    """Renders a GetMap image; None means the request is not a GetMap call."""
    params: dict[str, str] = {}
    for part in query.split("&"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        params[urllib.parse.unquote_plus(key).lower()] = urllib.parse.unquote_plus(value)
    if params.get("request", "").lower() != "getmap":
        return None
    try:
        width = max(1, min(2048, int(params["width"])))
        height = max(1, min(2048, int(params["height"])))
        bbox = [float(value) for value in params["bbox"].split(",")]
    except (KeyError, ValueError):
        return None
    if len(bbox) != 4:
        return None
    version = params.get("version", "1.3.0")
    crs = (params.get("crs") or params.get("srs") or "EPSG:4326").upper()
    projected = crs in ("EPSG:3857", "EPSG:900913")
    if projected:
        min_lng = math.degrees(bbox[0] / EARTH_RADIUS)
        max_lng = math.degrees(bbox[2] / EARTH_RADIUS)
        south_y, north_y = bbox[1], bbox[3]
        min_lat = _inverse_mercator_lat(south_y)
        max_lat = _inverse_mercator_lat(north_y)
    elif version == "1.3.0" and crs in ("EPSG:4326", "EPSG:32663"):
        min_lat, min_lng, max_lat, max_lng = bbox
        south_y, north_y = min_lat, max_lat
    else:
        min_lng, min_lat, max_lng, max_lat = bbox
        south_y, north_y = min_lat, max_lat
    if not (min_lng < max_lng and min_lat < max_lat):
        return None
    span_lng = max_lng - min_lng
    span_lat = max_lat - min_lat
    blue = 255 if "alt" in params.get("layers", "").lower() else 0
    blue += 32 if version == "1.3.0" else 0
    blue += 64 if projected else 0
    blue += 16 if crs == "CRS:84" else 0
    blue = min(255, blue)

    reds = bytes(min(255, round(255 * (col + 0.5) / width)) for col in range(width))
    rows = bytearray()
    for row in range(height):
        if projected:
            y = north_y - (row + 0.5) / height * (north_y - south_y)
            lat = _inverse_mercator_lat(y)
        else:
            lat = max_lat - (row + 0.5) / height * span_lat
        green = min(255, max(0, round(255 * (lat - min_lat) / span_lat)))
        row_bytes = bytearray(width * 3)
        row_bytes[0::3] = reds
        row_bytes[1::3] = bytes([green]) * width
        row_bytes[2::3] = bytes([blue]) * width
        rows += b"\x00" + row_bytes

    if "mark" in params:
        try:
            mark_lng, mark_lat = (float(value) for value in params["mark"].split(","))
            col = min(width - 1, max(0, int((mark_lng - min_lng) / span_lng * width)))
            if projected:
                row = min(height - 1, max(0, int((north_y - _mercator_y(mark_lat)) / (north_y - south_y) * height)))
            else:
                row = min(height - 1, max(0, int((max_lat - mark_lat) / span_lat * height)))
            col0, col1 = max(0, col - MARKER_RADIUS), min(width, col + MARKER_RADIUS + 1)
            magenta = bytes((255, 0, 255)) * (col1 - col0)
            for marker_row in range(max(0, row - MARKER_RADIUS), min(height, row + MARKER_RADIUS + 1)):
                start = marker_row * (width * 3 + 1) + 1 + col0 * 3
                rows[start : start + len(magenta)] = magenta
        except ValueError:
            pass
    return _png(width, height, bytes(rows))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        path = self.path.split("?", 1)[0]
        if path.endswith(NO_STORE) or path == WMS_PATH:
            self.send_header("Cache-Control", "no-store")
        if "csp=worker-none" in self.path.partition("?")[2]:
            # Blocks the import module worker for the CSP fallback battery. The
            # worker is same-origin, so `worker-src` is the deciding directive;
            # a bundler that does not rewrite `new URL(..., import.meta.url)`
            # leaves the page in the same state.
            self.send_header("Content-Security-Policy", "worker-src 'none'")
        self.send_header("X-Maplet-Serve", SERVER_MARKER)
        super().end_headers()

    def do_GET(self) -> None:
        # `?delay=<ms>` exists for the font-loading checks (TEXT-05) and the WMS
        # stale-response check (WMS-05): a delayed response lets the browser test
        # the "keep the previous bitmap, then swap" contract deterministically.
        path, _, query = self.path.partition("?")
        for part in query.split("&"):
            if not part.startswith("delay="):
                continue
            try:
                delay_ms = max(0, min(5000, int(part[len("delay=") :] or "0")))
            except ValueError:
                delay_ms = 0
            if delay_ms:
                time.sleep(delay_ms / 1000)
            break
        if path.rstrip("/") == WMS_PATH:
            self._serve_wms(query)
            return
        super().do_GET()

    def _serve_wms(self, query: str) -> None:
        image = _wms_image(query)
        if image is None:
            body = b"not a WMS GetMap request: expected SERVICE=WMS&REQUEST=GetMap&BBOX=&WIDTH=&HEIGHT="
            self.send_response(400)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(image)))
        self.end_headers()
        self.wfile.write(image)


def main() -> None:
    handler = functools.partial(Handler, directory=ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 8400), handler)
    print(f"serving {ROOT} at http://localhost:8400/ (demo: /demo/)")
    server.serve_forever()


if __name__ == "__main__":
    main()
