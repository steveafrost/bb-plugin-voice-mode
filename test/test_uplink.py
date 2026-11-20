"""Mic backlog and output tagging in the Codex Live bridge. Plain Python, no aiortc.

Run: python3 -m unittest discover -s test -p 'test_*.py'
"""
import array
import base64
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("codex_voice", Path(__file__).resolve().parents[1] / "codex_voice.py")
codex_voice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(codex_voice)
Uplink, Downlink, FRAME = codex_voice.Uplink, codex_voice.Downlink, codex_voice.FRAME_BYTES

CHUNK = 2048  # the browser's 1024-sample chunk


def tagged(index, samples=1024, level=8000):
    """PCM whose first sample encodes its chunk index, so latency can be read back."""
    pcm = array.array("h", [level] * samples)
    pcm[0] = 1000 + index
    return pcm.tobytes()


def simulate(arrivals, duration_ms, make=tagged):
    """arrivals: list of (time_ms, chunk_index). Returns per-pull (time_ms, latency_ms or None), and the uplink."""
    up = Uplink()
    sent_at = {}
    result = []
    events = sorted(arrivals)
    e = 0
    # Each chunk index i nominally starts at i * 1024 / 24 ms.
    for pull in range(duration_ms // 20):
        t = pull * 20
        while e < len(events) and events[e][0] <= t:
            at, index = events[e]
            sent_at[index] = index * 1024 / 24
            up.push(make(index))
            e += 1
        frame = array.array("h", up.pull())
        latency = None
        for k in range(0, len(frame)):
            if 1000 <= frame[k] < 9000 and frame[k] != 8000:
                index = frame[k] - 1000
                latency = t + k / 24 - sent_at[index]
                break
        result.append((t, latency))
    return result, up


def steady(n, delay=lambda i: 0):
    out, last = [], 0
    for i in range(n):
        last = max(last, i * 1024 / 24 + delay(i))
        out.append((last, i))
    return out


class UplinkTest(unittest.TestCase):
    def test_steady_browser_chunks_have_no_holes_and_low_latency(self):
        result, up = simulate(steady(200), 8000)
        latencies = [l for _, l in result if l is not None]
        self.assertEqual(up.holes, 0)
        self.assertLess(max(latencies), 110)

    def test_latency_recovers_after_a_one_second_stall(self):
        # Chunk 50 is held for 1 s; the WebSocket is ordered, so the next second
        # of chunks arrives behind it and then all at once (~4.1 s).
        arrivals = steady(300, lambda i: 1000 if i == 50 else 0)
        result, up = simulate(arrivals, 13000)
        late = [l for t, l in result if l is not None and t > 4800]
        self.assertTrue(late)
        self.assertLess(max(late), 130)
        self.assertGreater(up.dropped, 0)

    def test_a_burst_never_builds_more_than_the_limit(self):
        up = Uplink()
        for i in range(30):
            up.push(tagged(i))
            self.assertLessEqual(len(up.buf), Uplink.LIMIT)

    def test_drops_silent_frames_before_speech(self):
        speech = array.array("h", [6000] * 480).tobytes()
        silence = bytes(FRAME)
        up = Uplink()
        for i in range(13):
            up.push(silence if i in (3, 6, 9) else speech)
        # 13 frames exceed LIMIT (12): the cut to TARGET removes the silent frames first.
        kept = [up.buf[i:i + FRAME] for i in range(0, len(up.buf), FRAME)]
        self.assertEqual(len(up.buf), Uplink.TARGET)
        self.assertTrue(all(f == speech for f in kept))

    def test_waits_for_a_cushion_after_running_dry(self):
        up = Uplink()
        up.push(bytes([1, 0]) * 480)
        self.assertEqual(up.pull(), bytes(FRAME))  # 20 ms is below the 60 ms cushion
        up.push(bytes([1, 0]) * 960)
        self.assertNotEqual(up.pull(), bytes(FRAME))


class DownlinkTest(unittest.TestCase):
    def test_tags_frames_and_marks_silence_once(self):
        down = Downlink()
        loud = array.array("h", [3000] * 480).tobytes()
        quiet = array.array("h", [3] * 480).tobytes()
        events = [down.frame(f) for f in (quiet, loud, loud, quiet, quiet, loud)]
        self.assertIsNone(events[0])
        self.assertEqual(events[1]["pts"], 480)
        self.assertEqual(base64.b64decode(events[1]["delta"]), loud)
        self.assertEqual(events[2]["pts"], 960)
        self.assertEqual(events[3], {"delta": "", "pts": 1440})
        self.assertIsNone(events[4])
        self.assertEqual(events[5]["pts"], 2400)

    def test_missing_input_frames_advance_the_clock(self):
        down = Downlink()
        down.gap(0, 960, 48000)
        down.frame(bytes(960))
        down.gap(960 + 4 * 960, 960, 48000)  # four 20 ms frames never arrived
        self.assertEqual(down.pts, 480 + 4 * 480)


if __name__ == "__main__":
    unittest.main()
