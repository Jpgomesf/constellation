#!/usr/bin/env python3
"""Run the mod in a real Claude Code session and save what the terminal shows.

Starts `claude --plugin-dir <this mod>` in a fixed-size pseudo-terminal, types
the given slash commands, and saves the screen as text and PNG at each --at
second, with the session's debug log beside the frames. No prompt is sent to
the model, so a run costs nothing.

    uv run --with pyte --with pillow dev/sandbox.py --keys "/constellation demo" --at 1,3,6,12,20,30

Frames land in --out (a new temporary folder by default).

KEY=VALUE lines in dev/sandbox.env (gitignored, optional) join the session's environment; --env wins.

--real-kitty runs the session in a new kitty window instead (kitty's remote
control must be on) and saves kitty's own screen text and a screenshot.
Several runs may go at once, each with its own --out.

--replay <workflows/wf_*.json> writes a finished run to where the mod looks for
this session's runs, on the run's own timeline (--speed faster), and removes
the files on exit.

--cmd "<shell command>" runs that command instead of a Claude Code session,
with no keys typed; --at counts from its start. For example, a preview:

    uv run --with pyte --with pillow dev/sandbox.py --real-kitty \
        --cmd "bun dev/preview.ts dev/previews/star.ts --for 8" --at 1,3,5 --out <folder>
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from dataclasses import dataclass
from pathlib import Path

import pyte
from PIL import Image, ImageDraw, ImageFont

MOD = Path(__file__).resolve().parent.parent
SANDBOX_ENV = MOD / "dev" / "sandbox.env"
KITTY = "/Applications/kitty.app/Contents/MacOS/kitty"
FG = (212, 212, 212)
BG = (24, 24, 24)
MENLO = "/System/Library/Fonts/Menlo.ttc"
SYMBOLS = "/System/Library/Fonts/Apple Symbols.ttf"
READY = ("❯", "for shortcuts", "auto mode")

# xterm's 16 named colors, as pyte names them.
NAMED = {
    "black": (0, 0, 0),
    "red": (205, 49, 49),
    "green": (13, 188, 121),
    "brown": (229, 229, 16),
    "yellow": (229, 229, 16),
    "blue": (36, 114, 200),
    "magenta": (188, 63, 188),
    "cyan": (17, 168, 205),
    "white": (229, 229, 229),
}


class AnsweringScreen(pyte.Screen):
    """A screen that answers the terminal's own queries (device status, attributes) on the PTY."""

    def __init__(self, cols: int, rows: int, fd: int) -> None:
        super().__init__(cols, rows)
        self.fd = fd

    def write_process_input(self, data: str) -> None:
        os.write(self.fd, data.encode())


@dataclass
class Session:
    pid: int
    fd: int
    screen: AnsweringScreen
    stream: pyte.ByteStream


def claude_argv(debug_file: Path) -> list[str]:
    return [shutil.which("claude") or "claude", "--plugin-dir", str(MOD), "--debug-file", str(debug_file)]


def env_file(path: Path) -> dict[str, str]:
    """The KEY=VALUE lines of `path`, skipping blanks and # comments; empty when there is no such file."""
    if not path.is_file():
        return {}
    pairs: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            pairs[key.strip()] = value.strip()
    return pairs


def session_env(args: argparse.Namespace) -> dict[str, str]:
    """What the session adds to its environment: dev/sandbox.env, then each --env over it."""
    return env_file(SANDBOX_ENV) | dict(pair.split("=", 1) for pair in args.env)


