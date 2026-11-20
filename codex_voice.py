"""BB PCM to Codex V3 WebRTC. One process, one ephemeral Codex session per call."""
import asyncio
import base64
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
from fractions import Fraction

MODEL = "gpt-live-1.1-codex"
RUNTIME = Path.home() / ".local/share/bb-voice-mode/codex-live"


def install():
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    python = RUNTIME / "venv/bin/python"
    if not python.exists():
        subprocess.run([sys.executable, "-m", "venv", str(RUNTIME / "venv")], check=True)
    subprocess.run([str(python), "-m", "pip", "install", "--only-binary=:all:", "aiortc==1.16.0"], check=True)
    if not shutil.which("codex"):
        raise RuntimeError("Codex CLI is required on the BB server")
    with tempfile.NamedTemporaryFile(dir=RUNTIME, delete=False) as tmp:
        tmp.write(Path(__file__).read_bytes())
    os.replace(tmp.name, RUNTIME / "codex_voice.py")


# A frame whose peak stays at or below this (about -66 dBFS) is silence.
SILENCE_PEAK = 16
FRAME_BYTES = 960  # 20 ms of mono s16 at 24 kHz


def frame_peak(pcm):
    """Peak absolute sample of little-endian s16 PCM."""
    view = memoryview(pcm).cast("h")
    return max(max(view, default=0), -min(view, default=0))


def frame_rms(pcm):
    view = memoryview(pcm).cast("h")
    return (sum(x * x for x in view) / max(1, len(view))) ** 0.5


class Uplink:
    """Mic PCM between the browser's bursty chunks and the 20 ms WebRTC clock.

    The browser sends ~43 ms chunks that arrive unevenly and, after a network
    or main-thread stall, in bursts. Playback starts only once a small cushion
    is buffered, so a late chunk does not punch zero-padded holes into speech.
    The backlog is bounded: above LIMIT it is cut to TARGET at once, and when
    it stays above TARGET for half a second it is cut to CUSHION. Silent frames go
    first, then the oldest audio, so the model never hears the caller with a
    growing delay.
    """
    CUSHION = 3 * FRAME_BYTES      # 60 ms before the first frame after a gap
    TARGET = 4 * FRAME_BYTES       # 80 ms: steady-state ceiling for the 1 s minimum
    LIMIT = 12 * FRAME_BYTES       # 240 ms: drain at once to TARGET
    WINDOW = 25                    # pulls (500 ms) for the steady-state check
    QUIET_RMS = 300                # about -40 dBFS

    def __init__(self):
        self.buf = bytearray()
        self.primed = False
        self.low = []
        self.dropped = 0
        self.holes = 0

    def push(self, pcm):
        self.buf.extend(pcm[:len(pcm) & ~1])
        if len(self.buf) > self.LIMIT:
            self.drain(self.TARGET)

    def pull(self):
        if not self.primed:
            if len(self.buf) < self.CUSHION:
                return bytes(FRAME_BYTES)
            self.primed = True
        if len(self.buf) < FRAME_BYTES:
            # Ran dry: send what is left, then wait for the cushion again.
            chunk = bytes(self.buf).ljust(FRAME_BYTES, b"\x00")
            self.buf.clear()
            self.primed = False
            self.holes += 1
            self.low.clear()
            return chunk
        chunk = bytes(self.buf[:FRAME_BYTES])
        del self.buf[:FRAME_BYTES]
        self.low.append(len(self.buf))
        if len(self.low) > self.WINDOW:
            del self.low[0]
        if len(self.low) == self.WINDOW and min(self.low) > self.TARGET:
            self.drain(self.CUSHION)
            self.low.clear()
        return chunk

    def drain(self, target):
        excess = len(self.buf) - target
        if excess <= 0:
            return
        frames = [self.buf[i:i + FRAME_BYTES] for i in range(0, len(self.buf), FRAME_BYTES)]
        drop = set()
        quiet = sorted((frame_rms(f), i) for i, f in enumerate(frames) if len(f) == FRAME_BYTES)
        for rms, i in quiet:
            if excess <= 0 or rms > self.QUIET_RMS:
                break
            drop.add(i)
            excess -= FRAME_BYTES
        kept = bytearray().join(f for i, f in enumerate(frames) if i not in drop)
        if excess > 0:
            cut = -(-excess // 2) * 2  # whole samples, oldest first
            del kept[:cut]
        self.dropped += len(self.buf) - len(kept)
        self.buf = kept


class Downlink:
    """Tags 24 kHz output frames with their media position and skips silence.

    Each sent frame carries `pts`, its first sample's position in the stream.
    When silence starts, one empty delta with the pts marks it, so the client
    can tell a pause from audio that is late.
    """

    def __init__(self, out_rate=24000):
        self.out_rate = out_rate
        self.pts = 0
        self.next_in = None
        self.silent = True

    def gap(self, in_pts, in_samples, in_rate):
        """Account for input frames the receiver never delivered."""
        if in_pts is None:
            return
        if self.next_in is not None and in_pts > self.next_in:
            self.pts += (in_pts - self.next_in) * self.out_rate // in_rate
        self.next_in = in_pts + in_samples

    def frame(self, pcm):
        """Returns the event fields to emit for one resampled frame, or None."""
        pts = self.pts
        self.pts += len(pcm) // 2
        if frame_peak(pcm) <= SILENCE_PEAK:
            if self.silent:
                return None
            self.silent = True
            return {"delta": "", "pts": pts}
        self.silent = False
        return {"delta": base64.b64encode(pcm).decode(), "pts": pts}


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}, ensure_ascii=False), flush=True)


