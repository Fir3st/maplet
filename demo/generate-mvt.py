#!/usr/bin/env python3
"""Generates the MVT fixtures used by demo/mvt.html.

This is an independent encoder (separate from the TypeScript test helper and
from src/formats/mvt.ts): if both sides agree on the wire bytes, the decoder
is not just validating itself.

Scene (z1 tiles, extent 4096, 1 local unit = 1/32 world unit):

* tile 1/0 (east half): a Prague cluster scaled for zoom 12
  - buildings: polygon id 1 with a hole
  - roads: ids 1 (named "D1"), 2, the uint64 9007199254740993, one without id
  - pois: id 10 name "Praha", one feature without id name "Bez ID"
* tiles 0/0 and 1/0: building id 7 halves -> one multi-tile identity
* tiles 0/0 and 0/1: road id 8 halves -> one multi-tile line
* remaining tiles: empty
* mvt-broken: garbage bytes for the decode-error battery
"""

from __future__ import annotations

import os
import struct

EXTENT = 4096


# ------------------------------- wire format -------------------------------


def varint(value: int) -> bytes:
    if value < 0:
        value &= (1 << 64) - 1
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def tag(field: int, wire: int) -> bytes:
    return varint((field << 3) | wire)


def field_bytes(field: int, payload: bytes) -> bytes:
    return tag(field, 2) + varint(len(payload)) + payload


def field_varint(field: int, value: int) -> bytes:
    return tag(field, 0) + varint(value)


def zigzag(value: int) -> int:
    return value * 2 if value >= 0 else -value * 2 - 1


def value_message(value) -> bytes:
    if isinstance(value, str):
        return field_bytes(1, value.encode("utf-8"))
    if isinstance(value, bool):
        return field_varint(7, 1 if value else 0)
    if isinstance(value, float):
        return tag(3, 1) + struct.pack("<d", value)
    if isinstance(value, int):
        if value < 0:
            return tag(6, 0) + varint(zigzag(value))
        if value > 0x7FFFFFFFFFFFFFFF:
            return field_varint(5, value)
        return field_varint(4, value)
    raise TypeError(f"unsupported value {value!r}")


def feature_message(
    fid: int | None,
    ftype: int,
    geometry: list[int],
    tags: list[tuple[int, int]] | None = None,
) -> bytes:
    out = bytearray()
    if fid is not None:
        out += field_varint(1, fid)
    if tags:
        packed = bytearray()
        for key, value in tags:
            packed += varint(key) + varint(value)
        out += field_bytes(2, bytes(packed))
    out += field_varint(3, ftype)
    packed_geometry = bytearray()
    for command in geometry:
        packed_geometry += varint(command)
    out += field_bytes(4, bytes(packed_geometry))
    return bytes(out)


def layer_message(
    name: str,
    features: list[bytes],
    keys: list[str] | None = None,
    values: list | None = None,
    extent: int = EXTENT,
) -> bytes:
    out = bytearray()
    out += field_bytes(1, name.encode("utf-8"))
    for feature in features:
        out += field_bytes(2, feature)
    for key in keys or []:
        out += field_bytes(3, key.encode("utf-8"))
    for value in values or []:
        out += field_bytes(4, value_message(value))
    out += field_varint(5, extent)
    return bytes(out)


def tile_message(layers: list[bytes]) -> bytes:
    out = bytearray()
    for layer in layers:
        out += field_bytes(3, layer)
    return bytes(out)


# -------------------------------- geometry ---------------------------------


def cmd(cid: int, count: int) -> int:
    return (count << 3) | cid


def geom_point(points: list[tuple[int, int]]) -> list[int]:
    out: list[int] = []
    x = y = 0
    for px, py in points:
        out += [cmd(1, 1), zigzag(px - x), zigzag(py - y)]
        x, y = px, py
    return out


def geom_line(parts: list[list[tuple[int, int]]]) -> list[int]:
    out: list[int] = []
    x = y = 0
    for part in parts:
        first, rest = part[0], part[1:]
        out += [cmd(1, 1), zigzag(first[0] - x), zigzag(first[1] - y)]
        x, y = first
        if rest:
            out.append(cmd(2, len(rest)))
            for px, py in rest:
                out += [zigzag(px - x), zigzag(py - y)]
                x, y = px, py
    return out


