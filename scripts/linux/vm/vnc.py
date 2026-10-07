#!/usr/bin/env python3
"""The screen of a vm.sh machine over its VNC socket, standard library only (NP-093).

QMP screendump only sees the 2D surface: once the guest draws with VirGL it keeps returning the
firmware frame. egl-headless copies the GL frame for VNC, so screenshots and input go through VNC.

  vnc.py <socket> shot <file.png>
  vnc.py <socket> click <x> <y>        left click
  vnc.py <socket> type <text>          ASCII text
  vnc.py <socket> key <name>...        Return, Escape, Tab, BackSpace, super, ctrl+q, alt+F4...
"""
import socket
import struct
import sys
import time
import zlib

KEYS = {
    "Return": 0xFF0D, "Escape": 0xFF1B, "Tab": 0xFF09, "BackSpace": 0xFF08, "Delete": 0xFFFF,
    "Up": 0xFF52, "Down": 0xFF54, "Left": 0xFF51, "Right": 0xFF53, "Home": 0xFF50, "End": 0xFF57,
    "super": 0xFFEB, "ctrl": 0xFFE3, "alt": 0xFFE9, "shift": 0xFFE1, "space": 0x20,
    **{f"F{n}": 0xFFBD + n for n in range(1, 13)},
}


def recv(sock, size):
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ConnectionError("VNC closed the connection")
        data += chunk
    return data


def connect(path):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(path)
    recv(sock, 12)
    sock.sendall(b"RFB 003.008\n")
    types = recv(sock, recv(sock, 1)[0])
    if 1 not in types:
        raise RuntimeError(f"VNC asks for a password (types {list(types)})")
    sock.sendall(b"\x01")
    if struct.unpack(">I", recv(sock, 4))[0] != 0:
        raise RuntimeError("VNC refused the connection")
    sock.sendall(b"\x01")  # shared
    width, height = struct.unpack(">HH", recv(sock, 4))
    recv(sock, 16)
    recv(sock, struct.unpack(">I", recv(sock, 4))[0])
    # 32 bits per pixel, little endian, red at 16, green at 8, blue at 0; raw encoding only.
    sock.sendall(struct.pack(">BxxxBBBBHHHBBBxxx", 0, 32, 24, 0, 1, 255, 255, 255, 16, 8, 0))
    sock.sendall(struct.pack(">BxHi", 2, 1, 0))
    return sock, width, height


def shot(sock, width, height, out):
    sock.sendall(struct.pack(">BBHHHH", 3, 0, 0, 0, width, height))
    while True:
        kind = recv(sock, 1)[0]
        if kind == 0:
            break
        if kind == 2:  # bell
            continue
        if kind == 3:  # cut text
            recv(sock, 3)
            recv(sock, struct.unpack(">I", recv(sock, 4))[0])
            continue
        raise RuntimeError(f"unexpected VNC message {kind}")
    recv(sock, 1)
    frame = bytearray(width * height * 4)
    for _ in range(struct.unpack(">H", recv(sock, 2))[0]):
        x, y, w, h, encoding = struct.unpack(">HHHHi", recv(sock, 12))
        if encoding != 0:
            raise RuntimeError(f"unexpected encoding {encoding}")
        pixels = recv(sock, w * h * 4)
        for row in range(h):
            start = ((y + row) * width + x) * 4
            frame[start:start + w * 4] = pixels[row * w * 4:(row + 1) * w * 4]
    # Pixels arrive as B, G, R, X bytes; PNG rows are a filter byte and R, G, B.
    rows = bytearray()
    for start in range(0, len(frame), width * 4):
        bgrx = frame[start:start + width * 4]
        rgb = bytearray(width * 3)
        rgb[0::3], rgb[1::3], rgb[2::3] = bgrx[2::4], bgrx[1::4], bgrx[0::4]
        rows += b"\x00" + rgb
    png = b"\x89PNG\r\n\x1a\n"
    for tag, body in ((b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)),
                      (b"IDAT", zlib.compress(rows, 6)), (b"IEND", b"")):
        png += struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
    with open(out, "wb") as file:
        file.write(png)


def key(sock, keysym, down):
    sock.sendall(struct.pack(">BBxxI", 4, 1 if down else 0, keysym))


def press(sock, combo):
    names = combo.split("+")
    syms = [KEYS.get(n, ord(n) if len(n) == 1 else None) for n in names]
    if None in syms:
        raise SystemExit(f"unknown key {combo}")
    for s in syms:
        key(sock, s, True)
    for s in reversed(syms):
        key(sock, s, False)
    time.sleep(0.05)


def main():
    path, command, *args = sys.argv[1:]
    sock, width, height = connect(path)
    if command == "shot":
        shot(sock, width, height, args[0])
    elif command == "click":
        x, y = int(args[0]), int(args[1])
        for mask in (0, 1, 0):
            sock.sendall(struct.pack(">BBHH", 5, mask, x, y))
            time.sleep(0.05)
    elif command == "type":
        for char in " ".join(args):
            key(sock, ord(char), True)
            key(sock, ord(char), False)
            time.sleep(0.02)
    elif command == "key":
        for combo in args:
            press(sock, combo)
    else:
        raise SystemExit(__doc__)
    time.sleep(0.1)
    sock.close()


if __name__ == "__main__":
    main()
