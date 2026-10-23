#!/usr/bin/env python3
"""Rebuild the README's GIFs from a real Claude Code session, or from a preview.

    uv run --with pyte --with pillow dev/gif.py hero
    uv run --with pyte --with pillow dev/gif.py all

Each GIF has a recipe (RECIPES below): the slash commands to type and when, the
stretch of time to keep, how often to sample it, and which rows and columns of
the pane to show. The session runs in dev/sandbox.py's pseudo-terminal, so no
model is called and no tokens are spent.

A take records the terminal's output byte by byte with its timestamps
(`<work>/<take>.json`), and frames are made afterwards by replaying it through
pyte, so their times are exact however dense the sampling. Recipes that share a
take share one recording; --reuse redraws from the last one without starting
Claude Code. --frames also saves every frame, as a PNG and as text, under the
work folder.

The session is a real one, with your own account and settings, so a recipe
keeps to the pane. A frame showing your home folder, your user name or an `@`
stops the build before any GIF is written.

Frames are drawn the way kitty draws them: block elements, braille and box lines
as shapes that join from cell to cell, every other glyph from Menlo with Apple
Symbols and Arial Unicode behind it.

The detail level is shared with every real session (it lives in ~/.claude), so
a take types its level first and always ends on `/constellation detail naked-eye`.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import signal
import sys
import tempfile
import time
from collections import Counter
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from functools import cache
from itertools import pairwise
from pathlib import Path

import pyte
from PIL import Image, ImageChops, ImageDraw, ImageFont
from wcwidth import wcwidth

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sandbox import Session, claude_argv, pump, rgb, spawn, type_keys, wait_ready

MOD = Path(__file__).resolve().parent.parent
OUT = MOD / "docs" / "gifs"
COLS, ROWS = 150, 45

# Colours of cells that name none: the terminal's own, and the pane's (#262626).
BG = (24, 24, 24)
FG = (212, 212, 212)
PANE_BG = (38, 38, 38)

# Cell size in pixels; Menlo's advance at 20 px is exactly 12.
CELL_W, CELL_H, FONT_SIZE = 12, 24, 20
REGULAR = [("/System/Library/Fonts/Menlo.ttc", 0), ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 0)]
BOLD = [("/System/Library/Fonts/Menlo.ttc", 1), ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 0)]
FALLBACK = [
    ("/System/Library/Fonts/Apple Symbols.ttf", 0),
    ("/Library/Fonts/Arial Unicode.ttf", 0),
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 0),
]


@dataclass(frozen=True)
class Line:
    """A slash command typed `at` seconds after the take's first command."""

    at: float
    text: str


@dataclass(frozen=True, kw_only=True)
class Take:
    """One recorded session: its detail level, then its commands, timed from the first.

    With `cmd`, a shell command (a preview, say) runs from the mod's folder instead of a
    Claude Code session, timed from its start; there is no pane, so a recipe's columns
    are the screen's, and cells that name no background get the pane's own.
    """

    name: str
    lines: tuple[Line, ...] = ()
    level: str = "naked-eye"
    seconds: float  # how long to keep recording after the last command
    cmd: str | None = None
    cols: int = COLS

    @property
    def restores(self) -> bool:
        return self.level != "naked-eye" or any("detail" in line.text for line in self.lines)


@dataclass(frozen=True, kw_only=True)
class Recipe:
    """One GIF: a stretch of a take, sampled every `step` seconds and played `speed` times faster."""

    name: str
    take: Take
    start: float  # seconds after the take's first command
    end: float
    step: float = 0.1
    speed: float = 1.0
    rows: tuple[int, int]  # screen rows kept, end exclusive; counted from the `follow` row when there is one
    follow: str | None = None  # text whose last row the crop moves with, so a tree's growing and folding stays in frame
    cols: tuple[int, int | None] = (0, None)  # pane columns kept (screen columns for a command), end exclusive
    hold: float = 0.0  # extra seconds on the last frame
    what: str = ""

    def times(self) -> list[float]:
        count = round((self.end - self.start) / self.step)
        return [round(self.start + i * self.step, 3) for i in range(count + 1)]


# ---------------------------------------------------------------- recording


