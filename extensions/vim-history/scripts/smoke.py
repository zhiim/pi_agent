#!/usr/bin/env python3
"""Offline PTY smoke test with synthetic history and a local abortable mock model."""

import fcntl
import hashlib
import json
import os
import pty
import select
import shutil
import signal
import socket
import struct
import tempfile
import termios
import time
from pathlib import Path

plugin = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="pi-vim-smoke-") as temporary:
    root = Path(temporary)
    agent = root / "agent"
    agent.mkdir()
    (agent / "settings.json").write_text(
        json.dumps(
            {
                "quietStartup": True,
                "theme": "dark",
                "defaultProjectTrust": "never",
                "enableInstallTelemetry": False,
                "fullscreenExitOutput": "resume-hint",
                "fullscreenScrollbar": os.environ.get("SMOKE_SCROLLBAR", "always"),
            }
        )
    )
    session = root / "history.jsonl"
    timestamp = "2026-06-01T00:00:00.000Z"
    entries = [
        {
            "type": "session",
            "version": 3,
            "id": "vim-smoke",
            "timestamp": timestamp,
            "cwd": str(root),
        }
    ]
    parent = None
    for i in range(3):
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": f"USER_{i}: " + "wide content " * 12}
                ],
                "timestamp": 1,
            },
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "text",
                        "text": f"AGENT_{i}\n"
                        + "\n".join(f"agent line {n}" for n in range(30)),
                    }
                ],
                "timestamp": 2,
                "api": "anthropic-messages",
                "provider": "anthropic",
                "model": "claude-sonnet-4-5",
                "stopReason": "stop",
                "usage": {
                    "input": 0,
                    "output": 0,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": 0,
                    "cost": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "total": 0,
                    },
                },
            },
        ]
        for message in messages:
            entry_id = f"entry{len(entries)}"
            entries.append(
                {
                    "type": "message",
                    "id": entry_id,
                    "parentId": parent,
                    "timestamp": timestamp,
                    "message": message,
                }
            )
            parent = entry_id
    session.write_text("\n".join(json.dumps(e) for e in entries) + "\n")
    snapshots = root / "snapshots.json"
    helper = root / "probe.ts"
    helper.write_text("""
import fs from "node:fs";
import { matchesKey, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  const snapshots = [];
  let tui, mockRuns = 0, mockAborts = 0;
  // This provider never makes a network request. It streams one token and waits
  // for the real AgentSession abort signal, exercising ctx.abort end to end.
  pi.registerProvider("vim-smoke", {
    baseUrl: "http://127.0.0.1", apiKey: "offline-test", api: "vim-smoke-api",
    models: [{id: "mock-stream", name: "Offline mock", reasoning: false, input: ["text"],
      contextWindow: 8192, maxTokens: 1024, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const message = {role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{type: "text", text: ""}], stopReason: "pending", timestamp: Date.now(),
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
      mockRuns++;
      const abort = () => {
        mockAborts++;
        message.stopReason = "aborted";
        stream.push({type: "error", reason: "aborted", error: message});
        stream.end(message);
      };
      if (options.signal.aborted) abort();
      else {
        options.signal.addEventListener("abort", abort, {once: true});
        stream.push({type: "start", partial: message});
        stream.push({type: "text_start", contentIndex: 0, partial: message});
        message.content[0].text = "MOCK_RUNNING";
        stream.push({type: "text_delta", contentIndex: 0, delta: "MOCK_RUNNING", partial: message});
      }
      return stream;
    },
  });
  pi.on("session_start", (_event, ctx) => {
    // Simulate the status entry left by the previous plugin version.
    ctx.ui.setStatus("vim-history", "VIM INSERT");
    ctx.ui.setWidget("smoke-probe", t => { tui = t; return {render: () => [], invalidate: () => {}}; });
    ctx.ui.onTerminalInput(data => {
      if (matchesKey(data, "f12") && tui) {
        tui.renderNow();
        const lines = tui.getScreenLines();
        snapshots.push({top: tui.viewportTop, following: tui.isFollowingOutput,
          idle: ctx.isIdle(), mockRuns, mockAborts, draft: ctx.ui.getEditorText(),
          screen: lines.map(stripTerminalSequences),
          coloredInsert: lines.some(line => line.includes(ctx.ui.theme.fg("success", " INSERT "))),
          coloredNormal: lines.some(line => line.includes(ctx.ui.theme.fg("accent", " NORMAL ")))});
        fs.writeFileSync(process.env.SMOKE_SNAPSHOTS, JSON.stringify(snapshots));
        return {consume: true};
      }
    });
  });
}
""")
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(root)
        os.environ.update(
            {
                "PI_CODING_AGENT_DIR": str(agent),
                "XDG_RUNTIME_DIR": str(root),
                "SMOKE_SNAPSHOTS": str(snapshots),
                "TERM": "xterm-256color",
                "PI_OFFLINE": "1",
            }
        )
        pi = shutil.which("pi")
        os.execv(
            pi,
            [
                pi,
                "--offline",
                "--no-extensions",
                "--no-tools",
                "--no-context-files",
                "--no-skills",
                "--no-prompt-templates",
                "--no-approve",
                "--extension",
                str(helper),
                "--extension",
                str(plugin),
                "--extension",
                str(plugin.parent / "nvim-bridge.ts"),
                "--session",
                str(session),
                "--model",
                "vim-smoke/mock-stream",
                "--tui-mode",
                "fullscreen",
            ],
        )
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 70, 0, 0))
    output = bytearray()

    def drain(seconds=0.2):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            if select.select([fd], [], [], 0.03)[0]:
                try:
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        break
                    output.extend(chunk)
                except OSError:
                    break

    def send(data):
        os.write(fd, data)
        drain()

    def snapshot():
        previous = snapshots.stat().st_mtime_ns if snapshots.exists() else 0
        send(b"\x1b[24~")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if snapshots.exists():
                current = json.loads(snapshots.read_text())
                if snapshots.stat().st_mtime_ns != previous:
                    result = current[-1]
                    assert not any(
                        "VIM INSERT" in line or "VIM NORMAL" in line
                        for line in result["screen"]
                    ), result
                    return result
            drain(0.1)
        raise AssertionError(
            "Pi did not produce snapshot: " + output.decode(errors="replace")[-1600:]
        )

    def bridge_selection(content):
        payload = {
            "type": "selection",
            "path": str(root / "example.ts"),
            "startLine": 1,
            "endLine": 2,
            "content": content,
        }
        project_id = hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:16]
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(5)
            client.connect(str(root / "pi-nvim" / f"{project_id}.sock"))
            client.sendall((json.dumps(payload) + "\n").encode())
            response = b""
            while b"\n" not in response:
                chunk = client.recv(4096)
                assert chunk, response
                response += chunk
            assert json.loads(response) == {"ok": True}, response
        drain()
        return f"Path: {payload['path']}\nLines: 1-2\n\n{content}"

    try:
        drain(2)
        initial = snapshot()
        assert any("INSERT" in line for line in initial["screen"]), initial
        assert initial["coloredInsert"], initial
        send(b"draft")
        send(b"\x1b")
        normal = snapshot()
        assert any("NORMAL" in line for line in normal["screen"]), normal
        assert normal["coloredNormal"], normal
        send(b"[[]]")
        brackets = snapshot()
        assert brackets["top"] == normal["top"], (normal, brackets)
        assert any("NORMAL" in line for line in brackets["screen"]), brackets
        send(b"k")
        line_up = snapshot()
        assert line_up["top"] == normal["top"] - 1, (normal, line_up)
        send(b"j")
        line_down = snapshot()
        assert line_down["top"] == normal["top"], (normal, line_down)
        send(b"\x15")
        half_up = snapshot()
        assert half_up["top"] == max(0, line_down["top"] - 12), (line_down, half_up)
        send(b"\x04")
        half_down = snapshot()
        assert half_down["top"] == line_down["top"], (line_down, half_down)
        send(b"G")
        latest = snapshot()
        assert latest["following"] and latest["top"] == normal["top"], (normal, latest)
        assert any("NORMAL" in line for line in latest["screen"])
        send(b"iX")
        inserted = snapshot()
        assert "draftX" in "\n".join(inserted["screen"]), inserted
        send(b"\x1b")
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 40, 0, 0))
        os.kill(pid, signal.SIGWINCH)
        drain()
        before_scroll = snapshot()
        send(b"k")
        resized = snapshot()
        assert resized["top"] == before_scroll["top"] - 1, (before_scroll, resized)
        # Replacing the extension runtime must reinstall once and reset to INSERT.
        send(b"i\x03")
        send(b"/reload\r")
        drain(1)
        reloaded = snapshot()
        assert any("INSERT" in line for line in reloaded["screen"]), reloaded
        assert reloaded["coloredInsert"], reloaded
        # Use the real Unix socket and native paste path after reload. NORMAL
        # must switch synchronously; INSERT must not paste the selection twice.
        for mode in ["normal", "insert"]:
            send(b"draft")
            if mode == "normal":
                send(b"\x1b")
                send(b"k")
                assert snapshot()["coloredNormal"]
            text = bridge_selection(f"BRIDGE_{mode}\n中文 iG[[")
            pasted = snapshot()
            assert pasted["coloredInsert"] and pasted["following"], pasted
            assert pasted["draft"] == "draft" + text, pasted
            send(b"\x03")
        # Exercise a real agent run with only the local mock stream. Ctrl+C
        # must deliver the provider AbortSignal and leave the unsent draft intact.
        for mode in ["insert", "normal"]:
            before = snapshot()
            send(b"start mock stream\r")
            running = snapshot()
            assert (
                not running["idle"] and running["mockRuns"] == before["mockRuns"] + 1
            ), running
            send(b"unsent draft")
            if mode == "normal":
                send(b"\x1b")
                still_running = snapshot()
                assert not still_running["idle"] and still_running["coloredNormal"], (
                    still_running
                )
            send(b"\x03")
            stopped = snapshot()
            assert (
                stopped["idle"] and stopped["mockAborts"] == before["mockAborts"] + 1
            ), stopped
            assert "unsent draft" in "\n".join(stopped["screen"]), stopped
            assert stopped["coloredInsert" if mode == "insert" else "coloredNormal"], (
                stopped
            )
            if mode == "normal":
                send(b"i")
            # When idle, the same key still follows the native clear path.
            send(b"\x03")
            cleared = snapshot()
            assert "unsent draft" not in "\n".join(cleared["screen"]), cleared
        print(
            "PASS bundled Pi PTY: real nvim-bridge socket pastes once in NORMAL/INSERT after reload; Ctrl+C aborts mock runs, preserves draft, idle clears; colored modes, navigation, resize; scrollbar="
            + os.environ.get("SMOKE_SCROLLBAR", "always")
        )
    finally:
        os.kill(pid, signal.SIGTERM)
        os.waitpid(pid, 0)
        os.close(fd)