def spawn(cols: int, rows: int, cwd: Path, argv: list[str], extra_env: dict[str, str]) -> Session:
    size = struct.pack("HHHH", rows, cols, 0, 0)
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, size)
        os.chdir(cwd)
        env = {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor", **extra_env}
        os.execvpe(argv[0], argv, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
    screen = AnsweringScreen(cols, rows, fd)
    return Session(pid, fd, screen, pyte.ByteStream(screen))


def pump(s: Session, seconds: float) -> None:
    """Feeds the terminal's output to the screen for `seconds`."""
    end = time.monotonic() + seconds
    while (left := end - time.monotonic()) > 0:
        ready, _, _ = select.select([s.fd], [], [], min(left, 0.05))
        if ready:
            try:
                data = os.read(s.fd, 65536)
            except OSError:
                # The program exited: keep its last screen and let the time pass.
                time.sleep(max(0.0, end - time.monotonic()))
                return
            s.stream.feed(data)


def text_of(screen: pyte.Screen) -> str:
    return "\n".join(line.rstrip() for line in screen.display)


def wait_ready(s: Session, timeout: float) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        pump(s, 0.5)
        if any(mark in text_of(s.screen) for mark in READY):
            pump(s, 1.5)
            return True
    return False


def type_keys(s: Session, keys: str) -> None:
    for ch in keys:
        os.write(s.fd, ch.encode())
        pump(s, 0.02)
    pump(s, 0.4)
    os.write(s.fd, b"\r")


def rgb(color: str, default: tuple[int, int, int]) -> tuple[int, int, int]:
    if color == "default":
        return default
    if color in NAMED:
        return NAMED[color]
    if color.startswith("bright") and color[6:] in NAMED:
        return tuple(min(255, v + 40) for v in NAMED[color[6:]])  # type: ignore[return-value]
    try:
        return (int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16))
    except ValueError:
        return default


class Fonts:
    """Menlo for text, Apple Symbols for what Menlo lacks (braille, stars)."""

    def __init__(self, size: int) -> None:
        self.regular = ImageFont.truetype(MENLO, size, index=0)
        self.bold = ImageFont.truetype(MENLO, size, index=1)
        self.symbols = ImageFont.truetype(SYMBOLS, size) if Path(SYMBOLS).exists() else self.regular
        self.missing = self.regular.getmask("\U0010fffd").getbbox()
        self.cache: dict[str, bool] = {}

    def pick(self, ch: str, is_bold: bool) -> ImageFont.FreeTypeFont:
        if ord(ch) < 0x2190 or 0x2500 <= ord(ch) <= 0x257F:
            return self.bold if is_bold else self.regular
        if ch not in self.cache:
            self.cache[ch] = self.regular.getmask(ch).getbbox() != self.missing
        return (self.bold if is_bold else self.regular) if self.cache[ch] else self.symbols


def render(screen: pyte.Screen, path: Path, fonts: Fonts, size: int) -> None:
    cw = int(fonts.regular.getlength("M"))
    ch = int(size * 1.4)
    img = Image.new("RGB", (cw * screen.columns, ch * screen.lines), BG)
    draw = ImageDraw.Draw(img)
    for y in range(screen.lines):
        row = screen.buffer[y]
        for x in range(screen.columns):
            cell = row[x]
            fg, bg = rgb(cell.fg, FG), rgb(cell.bg, BG)
            if cell.reverse:
                fg, bg = bg, fg
            if bg != BG:
                draw.rectangle([x * cw, y * ch, (x + 1) * cw - 1, (y + 1) * ch - 1], fill=bg)
            if cell.data.strip():
                draw.text((x * cw, y * ch + 2), cell.data, font=fonts.pick(cell.data, cell.bold), fill=fg)
    img.save(path)


POLLED = re.compile(r"\$\.fs\.list \(constellation\): (\S+)/subagents/workflows failed")


@dataclass
class Replay:
    """A finished run's journal and final record, written to disk on its own timeline."""

    final: dict
    session_dir: Path
    speed: float
    events: list[tuple[float, str]]
    written: list[Path]

    @classmethod
    def load(cls, final_path: Path, session_dir: Path, speed: float) -> "Replay":
        final = json.loads(final_path.read_text())
        t0 = final["startTime"]
        events: list[tuple[float, str]] = []
        for e in final["workflowProgress"]:
            if e["type"] != "workflow_agent":
                continue
            start = (e["startedAt"] - t0) / 1000
            started = {"type": "started", "key": e["agentId"], "agentId": e["agentId"], "label": e["label"], "phase": e["phaseTitle"]}
            events.append((start, json.dumps(started)))
            events.append((start + e["durationMs"] / 1000, json.dumps({"type": "result", "key": e["agentId"], "agentId": e["agentId"]})))
        events.sort(key=lambda ev: ev[0])
        return cls(final, session_dir, speed, events, [])

    @property
    def run_dir(self) -> Path:
        return self.session_dir / "subagents" / "workflows" / self.final["runId"]

    def begin(self) -> None:
        scripts = self.session_dir / "workflows" / "scripts"
        scripts.mkdir(parents=True, exist_ok=True)
        script = scripts / f"{self.final['workflowName']}-{self.final['runId']}.js"
        script.write_text(self.final["script"])
        self.run_dir.mkdir(parents=True, exist_ok=True)
        (self.run_dir / "journal.jsonl").write_text(json.dumps({"type": "launched"}) + "\n")
        self.written += [script, self.run_dir]

    def at(self, seconds: float) -> None:
        """Writes every journal line due by `seconds` into the replay, and the final record once all are."""
        journal = self.run_dir / "journal.jsonl"
        due = [line for t, line in self.events if t / self.speed <= seconds]
        journal.write_text("\n".join([json.dumps({"type": "launched"}), *due]) + "\n")
        end = self.final["durationMs"] / 1000 / self.speed
        final_path = self.session_dir / "workflows" / f"{self.final['runId']}.json"
        if seconds >= end and not final_path.exists():
            final_path.write_text(json.dumps(self.final))
            self.written.append(final_path)

    def end_at(self) -> float:
        return self.final["durationMs"] / 1000 / self.speed

    def clean(self) -> None:
        for path in reversed(self.written):
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)


