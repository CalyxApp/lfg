// earcons.ts — tiny synthesized audio cues for Converse voice mode (no assets).
//
// Sam: in voice mode you need to *hear* what's happening, not just read it — the
// session opens in silence so you don't know it's listening, and there's no signal
// while the agent is off running a tool. These cues cover that. Every tone is
// generated live with an OscillatorNode through one shared AudioContext, kept quiet
// and short so it sits under the assistant's voice. Muteable + persisted.
//
// AudioContext must be unlocked by a user gesture (iOS/Safari) — primeAudio() is
// called when the user taps into voice mode, which is exactly such a gesture.

const MUTE_KEY = "converse_sounds_muted";

let ctx: AudioContext | null = null;
let muted = readMuted();
let workingTimer: ReturnType<typeof setInterval> | null = null;
let workingDepth = 0; // ref-count so overlapping tool calls share one loop

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function areSoundsMuted(): boolean {
  return muted;
}

export function setSoundsMuted(v: boolean): void {
  muted = v;
  try {
    localStorage.setItem(MUTE_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (v && workingTimer) {
    clearInterval(workingTimer);
    workingTimer = null;
  }
}

function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

// One short tone: `freq` Hz for `dur`s, peaking at `peak`, starting `startIn`s out.
function blip(freq: number, startIn: number, dur: number, peak = 0.12, type: OscillatorType = "sine"): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + startIn;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Unlock/resume audio on a user gesture (called when entering voice mode). */
export function primeAudio(): void {
  ac();
}

/** Session live / "you can start talking" — soft rising two-note chime. */
export function playReady(): void {
  if (muted) return;
  blip(587.33, 0, 0.16, 0.11); // D5
  blip(880.0, 0.14, 0.22, 0.11); // A5
}

/** Gentle descending low tone on error / disconnect. */
export function playError(): void {
  if (muted) return;
  blip(311.13, 0, 0.26, 0.12); // Eb4
  blip(233.08, 0.18, 0.34, 0.12); // Bb3
}

/** Begin a subtle "working" pulse while a tool call runs. Ref-counted: each
 *  startWorking() must be balanced by a stopWorking(); overlapping calls share
 *  one quiet heartbeat rather than stacking. */
export function startWorking(): void {
  workingDepth++;
  if (muted || workingTimer) return;
  const pulse = () => blip(440, 0, 0.09, 0.05);
  pulse();
  workingTimer = setInterval(pulse, 1400);
}

export function stopWorking(): void {
  workingDepth = Math.max(0, workingDepth - 1);
  if (workingDepth > 0) return;
  if (workingTimer) {
    clearInterval(workingTimer);
    workingTimer = null;
  }
}
