"""Erzeugt static/icon.ico (Balkendiagramm-Symbol) ohne Zusatzbibliotheken."""
import struct
import zlib
from pathlib import Path

SIZE = 256
BG = (42, 120, 214, 255)
FG = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)


def inside_round_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x < x1 and y0 <= y < y1):
        return False
    cx = min(max(x, x0 + r), x1 - r - 1)
    cy = min(max(y, y0 + r), y1 - r - 1)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


BARS = [(56, 140, 96, 204), (108, 100, 148, 204), (160, 56, 200, 204)]
rows = bytearray()
for y in range(SIZE):
    rows.append(0)
    for x in range(SIZE):
        if any(inside_round_rect(x, y, a, b, c, d, 10) for a, b, c, d in BARS):
            rows.extend(FG)
        elif inside_round_rect(x, y, 8, 8, 248, 248, 52):
            rows.extend(BG)
        else:
            rows.extend(CLEAR)


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))
ico = struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 22) + png
out = Path(__file__).resolve().parent.parent / "static" / "icon.ico"
out.write_bytes(ico)
print(out, len(ico))
