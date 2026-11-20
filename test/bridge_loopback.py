"""Offline Codex Live integration check. Run with the bridge's venv Python."""
import asyncio
import base64
import fractions
import json
import math
import os
from pathlib import Path
import shlex
import sys
import tempfile
import time
import unittest

from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from av import AudioFrame

BRIDGE = Path(__file__).resolve().parents[1] / "codex_voice.py"
# Model voice in the audio test: 300 ms of tone, then 200 ms of digital silence.
TONE_MS, PAUSE_MS = 300, 200


class Voice(AudioStreamTrack):
    """A stand-in for the model's voice at 48 kHz, paced in real time."""

    def __init__(self):
        super().__init__()
        self.n = 0

    async def recv(self):
        base = await super().recv()  # 20 ms at 48 kHz, paced
        frame = AudioFrame(format="s16", layout="mono", samples=960)
        on = (self.n * 20) % (TONE_MS + PAUSE_MS) < TONE_MS
        samples = [int(8000 * math.sin(2 * math.pi * 440 * (self.n * 960 + i) / 48000)) if on else 0 for i in range(960)]
        frame.planes[0].update(b"".join(s.to_bytes(2, "little", signed=True) for s in samples))
        frame.pts, frame.time_base, frame.sample_rate = base.pts, fractions.Fraction(1, 48000), 48000
        self.n += 1
        return frame


async def local_peer():
    """Serve only the Codex RPCs the bridge needs, using a local WebRTC peer."""
    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    with_audio = os.environ.get("LOOPBACK_AUDIO") == "1"
    if with_audio:
        pc.addTrack(Voice())

    @pc.on("datachannel")
    def opened(channel):
        channel.send(json.dumps({"type": "session.started"}))

    def send(message):
        print(json.dumps(message), flush=True)

    try:
        while line := await asyncio.to_thread(sys.stdin.readline):
            request = json.loads(line)
            if "id" not in request:
                continue
            method = request["method"]
            args = request.get("params") or {}
            result = {}
            if method == "thread/start":
                result = {"thread": {"id": "test"}}
            if method == "thread/realtime/start":
                if args["voice"] != "juniper" or args["model"] != "gpt-live-1.1-codex":
                    raise ValueError("Unexpected voice or model")
                await pc.setRemoteDescription(RTCSessionDescription(args["transport"]["sdp"], "offer"))
                await pc.setLocalDescription(await pc.createAnswer())
                send({"method": "thread/realtime/sdp", "params": {"threadId": "test", "sdp": pc.localDescription.sdp}})
            send({"id": request["id"], "result": result})
            if method == "thread/realtime/appendText":
                # Lose the model transport while the browser side remains open.
                return
    finally:
        await pc.close()


class LoopbackTest(unittest.IsolatedAsyncioTestCase):
    async def bridge(self, tmp, audio=False):
        executable = Path(tmp) / "codex"
        executable.write_text("#!/bin/sh\nexec " + shlex.join([sys.executable, str(Path(__file__).resolve()), "--peer"]) + "\n")
        executable.chmod(0o700)
        env = {**os.environ, "PATH": tmp + os.pathsep + os.environ["PATH"], "LOOPBACK_AUDIO": "1" if audio else "0"}
        return await asyncio.create_subprocess_exec(sys.executable, str(BRIDGE), stdin=-1, stdout=-1, env=env, limit=4 * 1024 * 1024)

    async def test_juniper_and_upstream_disconnect(self):
        with tempfile.TemporaryDirectory() as tmp:
            process = await self.bridge(tmp)

            def send(message):
                process.stdin.write((json.dumps(message) + "\n").encode())

            try:
                send({"type": "session.start", "session": {
                    "model": "gpt-live-1.1-codex", "instructions": "Loopback",
                    "audio": {"output": {"voice": "juniper"}}}})
                event = await asyncio.wait_for(process.stdout.readline(), 15)
                self.assertEqual(json.loads(event)["type"], "session.started")
                send({"type": "session.thinking.append", "content": "test disconnect"})
                await asyncio.wait_for(process.wait(), 6)
                self.assertEqual(process.returncode, 0)
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()

    async def test_output_positions_and_silence_marks(self):
        with tempfile.TemporaryDirectory() as tmp:
            process = await self.bridge(tmp, audio=True)
            process.stdin.write((json.dumps({"type": "session.start", "session": {
                "model": "gpt-live-1.1-codex", "instructions": "Loopback",
                "audio": {"output": {"voice": "juniper"}}}}) + "\n").encode())
            deltas = []
            try:
                deadline = time.monotonic() + 12
                while time.monotonic() < deadline and sum(1 for d in deltas if not d["delta"]) < 4:
                    line = await asyncio.wait_for(process.stdout.readline(), 10)
                    event = json.loads(line)
                    if event["type"] == "session.output_audio.delta":
                        deltas.append(event)
            finally:
                process.kill()
                await process.wait()
            marks = [d for d in deltas if not d["delta"]]
            self.assertGreaterEqual(len(marks), 4)
            # Positions advance by exactly the audio sent, plus the unsent silence.
            for prev, cur in zip(deltas, deltas[1:]):
                size = len(base64.b64decode(prev["delta"])) // 2
                if prev["delta"]:
                    self.assertEqual(cur["pts"], prev["pts"] + size)
                else:
                    # Opus smears each tone edge by a frame or two.
                    pause = (cur["pts"] - prev["pts"]) / 24
                    self.assertAlmostEqual(pause, PAUSE_MS, delta=60)


if __name__ == "__main__":
    if sys.argv[1:] == ["--peer"]:
        asyncio.run(local_peer())
    else:
        unittest.main()