def session_dir_of(debug_log: Path, timeout: float, wait) -> Path | None:
    """The session folder the mod polls, as the debug log names it; `wait(seconds)` passes the time."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        wait(0.5)
        if debug_log.exists() and (m := POLLED.search(debug_log.read_text(errors="replace"))):
            return Path(m.group(1))
    return None


def kitty_socket() -> str:
    """kitty's remote-control address: KITTY_LISTEN_ON, set inside kitty, else the newest /tmp/mykitty* socket."""
    if address := os.environ.get("KITTY_LISTEN_ON"):
        return address
    sockets = sorted(Path("/tmp").glob("mykitty*"), key=lambda p: p.stat().st_mtime)
    if not sockets:
        raise SystemExit("no kitty remote-control socket: turn on kitty's remote control (allow_remote_control and listen_on in kitty.conf)")
    return f"unix:{sockets[-1]}"


class KittyWindow:
    """A kitty OS window running `argv`, driven by remote control and addressed by its own id."""

    def __init__(self, cols: int, rows: int, argv: list[str], cwd: Path, env: list[str], keep_focus: bool = False) -> None:
        self.socket = kitty_socket()
        flags = ["--type=os-window", "--os-window-title", f"constellation-sandbox-{os.getpid()}", "--cwd", str(cwd)]
        flags += [arg for pair in env for arg in ("--env", pair)]
        flags += ["--keep-focus"] if keep_focus else []
        self.id = self.kitty("launch", *flags, *argv).strip()
        try:
            self.kitty("resize-os-window", "--match", f"id:{self.id}", "--width", str(cols), "--height", str(rows), "--unit", "cells")
            self.platform_id = self.find_platform_id()
        except BaseException:
            self.close()
            raise

    def kitty(self, *argv: str) -> str:
        done = subprocess.run([KITTY, "@", "--to", self.socket, *argv], capture_output=True, text=True, check=True)
        return done.stdout

    def find_platform_id(self) -> str:
        for os_window in json.loads(self.kitty("ls")):
            if any(w["id"] == int(self.id) for tab in os_window["tabs"] for w in tab["windows"]):
                return str(os_window["platform_window_id"])
        raise SystemExit("the sandbox window vanished")

    def text(self, ansi: bool = False) -> str:
        return self.kitty("get-text", "--match", f"id:{self.id}", *(["--ansi"] if ansi else []))

    def type_line(self, line: str) -> None:
        self.kitty("send-text", "--match", f"id:{self.id}", line)
        time.sleep(0.6)
        self.kitty("send-text", "--match", f"id:{self.id}", "\r")

    def save(self, out: Path, name: str) -> bool:
        """Saves the window's text, ANSI text and screenshot; False when the window is gone."""
        try:
            (out / f"{name}.txt").write_text(self.text())
            (out / f"{name}.ansi").write_text(self.text(ansi=True))
        except subprocess.CalledProcessError:
            print(f"the sandbox window closed before {name}")
            return False
        subprocess.run(["screencapture", "-x", "-o", "-l", self.platform_id, str(out / f"{name}.png")], check=False)
        return True

    def close(self) -> None:
        subprocess.run([KITTY, "@", "--to", self.socket, "close-window", "--match", f"id:{self.id}"], check=False, capture_output=True)


def frame_times(args: argparse.Namespace) -> list[float]:
    return sorted(float(v) for v in args.at.split(","))


