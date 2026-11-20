// Adaptive playout buffer for the assistant's voice.
//
// The browser receives 20 ms PCM frames over a relayed WebSocket, so arrival
// times wobble while the audio itself is continuous. This buffer plays one
// continuous stream at the audio clock and keeps the time between pauses:
//
// - Frames carry `pts`, their position in the sender's media clock (samples).
//   Transit = arrival - pts; the worst lateness over the last 30 s sets the
//   target delay (60-500 ms; 150 ms until two seconds are observed).
//   Without pts (the OpenAI Realtime route, which sends faster than real time) frames are appended back to back and every talk
//   spurt starts after a fixed 140 ms, as before.
// - `end(pts)` marks where the sender stopped sending a silent stretch. Reaching
//   it is a pause, not an underrun. The next spurt starts at its natural time
//   when that leaves the target delay; otherwise the pause is lengthened (more
//   jitter) or shortened (catch-up after a stall). Pauses are where timing may
//   change without being heard.
// - Running dry inside a spurt is an underrun: fade out, wait until the target
//   is buffered again, fade in.
//
// All times are in samples of the playout clock. The class must stay
// self-contained: audio.ts loads its source text into an AudioWorklet.
export class JitterBuffer {
  rate: number;
  minTarget: number;
  maxTarget: number;
  margin: number;
  fixedStart: number;
  fade: number;
  minPause: number;
  maxStall: number;
  maxBacklog: number;
  // Queue of data frames {pts, d, a (arrival)} and pause markers {pts, d: null}.
  q: { pts: number; d: Float32Array | null; a: number }[] = [];
  qo = 0;
  // 0 idle/pause, 1 waiting for a scheduled start, 2 playing, 3 underrun.
  state = 0;
  startAt = -1;
  readPts = 0;
  lastEnd: number | null = null;
  pauseAt = -1;
  pausePts = 0;
  stallAt = 0;
  stallArrival = -1;
  ptsMode: boolean | null = null;
  fadeIn = false;
  target: number;
  bucketAt = -1;
  bucketMin = Infinity;
  bucketMax = -Infinity;
  mins: number[] = [];
  maxs: number[] = [];
  level = 0;
  stats = { underruns: 0, stalled: 0, late: 0, trimmed: 0, spurts: 0, pauseShift: 0, flushes: 0 };

  constructor(rate: number) {
    this.rate = rate;
    this.minTarget = Math.round(0.06 * rate);
    this.maxTarget = Math.round(0.5 * rate);
    this.margin = Math.round(0.02 * rate) + 128;
    this.fixedStart = Math.round(0.14 * rate);
    this.fade = Math.round(0.003 * rate);
    this.minPause = Math.round(0.08 * rate);
    this.maxStall = Math.round(1.5 * rate);
    this.maxBacklog = Math.round(1.5 * rate);
    this.target = Math.round(0.15 * rate);
  }

  /** Base transit (lowest seen recently) and the resulting target delay. */
  observe(transit: number, now: number) {
    if (this.bucketAt < 0) this.bucketAt = now;
    if (now - this.bucketAt >= this.rate) {
      // One-second buckets: the base (lowest transit) over 10 s follows slow
      // clock drift; the worst lateness is remembered for 30 s, because a
      // mobile link that spiked once tends to spike again.
      this.maxs.push(this.bucketMax - this.base());
      this.mins.push(this.bucketMin);
      if (this.mins.length > 10) this.mins.shift();
      if (this.maxs.length > 30) this.maxs.shift();
      this.bucketAt = now;
      this.bucketMin = Infinity;
      this.bucketMax = -Infinity;
    }
    this.bucketMin = Math.min(this.bucketMin, transit);
    this.bucketMax = Math.max(this.bucketMax, transit);
    const spread = Math.max(this.bucketMax - this.base(), ...this.maxs);
    // Until two seconds are observed, keep a moderate start-up reserve.
    const floor = this.maxs.length < 2 ? Math.round(0.15 * this.rate) : this.minTarget;
    this.target = Math.min(this.maxTarget, Math.max(floor, Math.round(spread + this.margin)));
  }

  base() {
    return Math.min(this.bucketMin, ...this.mins);
  }

  buffered() {
    let n = -this.qo;
    for (const item of this.q) {
      if (!item.d) break;
      n += item.d.length;
    }
    return Math.max(0, n);
  }

  push(data: Float32Array, pts: number | null, now: number) {
    if (this.ptsMode === null) this.ptsMode = pts !== null;
    if (pts === null || !this.ptsMode) pts = this.lastEnd ?? 0;
    else this.observe(now - pts, now);
    // Drop what is already behind the playhead or duplicates queued audio.
    const floor = this.state === 2 || this.state === 3 ? Math.max(this.readPts, this.lastEnd ?? -Infinity) : (this.lastEnd ?? -Infinity);
    if (pts < floor) {
      const cut = floor - pts;
      if (cut >= data.length) {
        this.stats.late++;
        return;
      }
      data = data.subarray(cut);
      pts = floor;
    }
    this.q.push({ pts, d: data, a: now });
    this.lastEnd = pts + data.length;
    if (this.state === 3 && this.stallArrival < 0) this.stallArrival = now;
    if (this.state === 0 && this.q.length === 1) this.schedule(now);
  }

  /** The sender stopped at `pts` because the rest is silence. */
  end(pts: number, now: number) {
    if (this.ptsMode === false) return;
    if (this.lastEnd !== null && pts < this.lastEnd) pts = this.lastEnd;
    this.q.push({ pts, d: null, a: now });
    this.lastEnd = pts;
  }