def geom_polygon(rings: list[list[tuple[int, int]]]) -> list[int]:
    out: list[int] = []
    x = y = 0
    for ring in rings:
        first, rest = ring[0], ring[1:]
        out += [cmd(1, 1), zigzag(first[0] - x), zigzag(first[1] - y)]
        x, y = first
        out.append(cmd(2, len(rest)))
        for px, py in rest:
            out += [zigzag(px - x), zigzag(py - y)]
            x, y = px, py
        out.append(cmd(3, 1))
    return out


# --------------------------------- scene -----------------------------------

# Prague cluster in tile 1/0; 1 local unit = 128 CSS px at zoom 12.
POI_PRAGUE = (324, 2774)
POI_NO_ID = (328, 2776)
BUILDING_A_RING = [(322, 2772), (330, 2772), (330, 2778), (322, 2778)]
BUILDING_A_HOLE = [(323, 2773), (323, 2775), (325, 2775), (325, 2773)]
ROAD_D1 = [(320, 2772), (327, 2772), (327, 2778)]
ROAD_2 = [(320, 2777), (328, 2777)]
ROAD_BIG_ID = [(323, 2775), (325, 2775)]

BIG_ID = 9007199254740993  # 2^53 + 1


def prague_layers(tile: tuple[int, int]) -> list[bytes]:
    layers: list[bytes] = []
    buildings = [
        feature_message(1, 3, geom_polygon([BUILDING_A_RING, BUILDING_A_HOLE])),
    ]
    roads = [
        feature_message(1, 2, geom_line([ROAD_D1]), tags=[(0, 0)]),
        feature_message(2, 2, geom_line([ROAD_2])),
        feature_message(BIG_ID, 2, geom_line([ROAD_BIG_ID])),
        feature_message(None, 2, geom_line([[(326, 2773), (326, 2779)]])),
    ]
    pois = [
        feature_message(10, 1, geom_point([POI_PRAGUE]), tags=[(0, 0)]),
        feature_message(None, 1, geom_point([POI_NO_ID]), tags=[(0, 1)]),
    ]
    # Multi-tile building 7 finishes the same source layer in this tile.
    if tile == (1, 0):
        buildings.append(feature_message(7, 3, geom_polygon([MULTI_POLY_B])))
    layers.append(layer_message("buildings", buildings))
    layers.append(layer_message("roads", roads, keys=["name"], values=["D1"]))
    layers.append(layer_message("pois", pois, keys=["name"], values=["Praha", "Bez ID"]))
    return layers


# Multi-tile features around the z1 meeting point (world 128,128).
MULTI_POLY_A = [(3000, 3000), (4096, 3000), (4096, 4096), (3000, 4096)]  # tile 0/0
MULTI_POLY_B = [(0, 3000), (1000, 3000), (1000, 4096), (0, 4096)]  # tile 1/0
MULTI_LINE_A = [(2048, 3800), (2048, 4096)]  # tile 0/0
MULTI_LINE_B = [(2048, 0), (2048, 300)]  # tile 0/1


def multi_layers(tile: tuple[int, int]) -> list[bytes]:
    layers: list[bytes] = []
    if tile == (0, 0):
        layers.append(layer_message("buildings", [feature_message(7, 3, geom_polygon([MULTI_POLY_A]))]))
        layers.append(layer_message("roads", [feature_message(8, 2, geom_line([MULTI_LINE_A]))]))
    elif tile == (0, 1):
        layers.append(layer_message("roads", [feature_message(8, 2, geom_line([MULTI_LINE_B]))]))
    return layers


def write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)
    print(f"{path}: {len(data)} bytes")


def main() -> None:
    root = os.path.dirname(os.path.abspath(__file__))
    tiles = {
        (0, 0): multi_layers((0, 0)),
        (1, 0): prague_layers((1, 0)),
        (0, 1): multi_layers((0, 1)),
        (1, 1): [],
    }
    for (x, y), layers in tiles.items():
        write(os.path.join(root, "mvt", "1", str(x), f"{y}.mvt"), tile_message(layers))
    # A whole-world tile so zooming below z1 still gets a valid (empty) answer.
    write(os.path.join(root, "mvt", "0", "0", "0.mvt"), tile_message([]))
    # Decode-error fixture: valid HTTP 200, broken bytes.
    for x in range(2):
        for y in range(2):
            write(os.path.join(root, "mvt-broken", "1", str(x), f"{y}.mvt"), b"this is not a vector tile")
    write(os.path.join(root, "mvt-broken", "0", "0", "0.mvt"), b"nope")


if __name__ == "__main__":
    main()
