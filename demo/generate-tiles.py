#!/usr/bin/env python3
"""Generates deterministic local test tiles for the Maplet demo.

`tiles/` holds flat-colour PNG tiles: each tile encodes its z/x/y in a solid
colour so screenshot and pixel checks can verify URL construction, TMS flipping
and placement independently of an external tile service.

`tiles-svg/` holds the same coordinate grid as SVG: a per-tile background plus
vector content (crosshair, border, circle, coordinate text). Flat vector shapes
give exactly-known pixels for GPU checks, and the text at the top-left proves
that the tile image is not mirrored vertically or horizontally.

`tiles-svg/checks.json` is the oracle used by `demo/tiles.html`: expected colours
and text boxes for one tile, computed here rather than duplicated in JavaScript.
"""
import json
import os
import struct
import zlib

PNG_ROOT = os.path.join(os.path.dirname(__file__), "tiles")
SVG_ROOT = os.path.join(os.path.dirname(__file__), "tiles-svg")

# The tile the SVG checks sample; every generated grid contains it.
CHECK_TILE = (2, 1, 1)


def png_bytes(width: int, height: int, rgba: tuple[int, int, int, int]) -> bytes:
    def chunk(tag: bytes, payload: bytes) -> bytes:
        data = tag + payload
        return struct.pack(">I", len(payload)) + data + struct.pack(">I", zlib.crc32(data) & 0xFFFFFFFF)

    signature = b"\x89PNG\r\n\x1a\n"
    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    row = b"\x00" + bytes(rgba) * width
    idat = chunk(b"IDAT", zlib.compress(row * height, 9))
    return signature + ihdr + idat + chunk(b"IEND", b"")


def color_for(z: int, x: int, y: int) -> tuple[int, int, int, int]:
    # Distinct, stable colours per tile coordinate.
    return (
        (z * 53 + x * 37 + 17) % 200 + 20,
        (z * 91 + y * 29 + 43) % 200 + 20,
        (x * 61 + y * 83 + 7) % 200 + 20,
        255,
    )


def svg_markup(z: int, x: int, y: int, size: int) -> str:
    """Vector tile: background, crosshair, border, circle, top-left label."""
    r, g, b, _ = color_for(z, x, y)
    k = size / 256.0
    c = size // 2
    cross = round(4 * k)
    border = round(8 * k)
    inset = round(4 * k)
    radius = round(40 * k)
    font = round(18 * k)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}">'
        f'<rect width="{size}" height="{size}" fill="rgb({r},{g},{b})"/>'
        f'<path d="M0 {c} H{size} M{c} 0 V{size}" stroke="#101010" stroke-width="{cross}"/>'
        f'<rect x="{inset}" y="{inset}" width="{size - 2 * inset}" height="{size - 2 * inset}" '
        f'fill="none" stroke="#101010" stroke-width="{border}"/>'
        f'<circle cx="{c}" cy="{c}" r="{radius}" fill="#ff2d55"/>'
        f'<text x="{round(10 * k)}" y="{round(26 * k)}" font-family="monospace" '
        f'font-size="{font}" fill="#101010">{z}/{x}/{y}</text>'
        "</svg>"
    )


def write_png_tile(z: int, x: int, y: int, rgba: tuple[int, int, int, int]) -> None:
    directory = os.path.join(PNG_ROOT, str(z), str(x))
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, f"{y}.png"), "wb") as handle:
        handle.write(png_bytes(256, 256, rgba))


def write_svg_tile(z: int, x: int, y: int, size: int = 256, directory: str | None = None) -> None:
    target = directory or os.path.join(SVG_ROOT, str(z), str(x))
    os.makedirs(target, exist_ok=True)
    with open(os.path.join(target, f"{y}.svg"), "w", encoding="utf-8") as handle:
        handle.write(svg_markup(z, x, y, size))


def write_checks_oracle() -> None:
    z, x, y = CHECK_TILE
    r, g, b, _ = color_for(z, x, y)
    oracle = {
        "source": "demo/generate-tiles.py",
        "tile": {"z": z, "x": x, "y": y},
        "size": 256,
        "samples": [
            {"name": "circleCenter", "x": 128, "y": 128, "expected": [255, 45, 85]},
            {"name": "crosshairTop", "x": 128, "y": 20, "expected": [16, 16, 16]},
            {"name": "borderLeft", "x": 4, "y": 40, "expected": [16, 16, 16]},
            {"name": "background", "x": 40, "y": 200, "expected": [r, g, b]},
        ],
        "text": {
            "inkThreshold": 200,
            "mustHaveInk": {"x": 8, "y": 8, "w": 44, "h": 24, "minInk": 3},
            "mustBeEmpty": [
                {"x": 204, "y": 8, "w": 44, "h": 24},
                {"x": 8, "y": 224, "w": 44, "h": 24},
            ],
        },
    }
    os.makedirs(SVG_ROOT, exist_ok=True)
    with open(os.path.join(SVG_ROOT, "checks.json"), "w", encoding="utf-8") as handle:
        json.dump(oracle, handle, indent=2)
        handle.write("\n")


def grid() -> list[tuple[int, int, int]]:
    coords: list[tuple[int, int, int]] = []
    for z in range(0, 4):
        for x in range(2**z):
            for y in range(2**z):
                coords.append((z, x, y))
    # Regional tiles around Czechia so the demo has structure at higher zooms.
    for z, xs, ys in (
        (4, range(8, 10), range(4, 7)),
        (5, range(16, 19), range(9, 13)),
        (6, range(32, 37), range(19, 25)),
    ):
        for x in xs:
            for y in ys:
                coords.append((z, x, y))
    return coords


def main() -> None:
    for z, x, y in grid():
        write_png_tile(z, x, y, color_for(z, x, y))
        write_svg_tile(z, x, y)
    # A 512px retina fixture at z1 (solid for PNG, full vector content for SVG).
    os.makedirs(os.path.join(PNG_ROOT, "retina", "1", "0"), exist_ok=True)
    with open(os.path.join(PNG_ROOT, "retina", "1", "0", "0.png"), "wb") as handle:
        handle.write(png_bytes(512, 512, (255, 0, 255, 255)))
    write_svg_tile(1, 0, 0, size=512, directory=os.path.join(SVG_ROOT, "retina", "1", "0"))
    write_checks_oracle()
    print(f"PNG tiles written to {PNG_ROOT}")
    print(f"SVG tiles + checks oracle written to {SVG_ROOT}")


if __name__ == "__main__":
    main()