def run_in_kitty(args: argparse.Namespace, out: Path) -> None:
    if args.cmd:
        # Keep the window open until the last frame; it closes by itself if the harness dies.
        hold = int(frame_times(args)[-1]) + 30
        argv = ["/bin/sh", "-c", f"{args.cmd}\nexec sleep {hold}"]
        window = KittyWindow(args.cols, args.rows, argv, Path.cwd(), [f"PATH={os.environ.get('PATH', '')}"], keep_focus=True)
    else:
        env = [f"{key}={value}" for key, value in session_env(args).items()]
        window = KittyWindow(args.cols, args.rows, claude_argv(out / "debug.log"), Path.home(), env)
    replay = None
    try:
        if not args.cmd:
            end = time.monotonic() + 40
            while not any(mark in window.text() for mark in READY):
                if time.monotonic() > end:
                    raise SystemExit("Claude Code did not reach its prompt in the kitty window")
                time.sleep(0.5)
            time.sleep(1.5)
        for keys in args.keys:
            window.type_line(keys)
            time.sleep(1.0)
        if args.replay:
            folder = session_dir_of(out / "debug.log", 20, time.sleep)
            if folder is None:
                raise SystemExit("could not find the session folder the mod polls")
            replay = Replay.load(args.replay, folder, args.speed)
            replay.begin()
        start = time.monotonic()
        later = sorted((float(when), line) for when, line in (k.split(":", 1) for k in args.key_at))
        for at in frame_times(args):
            while (left := start + at - time.monotonic()) > 0:
                time.sleep(min(left, 0.1))
                now = time.monotonic() - start
                if replay:
                    replay.at(now)
                while later and later[0][0] <= now:
                    window.type_line(later.pop(0)[1])
            if not window.save(out, f"t{at:05.1f}s"):
                break
    finally:
        if replay:
            replay.clean()
        window.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cols", type=int, default=150)
    parser.add_argument("--rows", type=int, default=45)
    parser.add_argument("--keys", action="append", default=[], help="a line to type, Enter after it (repeatable)")
    parser.add_argument("--at", default="1,3,6,12", help="seconds after the last line to save a frame at")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--font-size", type=int, default=14)
    parser.add_argument("--env", action="append", default=[], help="KEY=VALUE for the session (repeatable)")
    parser.add_argument("--kitty", action="store_true", help="tell Claude Code it runs in kitty")
    parser.add_argument("--replay", type=Path, default=None, help="a finished run's workflows/wf_*.json to play back")
    parser.add_argument("--speed", type=float, default=1.0, help="how much faster than recorded to replay")
    parser.add_argument("--key-at", action="append", default=[], help="SECONDS:LINE, a line typed that long after start (repeatable)")
    parser.add_argument("--real-kitty", action="store_true", help="run in a new kitty window and screenshot it")
    parser.add_argument("--cmd", default=None, help="a shell command to run instead of a Claude Code session (no keys typed)")
    args = parser.parse_args()
    if args.cmd and (args.keys or args.key_at or args.replay):
        parser.error("--cmd runs no Claude Code session: --keys, --key-at and --replay don't apply")
    # Exit on SIGTERM/SIGHUP so the finally blocks still close the window and clean up.
    for stop in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(stop, lambda signum, _frame: sys.exit(128 + signum))

    out = args.out or Path(tempfile.mkdtemp(prefix="constellation-sandbox-"))
    out.mkdir(parents=True, exist_ok=True)
    if args.real_kitty:
        run_in_kitty(args, out)
        print(out)
        return
    cwd = Path.home()
    extra = session_env(args)
    if args.kitty:
        extra |= {"TERM": "xterm-kitty", "TERM_PROGRAM": "kitty", "KITTY_WINDOW_ID": "1"}
    if args.cmd:
        session = spawn(args.cols, args.rows, Path.cwd(), ["/bin/sh", "-c", args.cmd], extra)
    else:
        session = spawn(args.cols, args.rows, cwd, claude_argv(out / "debug.log"), extra)
    fonts = Fonts(args.font_size)
    try:
        if not args.cmd and not wait_ready(session, 40):
            (out / "not-ready.txt").write_text(text_of(session.screen))
            print(f"Claude Code did not reach its prompt; screen saved in {out}")
            return
        for keys in args.keys:
            type_keys(session, keys)
            pump(session, 1.0)
        replay = None
        if args.replay:
            folder = session_dir_of(out / "debug.log", 20, lambda seconds: pump(session, seconds))
            if folder is None:
                print("could not find the session folder the mod polls")
                return
            replay = Replay.load(args.replay, folder, args.speed)
            replay.begin()
        start = time.monotonic()
        later = sorted((float(when), line) for when, line in (k.split(":", 1) for k in args.key_at))
        try:
            for at in frame_times(args):
                while (left := start + at - time.monotonic()) > 0:
                    pump(session, min(left, 0.25))
                    now = time.monotonic() - start
                    if replay:
                        replay.at(now)
                    while later and later[0][0] <= now:
                        type_keys(session, later.pop(0)[1])
                name = f"t{at:05.1f}s"
                (out / f"{name}.txt").write_text(text_of(session.screen))
                render(session.screen, out / f"{name}.png", fonts, args.font_size)
        finally:
            if replay:
                replay.clean()
    finally:
        os.kill(session.pid, signal.SIGTERM)
        pump(session, 0.5)
        try:
            os.kill(session.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(session.pid, 0)
    print(out)


if __name__ == "__main__":
    main()