class Tape(pyte.ByteStream):
    """A byte stream that keeps every chunk it is fed, with the time it arrived."""

    def __init__(self, screen: pyte.Screen) -> None:
        super().__init__(screen)
        self.chunks: list[tuple[float, bytes]] = []

    def feed(self, data: bytes) -> None:  # type: ignore[override]  # pyte types the feed it inherits as str
        self.chunks.append((time.monotonic(), data))
        super().feed(data)


@dataclass
class Cast:
    """A take's output: chunks timed from the take's first command (negative before it)."""

    cols: int
    rows: int
    chunks: list[tuple[float, bytes]] = field(default_factory=list)

    def save(self, path: Path) -> None:
        body = {"cols": self.cols, "rows": self.rows, "chunks": [[t, base64.b64encode(b).decode()] for t, b in self.chunks]}
        path.write_text(json.dumps(body), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> Cast:
        body = json.loads(path.read_text(encoding="utf-8"))
        return cls(body["cols"], body["rows"], [(t, base64.b64decode(b)) for t, b in body["chunks"]])


def type_line(session: Session, text: str) -> float:
    """Types a line and returns the moment Enter went in."""
    type_keys(session, text)
    return time.monotonic()


def record(take: Take) -> Cast:
    """Runs the take in a fresh Claude Code session (or its command) and returns its output."""
    if take.cmd is not None:
        return record_command(take, take.cmd)
    debug = Path(tempfile.mkdtemp(prefix="constellation-gif-")) / "debug.log"
    session = spawn(take.cols, ROWS, Path.home(), claude_argv(debug), {})
    tape = Tape(session.screen)
    session.stream = tape
    try:
        if not wait_ready(session, 40):
            raise SystemExit(f"Claude Code did not reach its prompt (debug log: {debug})")
        type_line(session, f"/constellation detail {take.level}")
        pump(session, 1.5)
        first = type_line(session, take.lines[0].text)
        last = first
        for line in take.lines[1:]:
            pump(session, max(0.0, first + line.at - time.monotonic()))
            last = type_line(session, line.text)
        pump(session, max(0.0, last + take.seconds - time.monotonic()))
        if take.restores:
            type_line(session, "/constellation detail naked-eye")
            pump(session, 1.5)
    finally:
        stop(session)
    return Cast(take.cols, ROWS, [(t - first, data) for t, data in tape.chunks])


def record_command(take: Take, cmd: str) -> Cast:
    session = spawn(take.cols, ROWS, MOD, ["/bin/sh", "-c", cmd], {})
    tape = Tape(session.screen)
    session.stream = tape
    start = time.monotonic()
    try:
        pump(session, take.seconds)
    finally:
        stop(session)
    return Cast(take.cols, ROWS, [(t - start, data) for t, data in tape.chunks])


def stop(session: Session) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(session.pid, sig)
        except ProcessLookupError:
            break
        pump(session, 0.5)
    os.waitpid(session.pid, 0)


# ---------------------------------------------------------------- replaying

Grid = list[list[pyte.screens.Char]]


def pane_left(screen: pyte.Screen) -> int:
    """The pane's first column: right of the divider, the column of `│` that runs down most rows."""
    rows = range(screen.lines - 6)
    counts = {x: sum(screen.buffer[y][x].data == "│" for y in rows) for x in range(screen.columns // 3, screen.columns - 20)}
    return max(counts, key=lambda x: counts[x]) + 1


def screens(cast: Cast, times: Sequence[float]) -> Iterator[pyte.Screen]:
    """The screen at each of `times` (ascending), one screen updated in place."""
    screen = pyte.Screen(cast.cols, cast.rows)
    stream = pyte.ByteStream(screen)
    chunks = iter(cast.chunks)
    pending = next(chunks, None)
    for t in times:
        while pending is not None and pending[0] <= t:
            stream.feed(pending[1])
            pending = next(chunks, None)
        yield screen


def grids(cast: Cast, recipe: Recipe) -> Iterator[Grid]:
    """The recipe's rows and columns of the screen at each of its times."""
    times = recipe.times()
    left = 0 if recipe.take.cmd else pane_left(next(screens(cast, times[-1:])))
    c0 = left + recipe.cols[0]
    c1 = cast.cols if recipe.cols[1] is None else left + recipe.cols[1]
    for screen in screens(cast, times):
        at = 0 if recipe.follow is None else row_of(screen, recipe.follow, c0, c1)
        yield [[screen.buffer[y][x] for x in range(c0, c1)] for y in range(at + recipe.rows[0], at + recipe.rows[1])]


def row_of(screen: pyte.Screen, text: str, c0: int, c1: int) -> int:
    """The lowest row showing `text` between columns c0 and c1."""
    for y in reversed(range(screen.lines)):
        if text in "".join(screen.buffer[y][x].data for x in range(c0, c1)):
            return y
    raise SystemExit(f"no row shows {text!r}")


# ---------------------------------------------------------------- drawing glyphs

LIGHT, HEAVY = 2, 4  # line widths in pixels
SUPER = 4  # shapes are drawn this many times larger, then reduced, for smooth curves

# Box lines as their arms: left, up, right, down (0 none, 1 light, 2 heavy).
BOX: dict[str, tuple[int, int, int, int]] = {
    "─": (1, 0, 1, 0), "━": (2, 0, 2, 0), "│": (0, 1, 0, 1), "┃": (0, 2, 0, 2),
    "┌": (0, 0, 1, 1), "┐": (1, 0, 0, 1), "└": (0, 1, 1, 0), "┘": (1, 1, 0, 0),
    "├": (0, 1, 1, 1), "┤": (1, 1, 0, 1), "┬": (1, 0, 1, 1), "┴": (1, 1, 1, 0), "┼": (1, 1, 1, 1),
    "╴": (1, 0, 0, 0), "╵": (0, 1, 0, 0), "╶": (0, 0, 1, 0), "╷": (0, 0, 0, 1),
    "╸": (2, 0, 0, 0), "╹": (0, 2, 0, 0), "╺": (0, 0, 2, 0), "╻": (0, 0, 0, 2),
    "╼": (1, 0, 2, 0), "╽": (0, 1, 0, 2), "╾": (2, 0, 1, 0), "╿": (0, 2, 0, 1),
}  # fmt: skip
# Rounded corners: the arc's centre, as a step from the cell's middle.
ROUND = {"╭": (1, 1), "╮": (-1, 1), "╯": (-1, -1), "╰": (1, -1)}
# Block elements as filled fractions of the cell: (x0, y0, x1, y1) boxes, or a shade.
QUARTERS = {"▘": (0, 0), "▝": (1, 0), "▖": (0, 1), "▗": (1, 1)}
BLOCK_QUARTERS = {"▙": "▘▖▗", "▚": "▘▗", "▛": "▘▝▖", "▜": "▘▝▗", "▞": "▝▖", "▟": "▝▖▗", **{k: k for k in QUARTERS}}
SHADES = {"░": 64, "▒": 128, "▓": 192}


def block_box(ch: str) -> list[tuple[float, float, float, float]]:
    code = ord(ch)
    if ch == "▀":
        return [(0, 0, 1, 0.5)]
    if 0x2581 <= code <= 0x2588:  # lower eighths up to the full block
        return [(0, 1 - (code - 0x2580) / 8, 1, 1)]
    if 0x2589 <= code <= 0x258F:  # left eighths
        return [(0, 0, (0x2590 - code) / 8, 1)]
    if ch == "▐":
        return [(0.5, 0, 1, 1)]
    if ch == "▔":
        return [(0, 0, 1, 1 / 8)]
    if ch == "▕":
        return [(7 / 8, 0, 1, 1)]
    if ch in BLOCK_QUARTERS:
        return [(qx / 2, qy / 2, qx / 2 + 0.5, qy / 2 + 0.5) for qx, qy in (QUARTERS[q] for q in BLOCK_QUARTERS[ch])]
    return []


def shape(ch: str) -> Image.Image | None:
    """The mask of a glyph drawn as a shape, or None when a font should draw it."""
    w, h, s = CELL_W, CELL_H, SUPER
    big = Image.new("L", (w * s, h * s))
    draw = ImageDraw.Draw(big)

    def rect(x0: float, y0: float, x1: float, y1: float, fill: int = 255) -> None:
        if x1 > x0 and y1 > y0:
            draw.rectangle([round(x0 * s), round(y0 * s), round(x1 * s) - 1, round(y1 * s) - 1], fill=fill)

    if ch in BOX:
        width = (0, LIGHT, HEAVY)
        left, up, right, down = (width[a] for a in BOX[ch])
        v, hz = max(up, down), max(left, right)
        mid_x = (w - v) // 2 if v else w // 2
        mid_y = (h - hz) // 2 if hz else h // 2
        rect(0, (h - left) // 2, mid_x + v, (h - left) // 2 + left)
        rect(mid_x, (h - right) // 2, w, (h - right) // 2 + right)
        rect((w - up) // 2, 0, (w - up) // 2 + up, mid_y + hz)
        rect((w - down) // 2, mid_y, (w - down) // 2 + down, h)
    elif ch in ROUND:
        dx, dy = ROUND[ch]
        x0, y0 = (w - LIGHT) // 2, (h - LIGHT) // 2
        cx, cy = x0 + LIGHT / 2, y0 + LIGHT / 2
        r = w / 2
        ax, ay = cx + dx * r, cy + dy * r
        outer, inner = r + LIGHT / 2, r - LIGHT / 2
        draw.ellipse([(ax - outer) * s, (ay - outer) * s, (ax + outer) * s, (ay + outer) * s], fill=255)
        draw.ellipse([(ax - inner) * s, (ay - inner) * s, (ax + inner) * s, (ay + inner) * s], fill=0)
        # Keep the quarter between the arms, then run the vertical arm to its edge.
        keep = Image.new("L", big.size)
        kx0, kx1 = (cx, ax) if dx > 0 else (ax, cx)
        ky0, ky1 = (cy, ay) if dy > 0 else (ay, cy)
        ImageDraw.Draw(keep).rectangle(
            [round((kx0 - LIGHT) * s), round((ky0 - LIGHT) * s), round((kx1 + LIGHT) * s), round((ky1 + LIGHT) * s)], fill=255
        )
        big = Image.composite(big, Image.new("L", big.size), keep)
        draw = ImageDraw.Draw(big)
        if dy > 0:
            rect(x0, ay, x0 + LIGHT, h)
        else:
            rect(x0, 0, x0 + LIGHT, ay)
    elif ch in ("╱", "╲", "╳"):
        if ch in ("╱", "╳"):
            draw.line([(0, h * s), (w * s, 0)], fill=255, width=LIGHT * s)
        if ch in ("╲", "╳"):
            draw.line([(0, 0), (w * s, h * s)], fill=255, width=LIGHT * s)
    elif ch in SHADES:
        rect(0, 0, w, h, SHADES[ch])
    elif boxes := block_box(ch):
        for bx0, by0, bx1, by1 in boxes:
            rect(bx0 * w, by0 * h, bx1 * w, by1 * h)
    elif 0x2800 < ord(ch) <= 0x28FF:
        bits = ord(ch) - 0x2800
        dots = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2), (0, 3), (1, 3)]
        r = w * 0.12
        for bit, (col, row) in enumerate(dots):
            if bits & (1 << bit):
                x, y = w * (0.25 + 0.5 * col), h * (0.125 + 0.25 * row)
                draw.ellipse([(x - r) * s, (y - r) * s, (x + r) * s, (y + r) * s], fill=255)
    else:
        return None
    return big.reduce(s)


def first_font(stack: Sequence[tuple[str, int]], size: int) -> ImageFont.FreeTypeFont:
    for path, index in stack:
        if Path(path).exists():
            return ImageFont.truetype(path, size, index=index)
    raise SystemExit(f"none of these fonts is installed: {[p for p, _ in stack]}")


class Glyphs:
    """Masks of every glyph, one cell (or two, for wide ones) in size, cached."""

    def __init__(self) -> None:
        self.regular = first_font(REGULAR, FONT_SIZE)
        self.bold = first_font(BOLD, FONT_SIZE)
        self.fallbacks = [ImageFont.truetype(p, FONT_SIZE, index=i) for p, i in FALLBACK if Path(p).exists()]
        ascent, descent = self.regular.getmetrics()
        self.baseline = (CELL_H - ascent - descent) // 2 + ascent
        self.masks: dict[tuple[str, bool], Image.Image | None] = {}

    def has(self, font: ImageFont.FreeTypeFont, ch: str) -> bool:
        return self.drawn(font, ch) != self.drawn(font, "\U0010fffd") and any(self.drawn(font, ch))

    @staticmethod
    @cache
    def drawn(font: ImageFont.FreeTypeFont, ch: str) -> bytes:
        im = Image.new("L", (CELL_W * 3, CELL_H * 2))
        ImageDraw.Draw(im).text((CELL_W, CELL_H), ch, font=font, fill=255, anchor="ls")
        return im.tobytes()

    def mask(self, ch: str, bold: bool) -> Image.Image | None:
        key = (ch, bold)
        if key not in self.masks:
            self.masks[key] = shape(ch) or self.text(ch, bold)
        return self.masks[key]

    def text(self, ch: str, bold: bool) -> Image.Image | None:
        own = self.bold if bold else self.regular
        font = next((f for f in [own, *self.fallbacks] if self.has(f, ch)), None)
        if font is None:
            return None
        width = CELL_W * max(1, wcwidth(ch))
        if font is own:
            im = Image.new("L", (width, CELL_H))
            ImageDraw.Draw(im).text((0, self.baseline), ch, font=font, fill=255, anchor="ls")
            return im
        return self.fitted(font, ch, width)

    def fitted(self, font: ImageFont.FreeTypeFont, ch: str, width: int) -> Image.Image:
        """A fallback glyph on the text's baseline, shrunk and centred when it would spill out of its cell."""
        im = Image.new("L", (width, CELL_H))
        x0, y0, x1, y1 = font.getbbox(ch, anchor="ls")
        gw, gh = x1 - x0, y1 - y0
        fits = gw <= width and self.baseline + y0 >= 0 and self.baseline + y1 <= CELL_H
        if fits:
            ImageDraw.Draw(im).text(((width - gw) / 2 - x0, self.baseline), ch, font=font, fill=255, anchor="ls")
            return im
        scale = min(width / max(gw, 1), CELL_H * 0.8 / max(gh, 1))
        small = font.font_variant(size=max(6, math.floor(FONT_SIZE * scale)))
        x0, y0, x1, y1 = small.getbbox(ch, anchor="lt")
        ImageDraw.Draw(im).text(((width - (x1 - x0)) / 2 - x0, (CELL_H - (y1 - y0)) / 2 - y0), ch, font=small, fill=255, anchor="lt")
        return im


def page_colour(grid: Grid) -> tuple[int, int, int]:
    """The pane's own background: the colour most of its cells are painted."""
    counts = Counter(rgb(cell.bg, BG) for row in grid for cell in row)
    return counts.most_common(1)[0][0]


def draw_grid(grid: Grid, glyphs: Glyphs, page: tuple[int, int, int]) -> Image.Image:
    """One frame: the cells on the page colour, with a cell of margin left and right and half a row above and below."""
    pad_x, pad_y = CELL_W, CELL_H // 2
    width = max((len(row) for row in grid), default=0)
    img = Image.new("RGB", (width * CELL_W + 2 * pad_x, len(grid) * CELL_H + 2 * pad_y), page)
    draw = ImageDraw.Draw(img)
    for y, row in enumerate(grid):
        top = pad_y + y * CELL_H
        for x, cell in enumerate(row):
            fg, bg = rgb(cell.fg, FG), rgb(cell.bg, page)
            if cell.reverse:
                fg, bg = bg, fg
            left = pad_x + x * CELL_W
            if bg != page:
                draw.rectangle([left, top, left + CELL_W - 1, top + CELL_H - 1], fill=bg)
            if cell.data.strip() and (mask := glyphs.mask(cell.data, cell.bold)) is not None:
                img.paste(fg, (left, top), mask)
    return img


# ---------------------------------------------------------------- assembling


def durations(recipe: Recipe, count: int) -> list[int]:
    """Each frame's time on screen in whole centiseconds (GIF's unit), rounded without drift."""
    stamps = [round(i * recipe.step / recipe.speed * 100) for i in range(count + 1)]
    out = [(b - a) * 10 for a, b in pairwise(stamps)]
    out[-1] += round(recipe.hold * 100) * 10
    return out


CLEAR = 255  # the palette index left transparent: "unchanged since the last frame"


def changes_only(frame: Image.Image, before: Image.Image) -> Image.Image:
    """The frame with every pixel that kept its colour made transparent, which compresses to almost nothing."""
    now, then = (Image.frombytes("L", im.size, im.tobytes()) for im in (frame, before))
    changed = ImageChops.difference(now, then).point(lambda v: 255 if v else 0)
    delta = Image.new("P", frame.size, CLEAR)
    delta.putpalette(frame.getpalette() or [])
    delta.paste(frame, mask=changed)
    return delta


def write_gif(frames: list[Image.Image], recipe: Recipe, path: Path) -> None:
    """One shared palette (no flicker, no dithering), only the changed pixels after the first frame, looping forever."""
    picks = frames[:: max(1, len(frames) // 24)]
    sheet = Image.new("RGB", (frames[0].width, frames[0].height * len(picks)))
    for i, frame in enumerate(picks):
        sheet.paste(frame, (0, i * frame.height))
    palette = sheet.quantize(colors=CLEAR, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
    deltas = [changes_only(frame, before) for before, frame in pairwise(indexed)]
    path.parent.mkdir(parents=True, exist_ok=True)
    indexed[0].save(
        path,
        save_all=True,
        append_images=deltas,
        duration=durations(recipe, len(frames)),
        loop=0,
        optimize=False,
        transparency=CLEAR,
        disposal=1,
    )


def text_of(grid: Grid) -> str:
    return "\n".join("".join(cell.data for cell in row).rstrip() for row in grid)


def private_words() -> list[str]:
    """What must never show in a published frame: this machine's home folder and user name."""
    return [str(Path.home()), f"/{Path.home().name}", "/Users/", "/home/", "@"]


def build(recipe: Recipe, cast: Cast, out: Path, frames_dir: Path | None) -> None:
    glyphs = Glyphs()
    grid_list = list(grids(cast, recipe))
    texts = [text_of(grid) for grid in grid_list]
    for t, text in zip(recipe.times(), texts, strict=True):
        if found := [word for word in private_words() if word in text]:
            raise SystemExit(f"{recipe.name}: the frame at {t} s shows {found}; crop it out before publishing")
    page = PANE_BG if recipe.take.cmd else page_colour(grid_list[0])
    frames = [draw_grid(grid, glyphs, page) for grid in grid_list]
    if frames_dir:
        frames_dir.mkdir(parents=True, exist_ok=True)
        for t, frame, text in zip(recipe.times(), frames, texts, strict=True):
            frame.save(frames_dir / f"t{t:06.2f}.png")
            (frames_dir / f"t{t:06.2f}.txt").write_text(text + "\n", encoding="utf-8")
    path = out / f"{recipe.name}.gif"
    write_gif(frames, recipe, path)
    print(f"{path}  {path.stat().st_size / 1e6:.2f} MB  {len(frames)} frames  {frames[0].width}x{frames[0].height}")


# ---------------------------------------------------------------- the GIFs

DEMO = "/constellation demo"
# The demo with a star life started under it, so the hero's eclipse falls on a steady star, not a protostar.
LIT = Take(name="lit", lines=(Line(0, DEMO), Line(14, "/constellation demo star")), seconds=24)
TELESCOPE = Take(name="telescope", lines=(Line(0, DEMO),), level="telescope", seconds=16)
BINOCULARS = Take(name="binoculars", lines=(Line(0, DEMO),), level="binoculars", seconds=38)
STAR = Take(name="star", lines=(Line(0, "/constellation demo star"),), seconds=41)
TOUR = Take(name="tour", lines=(Line(0, "/constellation demo tour"),), seconds=38)
LEVELS = Take(
    name="levels",
    lines=(Line(0, DEMO), Line(12, "/constellation detail binoculars"), Line(18, "/constellation detail telescope")),
    seconds=8,
)

# The eclipse preview's lineup: seven stars, each at a share of the window held still (as it is while the
# session waits on you), eclipsed on one 9 s loop staggered by 0.8 s a star. The demo's 40 s star life is
# too quick for this: it passes a red giant, an unstable star and a dying one in less than an eclipse lasts.
CYCLE = Take(name="cycle", cmd="bun dev/preview.ts dev/previews/eclipse.ts --only cycle --for 26", cols=170, seconds=27)
# Each stage: its place in the lineup, and what it is.
STAGES = {
    "protostar": (0, "a protostar"),
    "young": (2, "a young star"),
    "steady": (3, "a steady star"),
    "giant": (4, "a red giant"),
    "unstable": (5, "an unstable star"),
    "dying": (6, "a dying star"),
}


def stage(name: str, place: int, star: str) -> Recipe:
    """One star of the lineup through one whole loop, starting on the bare star."""
    start = 8.0 + 0.8 * place
    left = 1 + 24 * place
    return Recipe(
        name=f"eclipse-{name}", take=CYCLE, start=start, end=start + 8.9, rows=(1, 7), cols=(left, left + 22), what=f"the eclipse over {star}"
    )


RECIPES = {
    r.name: r
    for r in [
        *(stage(name, place, star) for name, (place, star) in STAGES.items()),
        Recipe(name="hero", take=LIT, start=15.0, end=34.6, rows=(1, 26), what="the pane through the demo's busiest stretch"),
        Recipe(name="binary", take=LIT, start=12.6, end=19.8, rows=(9, 26), what="two agents editing one file, orbiting"),
        Recipe(name="comet", take=LIT, start=14.0, end=27.5, step=0.125, rows=(9, 26), what="a straggler's tail"),
        Recipe(name="meteor", take=LIT, start=15.0, end=23.0, rows=(2, 9), what="failed calls falling across the sky"),
        Recipe(name="shift", take=TELESCOPE, start=8.4, end=11.9, rows=(13, 26), what="cache-blue and fresh-red moons"),
        Recipe(name="star", take=STAR, start=0.0, end=40.5, step=0.4, speed=4.0, rows=(2, 9), hold=1.0, what="the star's whole life"),
        Recipe(name="skies", take=TOUR, start=1.0, end=37.0, step=0.125, rows=(1, 9), what="the sky styles"),
        Recipe(name="levels", take=LEVELS, start=8.0, end=25.5, step=0.125, rows=(1, 29), what="naked eye, binoculars, telescope"),
        Recipe(
            name="retrograde",
            take=BINOCULARS,
            start=25.5,
            end=36.0,
            step=0.1,
            rows=(-7, 1),
            follow="agents · ",
            hold=0.8,
            what="a looping agent's moon stopping, turning back in white, then direct",
        ),
    ]
}


def main() -> None:
    gifs = "\n".join(f"  {r.name:<18}{r.what}" for r in RECIPES.values())
    parser = argparse.ArgumentParser(description=__doc__, epilog=f"GIFs:\n{gifs}", formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("names", nargs="+", choices=[*RECIPES, "all"], metavar="NAME", help="a GIF's name (listed below), or all")
    parser.add_argument("--out", type=Path, default=OUT, help="where the GIFs go (default docs/gifs)")
    parser.add_argument("--work", type=Path, default=Path(tempfile.gettempdir()) / "constellation-gif", help="where takes are kept")
    parser.add_argument("--reuse", action="store_true", help="redraw from the last recording of each take")
    parser.add_argument("--frames", action="store_true", help="also save every frame (PNG and text) under the work folder")
    args = parser.parse_args()

    recipes = list(RECIPES.values()) if "all" in args.names else [RECIPES[n] for n in dict.fromkeys(args.names)]
    args.work.mkdir(parents=True, exist_ok=True)
    casts: dict[str, Cast] = {}
    for recipe in recipes:
        take = recipe.take
        path = args.work / f"{take.name}.json"
        if take.name not in casts:
            if args.reuse and path.exists():
                casts[take.name] = Cast.load(path)
            else:
                print(f"recording {take.name} ({(take.lines[-1].at + 15 if take.lines else 0) + take.seconds:.0f} s or so)")
                casts[take.name] = record(take)
                casts[take.name].save(path)
        build(recipe, casts[take.name], args.out, args.work / recipe.name if args.frames else None)


if __name__ == "__main__":
    main()
