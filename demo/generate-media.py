#!/usr/bin/env python3
"""Deterministic media fixtures for the browser checks (MEDIA-01..06).

- `corners.png` / `corners-alt.png`: 8x8 RGBA bitmaps whose four quadrants have
  distinct known colours. They drive the placement, opacity, ordering and
  URL-change checks (a distinct colour per quadrant makes a wrong corner,
  a stale texture or a whole-texture upload failure visible in one sample).
- `two-frames.mp4`: two solid frames (red, then blue) at 1 fps, encoded with
  ffmpeg. Two visually unambiguous frames make a stopped frame pump and a lost
  final frame visible; regeneration is skipped when the file exists unless
  `--force` is given.

    python3 demo/generate-media.py [--force]
"""
from __future__ import annotations

import argparse
import pathlib
import shutil
import struct
import subprocess
import zlib

HERE = pathlib.Path(__file__).parent
OUT = HERE / "media"

CORNERS = {
    # top-left, top-right, bottom-left, bottom-right
    "corners.png": [(255, 0, 0, 255), (0, 200, 0, 255), (0, 0, 255, 255), (255, 255, 255, 255)],
    "corners-alt.png": [(255, 255, 0, 255), (0, 255, 255, 255), (255, 0, 255, 255), (128, 128, 128, 255)],
}


def png(width: int, height: int, pixel) -> bytes:
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter: none
        for x in range(width):
            raw.extend(pixel(x, y))

    def chunk(tag: bytes, data: bytes) -> bytes:
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def quadrant_pixel(size: int, colors):
    half = size // 2

    def pixel(x: int, y: int):
        index = (0 if y < half else 2) + (0 if x < half else 1)
        return colors[index]

    return pixel


def write_video(force: bool) -> None:
    target = OUT / "two-frames.mp4"
    if target.exists() and not force:
        print(f"{target} already exists; use --force to regenerate")
        return
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit(
            "ffmpeg is required to generate demo/media/two-frames.mp4 "
            "(install it or copy an existing fixture into demo/media/)"
        )
    command = [
        ffmpeg,
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=96x64:r=1:d=1",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=96x64:r=1:d=1",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[out]",
        "-map",
        "[out]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-movflags",
        "+faststart",
        str(target),
    ]
    subprocess.run(command, check=True)
    print(f"wrote {target} ({target.stat().st_size} bytes)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="regenerate even when files exist")
    args = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    for name, colors in CORNERS.items():
        target = OUT / name
        if target.exists() and not args.force:
            print(f"{target} already exists; use --force to regenerate")
            continue
        target.write_bytes(png(8, 8, quadrant_pixel(8, colors)))
        print(f"wrote {target} ({target.stat().st_size} bytes)")
    write_video(args.force)


if __name__ == "__main__":
    main()