async def run():
    from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription
    from aiortc.mediastreams import MediaStreamError
    from av import AudioFrame, AudioResampler

    loop = asyncio.get_running_loop()
    stdin = asyncio.StreamReader(limit=512 * 1024)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(stdin), sys.stdin.buffer)
    start = json.loads(await stdin.readline())
    if start.get("type") != "session.start":
        return
    cfg = start["session"]
    if cfg.get("model") != MODEL:
        raise ValueError("Unexpected Codex voice model")
    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    done = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, done.set)
    uplink = Uplink()
    pending = {}
    tasks = set()
    seq = 0
    tid = None
    process = None

    class Mic(AudioStreamTrack):
        async def recv(self):
            # Pace mono chunks at 20 ms even while muted or acquiring a mic.
            base = await super().recv()
            frame = AudioFrame(format="s16", layout="mono", samples=480)
            frame.planes[0].update(uplink.pull())
            frame.pts = base.pts * 3
            frame.time_base = Fraction(1, 24000)
            frame.sample_rate = 24000
            return frame

    def spawn(coro):
        task = asyncio.create_task(coro)
        tasks.add(task)
        def settled(t):
            tasks.discard(t)
            if not t.cancelled() and t.exception() is not None:
                done.set()
        task.add_done_callback(settled)

    def write(value):
        process.stdin.write((json.dumps(value) + "\n").encode())

    async def rpc(method, params):
        nonlocal seq
        seq += 1
        ident = seq
        future = loop.create_future()
        pending[ident] = future
        try:
            write(dict(id=ident, method=method, params=params))
            return await asyncio.wait_for(future, 12)
        finally:
            pending.pop(ident, None)

    async def read_codex():
        async for line in process.stdout:
            msg = json.loads(line)
            ident = msg.get("id")
            method = msg.get("method", "")
            if ident is not None and not method:
                future = pending.get(ident)
                if future and not future.done():
                    if "error" in msg:
                        future.set_exception(RuntimeError("Codex request failed"))
                    else:
                        future.set_result(msg.get("result"))
                continue
            p = msg.get("params") or {}
            if ident is not None:
                write({"id": ident, "error": {"code": -32601, "message": "Voice client cannot run tools or approve actions"}})
            elif p.get("threadId") == tid:
                if method == "thread/realtime/sdp":
                    await pc.setRemoteDescription(RTCSessionDescription(sdp=p["sdp"], type="answer"))
                elif method in ("thread/realtime/error", "thread/realtime/closed"):
                    done.set()
                elif method == "turn/started":
                    # Codex also admits a local handoff turn. BB owns the work.
                    spawn(rpc("turn/interrupt", {"threadId": tid, "turnId": p["turn"]["id"]}))
        done.set()

    async def speaker(track):
        resample = AudioResampler(format="s16", layout="mono", rate=24000)
        downlink = Downlink()
        try:
            while not done.is_set():
                received = await track.recv()
                downlink.gap(received.pts, received.samples, received.sample_rate)
                for frame in resample.resample(received):
                    fields = downlink.frame(bytes(frame.planes[0])[:frame.samples * 2])
                    if fields:
                        emit("session.output_audio.delta", **fields)
        except MediaStreamError:
            done.set()

    pc.addTrack(Mic())
    pc.on("track", lambda track: spawn(speaker(track)))
    dc = pc.createDataChannel("oai-events")

    @pc.on("connectionstatechange")
    def state():
        if pc.connectionState in ("failed", "closed"):
            done.set()

    @dc.on("close")
    def closed():
        done.set()

    pending_turn = None

    @dc.on("message")
    def event(raw):
        nonlocal pending_turn
        msg = json.loads(raw)
        kind = msg.get("type")
        item = msg.get("item") or {}
        if kind == "session.started":
            emit(kind)
        elif kind in ("input_transcript.added", "output_transcript.added"):
            role = kind.split("_")[0]
            emit("session." + role + "_transcript.delta", event_id=item["id"], delta=item["text"],
                 start_ms=msg["start_ms"], end_ms=msg["end_ms"])
        elif kind == "delegation.created" and item.get("target") == "client":
            pending_turn = (item.get("user_bidi_turn_id"), item["id"])
            emit("session.delegation.created", event_id=item["id"], offset_ms=msg["offset_ms"],
                 delegation={"id": item["id"], "target": "client"})
        elif kind == "turn.done" and pending_turn:
            turn = msg.get("turn") or {}
            if turn.get("role") == "user" and turn.get("id") and turn["id"] == pending_turn[0]:
                emit("session.delegation.transcribed", delegation_id=pending_turn[1], text=turn.get("transcript"))
                pending_turn = None
        elif kind == "error":
            error = msg.get("error") or {}
            emit("error", error={"code": str(error.get("code", "connection_lost"))})
            done.set()
        elif kind == "session.closed":
            emit(kind, reason=msg.get("reason"))
            done.set()

    async def incoming():
        async for line in stdin:
            msg = json.loads(line)
            kind = msg.get("type")
            if kind == "session.close":
                emit("session.closed", reason="close_requested")
                break
            if kind == "session.input_audio.append":
                uplink.push(base64.b64decode(msg["audio"], validate=True))
            elif kind == "session.commentary.append":
                await rpc("thread/realtime/appendSpeech", {"threadId": tid, "text": msg["content"]})
            elif kind == "session.thinking.append":
                await rpc("thread/realtime/appendText", {"threadId": tid, "role": "assistant", "text": msg["content"]})
        done.set()

    with tempfile.TemporaryDirectory(prefix="bb-voice-codex-") as cwd:
        try:
            process = await asyncio.create_subprocess_exec("codex", "app-server", "--enable", "realtime_conversation",
                cwd=cwd, stdin=-1, stdout=-1, stderr=asyncio.subprocess.DEVNULL, limit=2*1024*1024)
            spawn(read_codex())
            await rpc("initialize", {"clientInfo": {"name": "bb_voice_mode", "version": "1"}, "capabilities": {"experimentalApi": True}})
            write({"method": "initialized"})
            thread = await rpc("thread/start", {"cwd": cwd, "ephemeral": True, "approvalPolicy": "never",
                "sandbox": "read-only", "environments": [], "baseInstructions": "BB handles every voice task. Do not run tools or perform work."})
            tid = thread["thread"]["id"]
            await pc.setLocalDescription(await pc.createOffer())
            await rpc("thread/realtime/start", {"threadId": tid, "model": MODEL, "version": "v3",
                "outputModality": "audio", "transport": {"type": "webrtc", "sdp": pc.localDescription.sdp},
                "voice": cfg["audio"]["output"]["voice"], "prompt": cfg["instructions"], "includeStartupContext": False,
                "clientManagedHandoffs": True, "realtimeStartInstructions": "BB owns all delegated work. Do not act or use tools."})
            spawn(incoming())
            await done.wait()
        finally:
            done.set()
            if process and tid and process.returncode is None:
                try:
                    await asyncio.wait_for(rpc("thread/realtime/stop", {"threadId": tid}), 1)
                except (Exception, asyncio.CancelledError):
                    pass
            await pc.close()
            for task in list(tasks):
                task.cancel()
            if process and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 2)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()


if __name__ == "__main__":
    if sys.argv[1:] == ["--install"]:
        install()
    else:
        asyncio.run(run())
