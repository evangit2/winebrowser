#!/usr/bin/env python3
"""Assemble the deliberately small shader language used by this demo."""

from pathlib import Path
import re
import sys

REGISTERS = {
    "v0": 0x90E40000,
    "v1": 0x90E40001,
    "c0": 0xA0E40000,
}
DESTINATIONS = {
    "oPos": 0xC00F0000,
    "oD0": 0xD00F0000,
    "oC0": 0x800F0800,
}


def source_lines(path):
    return [line.split(";", 1)[0].strip() for line in path.read_text().splitlines()
            if line.split(";", 1)[0].strip()]


def assemble(path, stage):
    lines = source_lines(path)
    version = {("vertex", "vs.1.1"): 0xFFFE0101,
               ("pixel", "ps.2.0"): 0xFFFF0200}.get((stage, lines.pop(0)))
    if version is None:
        raise SystemExit(f"unsupported shader version in {path}")
    words = [version]
    for line in lines:
        if line == "end":
            words.append(0x0000FFFF)
        elif stage == "vertex" and line in ("dcl_position v0", "dcl_color v1"):
            semantic, register = ((0x80000000, 0x900F0000) if "position" in line
                                  else (0x8000000A, 0x900F0001))
            words.extend((0x0000001F, semantic, register))
        elif stage == "pixel" and line == "dcl v0":
            words.extend((0x0200001F, 0x80000000, 0x900F0000))
        else:
            match = re.fullmatch(r"(mov|mul)\s+(\w+),\s*(\w+)(?:,\s*(\w+))?", line)
            if not match:
                raise SystemExit(f"unsupported instruction in {path}: {line}")
            opcode, destination, first, second = match.groups()
            if destination not in DESTINATIONS or first not in REGISTERS:
                raise SystemExit(f"unsupported operand in {path}: {line}")
            operands = 2 if opcode == "mov" else 3
            if operands == 3 and second not in REGISTERS:
                raise SystemExit(f"unsupported operand in {path}: {line}")
            token = {"mov": 1, "mul": 5}[opcode]
            if stage == "pixel":
                token |= operands << 24
            words.extend((token, DESTINATIONS[destination], REGISTERS[first]))
            if second:
                words.append(REGISTERS[second])
    if words[-1] != 0xFFFF:
        raise SystemExit(f"missing end in {path}")
    return words


def emit(name, words):
    body = ",\n    ".join(", ".join(f"0x{word:08x}u" for word in words[i:i + 4])
                         for i in range(0, len(words), 4))
    return f"static const DWORD {name}[] = {{\n    {body}\n}};\n"


if len(sys.argv) != 4:
    raise SystemExit("usage: assemble_shaders.py OUTPUT VS_SOURCE PS_SOURCE")
output, vertex, pixel = map(Path, sys.argv[1:])
output.write_text("/* Generated from the shader assembly sources. */\n" +
                  emit("cube_vs", assemble(vertex, "vertex")) +
                  emit("cube_ps", assemble(pixel, "pixel")))
