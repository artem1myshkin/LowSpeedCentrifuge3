#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Minimal interactive TCP terminal for ELMO Direct Access commands."""

import argparse
import socket
import sys
import time


DEFAULT_HOST = "192.168.1.2"
DEFAULT_PORT = 2000


def build_command(text: str, terminator: str) -> bytes:
    command = text.strip()
    if not command:
        return b""

    if not command.endswith(";"):
        command += ";"

    if terminator == "cr":
        command += "\r"
    elif terminator == "lf":
        command += "\n"
    elif terminator == "crlf":
        command += "\r\n"

    return command.encode("ascii")


def read_response(sock: socket.socket, first_timeout: float, idle_timeout: float) -> bytes:
    chunks = []
    deadline = time.monotonic() + first_timeout

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break

        sock.settimeout(remaining)
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            break

        if not chunk:
            break

        chunks.append(chunk)
        deadline = time.monotonic() + idle_timeout

    return b"".join(chunks)


def printable(data: bytes) -> str:
    if not data:
        return "<no response>"

    text = data.decode("ascii", errors="replace")
    return (
        text.replace("\r\n", "\\r\\n\n")
        .replace("\r", "\\r")
        .replace("\n", "\\n\n")
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Interactive TCP terminal for ELMO commands.")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"ELMO IP address, default {DEFAULT_HOST}")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"ELMO TCP port, default {DEFAULT_PORT}")
    parser.add_argument("--timeout", type=float, default=2.0, help="Timeout waiting for first response byte")
    parser.add_argument("--idle-timeout", type=float, default=0.2, help="Response is complete after this idle time")
    parser.add_argument(
        "--terminator",
        choices=("none", "cr", "lf", "crlf"),
        default="cr",
        help="Command terminator after semicolon, default cr",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        with socket.create_connection((args.host, args.port), timeout=args.timeout) as sock:
            print(f"Connected to {args.host}:{args.port}")
            print("Type ELMO command, for example: SR;EE[5];MF;SO;MO;MS;")
            print("Type exit or press Ctrl+C to quit.")

            while True:
                try:
                    line = input("ELMO> ")
                except (EOFError, KeyboardInterrupt):
                    print()
                    return 0

                if line.strip().lower() in {"exit", "quit"}:
                    return 0

                payload = build_command(line, args.terminator)
                if not payload:
                    continue

                try:
                    sock.sendall(payload)
                    response = read_response(sock, args.timeout, args.idle_timeout)
                except (OSError, socket.timeout) as exc:
                    print(f"TCP error: {exc}", file=sys.stderr)
                    return 1

                print(printable(response))

    except OSError as exc:
        print(f"Cannot connect to {args.host}:{args.port}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
