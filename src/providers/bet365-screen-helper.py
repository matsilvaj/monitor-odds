from __future__ import annotations

import ctypes
import json
import sys
import time
from dataclasses import dataclass

from PIL import ImageGrab


user32 = ctypes.windll.user32
shcore = getattr(ctypes.windll, "shcore", None)

SW_RESTORE = 9
SW_SHOW = 5
INPUT_KEYBOARD = 1
INPUT_MOUSE = 0
KEYEVENTF_KEYUP = 0x0002
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
VK_ESCAPE = 0x1B


def enable_dpi_awareness() -> None:
    try:
        if shcore is not None:
            shcore.SetProcessDpiAwareness(2)
            return
    except Exception:
        pass

    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass


enable_dpi_awareness()


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.c_ushort),
        ("wScan", ctypes.c_ushort),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class INPUT_UNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", ctypes.c_ulong), ("union", INPUT_UNION)]


@dataclass(frozen=True)
class Highlight:
    x: int
    y: int
    width: int
    height: int
    pixels: int


def send_input(*inputs: INPUT) -> None:
    array = (INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), array, ctypes.sizeof(INPUT))
    if sent != len(inputs):
        raise OSError("Falha ao enviar entrada para o Windows.")


def key_input(vk: int, key_up: bool = False) -> INPUT:
    flags = KEYEVENTF_KEYUP if key_up else 0
    return INPUT(type=INPUT_KEYBOARD, union=INPUT_UNION(ki=KEYBDINPUT(vk, 0, flags, 0, None)))


def mouse_input(flag: int) -> INPUT:
    return INPUT(type=INPUT_MOUSE, union=INPUT_UNION(mi=MOUSEINPUT(0, 0, 0, flag, 0, None)))


def press_key(vk: int) -> None:
    send_input(key_input(vk), key_input(vk, True))


def is_active_find_highlight(pixel: tuple[int, int, int]) -> bool:
    red, green, blue = pixel[:3]
    return red >= 205 and 105 <= green <= 190 and blue <= 95


def is_find_highlight(pixel: tuple[int, int, int]) -> bool:
    red, green, blue = pixel[:3]
    return is_active_find_highlight(pixel) or (red >= 215 and green >= 190 and blue <= 135)


def find_highlights(active_only: bool = True) -> list[Highlight]:
    image = ImageGrab.grab()
    width, height = image.size
    pixels = image.load()

    visited: set[tuple[int, int]] = set()
    highlights: list[Highlight] = []
    step = 2
    color_check = is_active_find_highlight if active_only else is_find_highlight

    for y in range(150, height, step):
        for x in range(0, width, step):
            if (x, y) in visited:
                continue
            if not color_check(pixels[x, y]):
                continue

            stack = [(x, y)]
            visited.add((x, y))
            xs: list[int] = []
            ys: list[int] = []

            while stack:
                current_x, current_y = stack.pop()
                xs.append(current_x)
                ys.append(current_y)

                for next_x, next_y in (
                    (current_x + step, current_y),
                    (current_x - step, current_y),
                    (current_x, current_y + step),
                    (current_x, current_y - step),
                ):
                    if next_x < 0 or next_y < 150 or next_x >= width or next_y >= height:
                        continue
                    if (next_x, next_y) in visited:
                        continue
                    visited.add((next_x, next_y))
                    if color_check(pixels[next_x, next_y]):
                        stack.append((next_x, next_y))

            left, right = min(xs), max(xs)
            top, bottom = min(ys), max(ys)
            box_width = right - left + step
            box_height = bottom - top + step
            count = len(xs)

            if count >= 8 and 6 <= box_width <= 220 and 6 <= box_height <= 80:
                highlights.append(Highlight(left, top, box_width, box_height, count))

    return sorted(highlights, key=lambda item: item.pixels, reverse=True)


def click_highlight(highlight: Highlight) -> None:
    x = highlight.x + highlight.width // 2
    y = highlight.y + highlight.height // 2
    user32.SetCursorPos(x, y)
    time.sleep(0.15)
    send_input(mouse_input(MOUSEEVENTF_LEFTDOWN), mouse_input(MOUSEEVENTF_LEFTUP))
    time.sleep(0.2)
    press_key(VK_ESCAPE)


def main() -> int:
    highlights = find_highlights(active_only=True)
    if not highlights:
        highlights = find_highlights(active_only=False)
    if not highlights:
        print("{}", end="")
        return 2

    highlight = highlights[0]
    click_highlight(highlight)
    print(json.dumps(highlight.__dict__), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