  /** Drop everything queued (barge-in). Fades out within a few ms. */
  flush() {
    // Keep only a few milliseconds, faded to zero, so the cut does not click.
    const tail = new Float32Array(this.fade);
    let k = 0;
    if (this.state === 2) {
      let qo = this.qo;
      for (const item of this.q) {
        if (!item.d || item.pts + qo !== this.readPts + k) break;
        while (k < tail.length && qo < item.d.length) tail[k++] = item.d[qo++];
        if (k >= tail.length) break;
        qo = 0;
      }
    }
    this.q = [];
    this.qo = 0;
    this.lastEnd = null;
    this.pauseAt = -1;
    this.stats.flushes++;
    if (k > 0) {
      for (let j = 0; j < k; j++) tail[j] *= (k - j - 1) / k;
      this.q.push({ pts: this.readPts, d: tail.subarray(0, k), a: 0 }, { pts: this.readPts + k, d: null, a: 0 });
      this.lastEnd = this.readPts + k;
    } else this.state = 0;
  }

  /** Choose when the first queued frame of a new talk spurt plays. */
  schedule(now: number) {
    const first = this.q[0];
    if (!first || !first.d) return;
    let start: number;
    if (this.ptsMode) {
      const wanted = Math.max(now, first.pts + this.base() + this.target);
      if (this.pauseAt >= 0) {
        const natural = this.pauseAt + (first.pts - this.pausePts);
        const shortest = this.pauseAt + Math.min(Math.max(0, natural - this.pauseAt), this.minPause);
        start = natural < wanted ? wanted : Math.max(shortest, Math.min(natural, wanted));
        this.stats.pauseShift += start - natural;
      } else start = wanted;
    } else start = Math.max(now, first.a + this.fixedStart);
    this.startAt = Math.max(now, start);
    this.readPts = first.pts;
    this.state = 1;
    this.stats.spurts++;
  }

  render(out: Float32Array, now: number) {
    const n = out.length;
    let i = 0;
    let wrote = -1;
    while (i < n) {
      const t = now + i;
      if (this.state === 0) {
        while (this.q.length && !this.q[0].d) this.q.shift();
        if (this.q.length) {
          this.schedule(t);
          continue;
        }
        out.fill(0, i);
        break;
      }
      if (this.state === 1) {
        if (t >= this.startAt) {
          this.state = 2;
          this.fadeIn = true;
          continue;
        }
        const k = Math.min(n - i, Math.ceil(this.startAt - t));
        out.fill(0, i, i + k);
        i += k;
        continue;
      }
      if (this.state === 3) {
        const ready = this.buffered();
        const marker = this.q.some(item => !item.d);
        const need = this.ptsMode ? this.target : this.fixedStart;
        const waited = this.stallArrival >= 0 && t - this.stallArrival >= need;
        if (ready >= need || marker || waited) {
          this.state = 2;
          this.fadeIn = true;
          continue;
        }
        if (t - this.stallAt > this.maxStall) {
          // Nothing more is coming: the reply ended without a marker.
          this.state = 0;
          this.pauseAt = -1;
          continue;
        }
        out.fill(0, i);
        this.stats.stalled += n - i;
        break;
      }
      // Playing.
      const item = this.q[0];
      if (!item) {
        if (wrote > 0) {
          const f = Math.min(this.fade, wrote);
          for (let j = 0; j < f; j++) out[wrote - f + j] *= (f - j - 1) / f;
        }
        this.state = 3;
        this.stallAt = t;
        this.stallArrival = -1;
        this.stats.underruns++;
        continue;
      }
      if (!item.d) {
        this.q.shift();
        this.state = 0;
        this.pauseAt = t;
        this.pausePts = item.pts;
        continue;
      }
      const at = item.pts + this.qo;
      if (at < this.readPts) {
        this.qo = Math.min(item.d.length, this.qo + this.readPts - at);
        if (this.qo >= item.d.length) {
          this.q.shift();
          this.qo = 0;
        }
        continue;
      }
      if (at > this.readPts) {
        // A gap the sender did not mark: it skipped silent frames.
        const k = Math.min(n - i, at - this.readPts);
        out.fill(0, i, i + k);
        this.readPts += k;
        i += k;
        continue;
      }
      const k = Math.min(n - i, item.d.length - this.qo);
      out.set(item.d.subarray(this.qo, this.qo + k), i);
      if (this.fadeIn) {
        const f = Math.min(this.fade, k);
        for (let j = 0; j < f; j++) out[i + j] *= j / f;
        this.fadeIn = false;
      }
      this.qo += k;
      this.readPts += k;
      i += k;
      wrote = i;
      if (this.qo >= item.d.length) {
        this.q.shift();
        this.qo = 0;
      }
    }
    // About to run dry inside a spurt: fade the tail instead of clicking.
    if (this.state === 2 && wrote > 0 && !this.q.length) {
      const f = Math.min(this.fade, wrote);
      for (let j = 0; j < f; j++) out[wrote - f + j] *= (f - j - 1) / f;
      this.fadeIn = true;
    }
    if (this.ptsMode && this.state === 2) this.trim();
    let energy = 0;
    for (let j = 0; j < n; j++) energy += out[j] * out[j];
    this.level = Math.sqrt(energy / n);
  }

  /** A backlog far above target inside one spurt: drop the oldest audio. */
  trim() {
    const excess = this.buffered() - this.target - this.maxBacklog;
    if (excess <= 0) return;
    let drop = excess + this.maxBacklog;
    while (drop > 0 && this.q.length && this.q[0].d) {
      const item = this.q[0];
      const k = Math.min(drop, item.d!.length - this.qo);
      this.qo += k;
      this.readPts += k;
      drop -= k;
      this.stats.trimmed += k;
      if (this.qo >= item.d!.length) {
        this.q.shift();
        this.qo = 0;
      }
    }
    this.fadeIn = true;
  }
}
