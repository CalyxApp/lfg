// Dictation — the push-to-talk mic stack, extracted verbatim from App.tsx so
// sibling views (CaptureView) can reuse it without importing the app shell:
//   • useDictation()        — mic capture → realtime STT bridge (+ batch fallback)
//   • MicButton             — tap-to-dictate / hold-to-talk / slide-to-cancel
//   • recordingButtonStyle  — audio-reactive glow, shared with the orb's PTT
// Behavior must stay identical for the existing App.tsx call sites; change it
// here and every mic surface changes together.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Loader2, Mic, X } from "lucide-react";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";


// Encode captured PCM (Float32) as a 16-bit mono WAV — the format the server's
// /api/voice/stt (faster-whisper) accepts. We capture raw PCM via the Web Audio
// API rather than MediaRecorder because MediaRecorder emits webm/opus (Chrome)
// or mp4/aac (iOS Safari), neither of which the upstream takes; PCM→WAV is the
// one path that works the same on every browser, iOS included.
function floatToWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, v * 32767, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "application/octet-stream" });
}

// Resample a Float32 PCM window (captured at the AudioContext's native rate) to
// the 16 kHz mono signed-16-bit PCM the realtime-STT bridge expects, returning a
// fresh ArrayBuffer ready to ship as a binary WS frame. We request a 16 kHz
// context up front (so this is usually a straight float→int16 cast), but some
// browsers — iOS Safari especially — ignore the requested rate and hand back
// 44.1/48 kHz, so we linear-interpolate down when the rates differ. int16 frames
// are little-endian on every browser we target, which is what the upstream wants.
function pcm16kFrom(samples: Float32Array, inRate: number): ArrayBuffer {
  const clamp = (s: number) => {
    const v = Math.max(-1, Math.min(1, s));
    return v < 0 ? v * 32768 : v * 32767;
  };
  if (inRate === 16000) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = clamp(samples[i]);
    return out.buffer;
  }
  const ratio = inRate / 16000;
  const outLen = Math.max(0, Math.floor(samples.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = idx - i0;
    out[i] = clamp(samples[i0] * (1 - frac) + samples[i1] * frac);
  }
  return out.buffer;
}

// Join the finalized + in-flight halves of a streaming transcript into the one
// string the input should show. Both halves are trimmed and empties dropped so a
// trailing space or a not-yet-started partial never leaks into the field.
function joinTranscript(committed: string, partial: string): string {
  return [committed, partial]
    .map((t) => t.trim())
    .filter(Boolean)
    .join(" ");
}

type DictationState = "idle" | "recording" | "transcribing";

// RMS below this on a 4096-sample window counts as silence. Speech sits well
// above (~0.05–0.2); room tone / mic hiss sits below. Fixed rather than
// adaptive — good enough to tell "talking" from "stopped" for end-of-turn.
const VOICE_RMS_THRESHOLD = 0.01;

// Visual reactivity tuning for the recording button. We already compute the
// per-frame RMS for voice detection; we reuse it to drive a live 0..1 "level"
// that the button glows / scales against. No external audio library needed —
// the Web Audio data is right here, and a viz lib would fight the custom PCM
// pipeline below.
// LEVEL_FULL_SCALE: RMS that maps to a full-intensity (1.0) reaction. Normal
// talking sits ~0.05–0.2, so this lets ordinary speech fill most of the range
// and a raised voice tops it out.
const LEVEL_FULL_SCALE = 0.22;
// Envelope follower: snap up fast on a vocal attack (tracks velocity — sudden
// loudness punches through immediately), ease down slowly so the button glides
// back rather than strobing on every syllable gap.
const LEVEL_ATTACK = 0.55;
const LEVEL_RELEASE = 0.1;

export function recordingButtonStyle(level: number): CSSProperties {
  // A held thumb covers the center of a 36-44px button, so the recording state
  // needs a fixed growth floor before the audio-reactive pulse is visible.
  const scale = 1.34 + level * 0.16;
  const glow = 16 + level * 26;
  const spread = 4 + level * 8;
  const opacity = Math.round(45 + level * 45);
  return {
    transform: `scale(${scale.toFixed(3)})`,
    boxShadow: `0 0 0 5px color-mix(in srgb, var(--destructive) 22%, transparent), 0 0 ${glow.toFixed(
      1,
    )}px ${spread.toFixed(1)}px color-mix(in srgb, var(--destructive) ${opacity}%, transparent)`,
    transition: "transform 80ms linear, box-shadow 80ms linear",
  };
}

// How long to keep the mic stream open (track disabled, not stopped) after a
// take ends before fully releasing it. Long enough that back-to-back dictation
// reuses a single grant — avoiding the repeat permission prompt an installed PWA
// (iOS standalone especially) shows on each fresh getUserMedia after a full
// track.stop() — short enough that we don't sit on the mic indicator forever.
const MIC_IDLE_RELEASE_MS = 60_000;

// Push-to-talk dictation with optional hands-free auto-send. Tap to record, tap
// to stop. Audio streams live to the server's realtime-STT bridge
// (/api/voice/stt-stream → ElevenLabs Scribe v2 Realtime): we capture mic PCM,
// resample to 16 kHz mono int16, and push it as binary WS frames. The bridge
// streams back {type:"partial"} (live interim) and {type:"final"} (committed)
// transcripts — so `onInterim` now reflects the upstream's own running
// hypothesis instead of a re-POST poll, and the final arrives ~150 ms after you
// stop instead of after a whole-clip round trip.
// `onText` receives the transcript on a manual stop (fill the input, let the
// user edit/send). When `onAutoSubmit` is supplied we also run voice-activity
// detection: once speech has been heard, `silenceMs` of quiet auto-stops the
// recording and routes the transcript to `onAutoSubmit` instead — fully
// hands-free (speak, pause, it sends).
// We keep the raw captured PCM as a fallback: if the realtime socket never
// connects (e.g. ELEVENLABS_API_KEY unset → the bridge closes us) or yields no
// text, stop() POSTs the buffered clip to the batch /api/voice/stt endpoint so
// dictation degrades gracefully rather than silently dropping the utterance.
export function useDictation(opts: {
  onText: (text: string, base: string) => void;
  onAutoSubmit?: (text: string, base: string) => void;
  // Called repeatedly during recording with the best-guess transcript so far.
  // `base` is the input text captured when recording began, so the live partial
  // and the eventual final result compose against the same anchor.
  onInterim?: (text: string, base: string) => void;
  // Called when the user dismisses an in-progress recording (mic picked up
  // nothing usable, wrong words, etc.) instead of stopping it normally. `base`
  // is the pre-recording text, so the caller can restore the field to exactly
  // what it looked like before dictation started — wiping out any garbled
  // interim transcript that streamed in via onInterim.
  onCancel?: (base: string) => void;
  baseText?: string;
  silenceMs?: number;
  // Review-before-send (unified-chat-and-voice Phase 1): when true, tap-mode
  // dictation never auto-submits — the silence VAD is disabled (the take runs
  // until the user acts) and tapping stop routes the transcript through onText
  // as editable input instead of onAutoSubmit. Press-and-hold release-to-send
  // (an explicit stop(true)) still auto-submits, so both affordances survive:
  // tap = speak → review → send yourself; hold = speak → release sends.
  reviewOnStop?: boolean;
}) {
  const [state, setState] = useState<DictationState>("idle");
  // Live 0..1 microphone level, smoothed by an envelope follower. Drives the
  // recording button's glow + scale so it reacts to volume and velocity.
  const [level, setLevel] = useState(0);
  const rawLevelRef = useRef(0); // latest raw RMS written by onaudioprocess
  const levelSmoothRef = useRef(0); // envelope-smoothed value the rAF loop emits
  const rafRef = useRef<number | null>(null);
  const sessionRef = useRef<{
    ac: AudioContext;
    stream: MediaStream;
    proc: ScriptProcessorNode;
    src: MediaStreamAudioSourceNode;
    chunks: Float32Array[]; // native-rate capture, kept only for batch fallback
    rate: number; // native AudioContext sample rate
    vad: number | null;
    // Realtime-STT socket and its running transcript. `committed` is the text the
    // bridge has finalized; `partial` is the live hypothesis for audio not yet
    // committed; their join is what the input shows. `pending` holds resampled
    // frames captured before the socket finished opening (flushed on "open").
    // `broken` flips if the socket errors/closes early so stop() batch-falls-back.
    ws: WebSocket | null;
    pending: ArrayBuffer[];
    committed: string;
    partial: string;
    broken: boolean;
    // Resolvers waiting for the next "final" frame — settled by the flush we send
    // on stop, so we hand back the committed tail instead of a clipped partial.
    finalWaiters: Array<() => void>;
  } | null>(null);

  // start() is async — the mic/socket aren't live until getUserMedia resolves and
  // sessionRef is assigned. `startingRef` marks that window; if a release fires
  // stop() inside it, `pendingStopRef` records the requested stop so start() can
  // honor it the instant the session exists. Without this, a quick release loses
  // the take (stop sees a null session and bails) AND leaks a live recording.
  const startingRef = useRef(false);
  const pendingStopRef = useRef<{ auto: boolean; discard: boolean } | null>(null);

  // A single mic MediaStream is acquired lazily and then KEPT ALIVE across takes
  // rather than being stopped after each one. Re-running getUserMedia after a
  // full track.stop() re-triggers the browser's permission gate in an installed
  // PWA (iOS standalone doesn't persist the grant across released streams), so
  // repeated dictation used to re-prompt every take. We hold the track, disable
  // it while idle, and only fully release after a spell of inactivity (or on
  // unmount) — so tap→tap→tap reuses one grant.
  const streamRef = useRef<MediaStream | null>(null);
  const idleReleaseRef = useRef<number | null>(null);
  const releaseStream = useCallback(() => {
    if (idleReleaseRef.current !== null) {
      clearTimeout(idleReleaseRef.current);
      idleReleaseRef.current = null;
    }
    const s = streamRef.current;
    streamRef.current = null;
    s?.getTracks().forEach((t) => t.stop());
  }, []);

  // Keep the callbacks in refs so the VAD interval / stop always see the latest
  // handlers without needing to tear down and recreate the audio session.
  const onTextRef = useRef(opts.onText);
  const onAutoSubmitRef = useRef(opts.onAutoSubmit);
  const onInterimRef = useRef(opts.onInterim);
  const onCancelRef = useRef(opts.onCancel);
  const reviewOnStopRef = useRef(opts.reviewOnStop ?? false);
  const baseTextRef = useRef(opts.baseText ?? "");
  // Base text snapshotted at record-start, shared by interim + final so the
  // final transcript cleanly replaces the live partial without double-appending.
  const capturedBaseRef = useRef("");
  const silenceMs = opts.silenceMs ?? 2500;
  onTextRef.current = opts.onText;
  onAutoSubmitRef.current = opts.onAutoSubmit;
  onInterimRef.current = opts.onInterim;
  onCancelRef.current = opts.onCancel;
  reviewOnStopRef.current = opts.reviewOnStop ?? false;
  baseTextRef.current = opts.baseText ?? "";

  const supported =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  // `auto` distinguishes a silence-triggered stop (→ onAutoSubmit) from a manual
  // tap (→ onText). `discard` tears the session down without transcribing — used
  // by the press-and-hold FAB's slide-up-to-cancel gesture, where we drop the
  // audio entirely rather than spend a round trip on a transcript we'd throw away.
  // Idempotent: clears sessionRef first so a late VAD tick or a double-tap can't
  // run the teardown twice.
  const stop = useCallback(
    async (auto = false, discard = false) => {
      const s = sessionRef.current;
      sessionRef.current = null;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      rawLevelRef.current = 0;
      levelSmoothRef.current = 0;
      setLevel(0);
      if (!s) {
        // No live session yet. If start() is still acquiring the mic, this is a
        // release that beat initialization — record the request so start() tears
        // down (and submits) the moment the session is ready instead of leaking it.
        if (startingRef.current) pendingStopRef.current = { auto, discard };
        setState("idle");
        return;
      }
      if (s.vad !== null) clearInterval(s.vad);
      // Stop feeding the mic first so no frame races the flush/close below.
      s.proc.disconnect();
      s.src.disconnect();
      // Keep the mic track alive but silenced so the next take reuses this grant
      // instead of re-prompting; an idle timeout (or unmount) fully releases it.
      s.stream.getAudioTracks().forEach((t) => (t.enabled = false));
      if (idleReleaseRef.current !== null) clearTimeout(idleReleaseRef.current);
      idleReleaseRef.current = setTimeout(releaseStream, MIC_IDLE_RELEASE_MS) as unknown as number;
      await s.ac.close().catch(() => {});
      const closeWs = () => {
        try {
          s.ws?.close();
        } catch {
          /* already closing */
        }
      };
      if (discard) {
        closeWs();
        setState("idle");
        onCancelRef.current?.(capturedBaseRef.current);
        return;
      }
      const deliver = (text: string) => {
        const t = text.trim();
        if (!t) return;
        const base = capturedBaseRef.current;
        if (auto && onAutoSubmitRef.current) onAutoSubmitRef.current(t, base);
        else onTextRef.current(t, base);
      };

      setState("transcribing");

      // Primary path: ask the realtime bridge to commit the trailing audio, wait
      // briefly for the final segment, then deliver the joined transcript. We
      // resolve on the first `final` frame OR a timeout so a missing commit can't
      // hang the button in "transcribing".
      if (s.ws && s.ws.readyState === WebSocket.OPEN && !s.broken) {
        try {
          s.ws.send(JSON.stringify({ type: "flush" }));
        } catch {
          s.broken = true;
        }
        if (!s.broken) {
          await new Promise<void>((resolve) => {
            let done = false;
            const fin = () => {
              if (done) return;
              done = true;
              resolve();
            };
            s.finalWaiters.push(fin);
            setTimeout(fin, 1800);
          });
        }
      }

      const streamed = joinTranscript(s.committed, s.partial);
      closeWs();

      if (streamed && !s.broken) {
        deliver(streamed);
        setState("idle");
        return;
      }

      // Fallback: the realtime socket never connected (e.g. ELEVENLABS_API_KEY
      // unset → bridge closed us) or yielded nothing. POST the buffered clip to
      // the batch endpoint so the utterance isn't silently dropped.
      const total = s.chunks.reduce((n, c) => n + c.length, 0);
      if (!total) {
        if (streamed) deliver(streamed);
        setState("idle");
        return;
      }
      const merged = new Float32Array(total);
      let offset = 0;
      for (const c of s.chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      try {
        const res = await fetch("/api/voice/stt", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: floatToWav(merged, s.rate),
        });
        const data = (await res.json().catch(() => ({}))) as { text?: string };
        const text = (data.text || "").trim();
        if (res.ok && text) deliver(text);
        else if (streamed) deliver(streamed);
      } catch {
        // Batch also failed — fall back to whatever the stream gave us, if any.
        if (streamed) deliver(streamed);
      }
      setState("idle");
    },
    [releaseStream],
  );

  // `autoStop` (default true) wires the silence-VAD that auto-submits after a
  // pause — the tap-to-dictate behavior. Press-and-hold passes false: the user
  // controls the take by holding, so a mid-utterance pause must not cut it off;
  // release is the only thing that stops + sends.
  const start = useCallback(async (startOpts?: { autoStop?: boolean }) => {
    const autoStop = startOpts?.autoStop ?? true;
    if (sessionRef.current || startingRef.current) return;
    startingRef.current = true;
    pendingStopRef.current = null;
    capturedBaseRef.current = baseTextRef.current;
    try {
      // A new take cancels any pending idle-release so we keep the same grant.
      if (idleReleaseRef.current !== null) {
        clearTimeout(idleReleaseRef.current);
        idleReleaseRef.current = null;
      }
      // Reuse the held stream when its track is still live; only hit getUserMedia
      // (the permission gate) when we have no usable stream. Re-enable the track,
      // which stop() disabled while idle.
      let stream = streamRef.current;
      if (!stream || !stream.getAudioTracks().some((t) => t.readyState === "live")) {
        stream?.getTracks().forEach((t) => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
      }
      stream.getAudioTracks().forEach((t) => (t.enabled = true));
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      // Ask for a 16 kHz context so capture matches the bridge's expected rate
      // and pcm16kFrom is a straight cast. Browsers that refuse the hint hand
      // back their native rate, which the resampler handles.
      let ac: AudioContext;
      try {
        ac = new Ctor({ sampleRate: 16000 });
      } catch {
        ac = new Ctor();
      }
      const src = ac.createMediaStreamSource(stream);
      const proc = ac.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];

      // Realtime-STT socket: stream resampled PCM up, receive {partial,final}
      // transcripts back. Built before capture starts so the first frame has
      // somewhere to go (queued in `pending` until the socket opens).
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      let ws: WebSocket | null = null;
      try {
        ws = new WebSocket(`${proto}//${location.host}/api/voice/stt-stream`);
        ws.binaryType = "arraybuffer";
      } catch {
        ws = null;
      }
      if (ws) {
        ws.onopen = () => {
          const s = sessionRef.current;
          if (!s || s.ws !== ws) return;
          for (const frame of s.pending) {
            try {
              ws!.send(frame);
            } catch {
              s.broken = true;
            }
          }
          s.pending = [];
        };
        ws.onmessage = (ev) => {
          const s = sessionRef.current;
          if (!s || s.ws !== ws) return;
          let d: { type?: string; text?: string };
          try {
            d = JSON.parse(typeof ev.data === "string" ? ev.data : "");
          } catch {
            return;
          }
          if (d.type === "partial") {
            s.partial = (d.text || "").trim();
          } else if (d.type === "final") {
            // Fold the committed segment in and clear the live hypothesis; settle
            // any flush waiting on this final.
            s.committed = joinTranscript(s.committed, d.text || "");
            s.partial = "";
            const waiters = s.finalWaiters;
            s.finalWaiters = [];
            for (const w of waiters) w();
          } else {
            return;
          }
          onInterimRef.current?.(joinTranscript(s.committed, s.partial), capturedBaseRef.current);
        };
        ws.onerror = () => {
          const s = sessionRef.current;
          if (s && s.ws === ws) s.broken = true;
        };
        ws.onclose = () => {
          const s = sessionRef.current;
          if (!s || s.ws !== ws) return;
          // A close before we've delivered anything means the bridge rejected us
          // (provider unconfigured) — mark broken so stop() batch-falls-back, and
          // release any pending flush so the button doesn't hang.
          if (!s.committed && !s.partial) s.broken = true;
          const waiters = s.finalWaiters;
          s.finalWaiters = [];
          for (const w of waiters) w();
        };
      }

      // VAD state: `spoke` gates auto-stop so silence before the first word
      // never fires; `lastVoiceAt` is the clock the silence window runs against.
      let spoke = false;
      let lastVoiceAt = Date.now();
      proc.onaudioprocess = (e) => {
        const buf = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(buf));
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        // Feed the live meter every frame (cheap ref write; the rAF loop reads
        // and smooths it). Kept separate from the auto-submit gate below.
        rawLevelRef.current = rms;
        // Ship this window to the realtime bridge as 16 kHz int16 PCM. Queue it
        // if the socket is still opening; drop silently once it's broken.
        const s = sessionRef.current;
        if (s && s.ws && !s.broken) {
          const frame = pcm16kFrom(buf, s.rate);
          if (s.ws.readyState === WebSocket.OPEN) {
            try {
              s.ws.send(frame);
            } catch {
              s.broken = true;
            }
          } else if (s.ws.readyState === WebSocket.CONNECTING) {
            s.pending.push(frame);
          }
        }
        if (!onAutoSubmitRef.current) return;
        if (rms > VOICE_RMS_THRESHOLD) {
          spoke = true;
          lastVoiceAt = Date.now();
        }
      };
      const vad =
        autoStop && onAutoSubmitRef.current && !reviewOnStopRef.current
          ? (setInterval(() => {
              if (!sessionRef.current || !spoke) return;
              if (Date.now() - lastVoiceAt >= silenceMs) void stop(true);
            }, 200) as unknown as number)
          : null;
      sessionRef.current = {
        ac,
        stream,
        proc,
        src,
        chunks,
        rate: ac.sampleRate,
        vad,
        ws,
        pending: [],
        committed: "",
        partial: "",
        broken: false,
        finalWaiters: [],
      };
      // Connect last: audio only starts flowing once the session (and its socket
      // handle) exists, so the first onaudioprocess frame has somewhere to go.
      src.connect(proc);
      proc.connect(ac.destination);
      // Drive the live level on the animation frame clock. Envelope-follow the
      // raw RMS — fast attack tracks how hard/quick you speak (velocity), slow
      // release keeps the glow smooth between words.
      levelSmoothRef.current = 0;
      const tick = () => {
        if (!sessionRef.current) {
          rafRef.current = null;
          return;
        }
        const target = Math.min(1, rawLevelRef.current / LEVEL_FULL_SCALE);
        const cur = levelSmoothRef.current;
        const coeff = target > cur ? LEVEL_ATTACK : LEVEL_RELEASE;
        const next = cur + (target - cur) * coeff;
        levelSmoothRef.current = next;
        setLevel(Math.round(next * 1000) / 1000);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      setState("recording");
      startingRef.current = false;
      // A release that fired during init queued a stop — run it now that the
      // session is live so the take is submitted (and the mic released) instead
      // of recording forever with no way to stop it.
      // Read through the ref's declared type — TS otherwise control-flow-narrows
      // this to the `null` we assigned at start(), unaware stop() can mutate it.
      const queued = pendingStopRef.current as { auto: boolean; discard: boolean } | null;
      if (queued) {
        pendingStopRef.current = null;
        void stop(queued.auto, queued.discard);
      }
    } catch {
      startingRef.current = false;
      pendingStopRef.current = null;
      setState("idle");
    }
  }, [silenceMs, stop]);

  const toggle = useCallback(() => {
    if (state === "transcribing") return;
    // Tapping the button to stop normally submits the request (stop(auto=true)
    // → routes the transcript through onAutoSubmit), matching the silence-
    // triggered and release-to-send paths; falls back to onText if no
    // onAutoSubmit is wired. In reviewOnStop mode the tap-stop instead delivers
    // via onText — the transcript lands in the input for the user to edit/send.
    if (sessionRef.current) void stop(!reviewOnStopRef.current);
    else void start();
  }, [state, start, stop]);

  // Dismiss an in-progress recording (or one still acquiring the mic) without
  // transcribing or sending anything — for when the mic clearly didn't catch
  // it right and stopping-and-sending would just push garbage into the chat.
  const cancel = useCallback(() => {
    if (state === "transcribing") return;
    void stop(false, true);
  }, [state, stop]);

  // Fully release the held mic when the hook's owner unmounts, so we never leave
  // a track (and its OS mic indicator) live after the UI is gone.
  useEffect(() => releaseStream, [releaseStream]);

  return { state, toggle, start, stop, cancel, supported, level };
}

// Imperative handle so a parent (e.g. the orb's press-and-hold gesture) can
// drive dictation without a click on the button itself. `submitOnStop` routes
// the stopped transcript through the auto-submit callback (release-to-send)
// rather than just inserting it.
export type MicHandle = { start: () => void; stop: (submitOnStop?: boolean) => void; cancel: () => void };

// How long the mic button must be held before it becomes push-to-talk. A press
// shorter than this is treated as a tap (toggle dictation); longer engages
// hold-to-talk (record while held, release to send).
export const MIC_LONG_PRESS_MS = 300;

// How far (px) a held pointer must drag away from where it went down before a
// recording arms as "release to cancel" — the WhatsApp-style slide-away-to-
// dismiss gesture, so a bad take can be tossed with no dedicated button and no
// stationary-hold timer to wait out. Comfortably past incidental finger wobble
// on a small touch target, well short of needing to leave the composer.
export const MIC_CANCEL_DRAG_PX = 48;

export const MicButton = forwardRef<
  MicHandle,
  {
    onText: (text: string, base: string) => void;
    onAutoSubmit?: (text: string, base: string) => void;
    onInterim?: (text: string, base: string) => void;
    // Fires when the recording is dismissed instead of stopped — restore the
    // field to `base` (the text from before dictation started) so a garbled
    // partial transcript doesn't linger after the user backs out.
    onCancel?: (base: string) => void;
    baseText?: string;
    silenceMs?: number;
    // Tap-mode dictation reviews instead of auto-sending (see useDictation).
    reviewOnStop?: boolean;
    className?: string;
    minimal?: boolean;
    // Fires true while actively recording (tap or hold), false otherwise — lets a
    // parent reflect "listening" in its own chrome (e.g. glow the session border).
    onRecordingChange?: (recording: boolean) => void;
  }
>(function MicButton(
  { onText, onAutoSubmit, onInterim, onCancel, baseText, silenceMs, reviewOnStop, className, minimal = false, onRecordingChange },
  ref,
) {
  const { state, toggle, start, stop, cancel, supported, level } = useDictation({
    onText,
    onAutoSubmit,
    onInterim,
    onCancel,
    baseText,
    silenceMs,
    reviewOnStop,
  });
  useImperativeHandle(
    ref,
    () => ({
      start: () => void start(),
      // submitOnStop → stop(auto=true) delivers via onAutoSubmit (release-to-send).
      stop: (submitOnStop = true) => void stop(submitOnStop),
      cancel: () => cancel(),
    }),
    [start, stop, cancel],
  );

  // Escape dismisses an in-flight recording without transcribing/sending it —
  // the keyboard-accessible escape hatch for "the mic didn't catch that right."
  // Scoped to only listen while actually recording so it doesn't shadow Escape
  // handlers elsewhere in the app (closing dialogs, etc.) the rest of the time.
  useEffect(() => {
    if (state !== "recording") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      haptic("selection");
      cancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [state, cancel]);

  // Press-and-hold vs tap. A pointer held past MIC_LONG_PRESS_MS becomes
  // push-to-talk: we start recording with the silence-VAD disabled (hold
  // controls the take) and stop+submit on release. A shorter press falls through
  // to `toggle` — the existing tap-to-dictate (records, auto-sends after a
  // pause). Haptics differ on purpose so the two gestures feel distinct: a light
  // "selection" tick on tap, a firmer "medium" thud when hold engages.
  const holdTimer = useRef<number | null>(null);
  const holdFired = useRef(false);
  // Where the pointer went down, so onPointerMove can measure how far it's
  // dragged away. Set on every pointerdown; only consulted once a recording is
  // actually live (holdFired, or the tap-mode session was already recording).
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  // Armed once the held pointer has dragged past MIC_CANCEL_DRAG_PX from
  // dragOrigin — release then cancels (discards) instead of stopping+sending.
  // Dragging back under the threshold disarms it again, so the gesture can be
  // aborted mid-drag same as WhatsApp's slide-to-cancel.
  const cancelDragArmed = useRef(false);
  const pointerDown = useRef(false);
  // Set on pointer-up so the synthetic click that follows a touch/mouse gesture
  // is ignored — keyboard activation (no preceding pointer) still runs `toggle`.
  const skipNextClick = useRef(false);
  // Mirrors cancelDragArmed into render so the button can preview the cancel
  // (icon/color swap) while the drag is still live, before release.
  const [cancelArmed, setCancelArmed] = useState(false);

  const clearHoldTimer = useCallback(() => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      // Primary button / touch / pen only.
      if (e.button !== 0) return;
      if (state === "transcribing") return;
      pointerDown.current = true;
      holdFired.current = false;
      cancelDragArmed.current = false;
      dragOrigin.current = { x: e.clientX, y: e.clientY };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — pointerup still fires on the element */
      }
      // Only idle → hold can begin a fresh take. If we're already recording
      // (tapped on earlier), a hold shouldn't restart it — but the drag-to-
      // cancel above still applies to that live recording via onPointerMove.
      if (state !== "idle") return;
      clearHoldTimer();
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null;
        holdFired.current = true;
        // "heavy" (35ms, full intensity) — the press-to-talk engage thud. Same
        // preset vibes uses for long-press; strong enough to actually feel.
        haptic("heavy");
        void start({ autoStop: false });
      }, MIC_LONG_PRESS_MS);
    },
    [state, start, clearHoldTimer],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!pointerDown.current) return;
      // Only matters once a recording is actually live — either this hold
      // engaged one (holdFired) or the button was already tap-recording when
      // the pointer went down.
      if (!holdFired.current && state !== "recording") return;
      const origin = dragOrigin.current;
      if (!origin) return;
      const dist = Math.hypot(e.clientX - origin.x, e.clientY - origin.y);
      const armed = dist > MIC_CANCEL_DRAG_PX;
      if (armed === cancelDragArmed.current) return;
      cancelDragArmed.current = armed;
      setCancelArmed(armed);
      haptic(armed ? "warning" : "selection");
    },
    [state],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!pointerDown.current) return;
      pointerDown.current = false;
      skipNextClick.current = true;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* nothing captured */
      }
      clearHoldTimer();
      setCancelArmed(false);
      const wasDraggedAway = cancelDragArmed.current;
      cancelDragArmed.current = false;
      if (wasDraggedAway) {
        // Dragged away before releasing → dismiss instead of sending, whether
        // this was a fresh hold-to-talk or an already tap-recording session.
        holdFired.current = false;
        haptic("selection");
        cancel();
      } else if (holdFired.current) {
        // Hold engaged, released back on the button → send.
        holdFired.current = false;
        void stop(true);
      } else {
        // Quick tap → existing toggle behavior (records, auto-sends on pause).
        // "medium" so the tap is felt but stays distinct from the heavier hold.
        haptic("medium");
        toggle();
      }
    },
    [stop, toggle, cancel, clearHoldTimer],
  );

  const onPointerCancel = useCallback(() => {
    if (!pointerDown.current) return;
    pointerDown.current = false;
    clearHoldTimer();
    setCancelArmed(false);
    // Interrupted mid-gesture (e.g. the OS stole the pointer). Honor an
    // already-armed cancel; otherwise if a hold was live, end it gracefully by
    // sending what we have rather than dropping it.
    const wasDraggedAway = cancelDragArmed.current;
    cancelDragArmed.current = false;
    if (wasDraggedAway) {
      holdFired.current = false;
      cancel();
    } else if (holdFired.current) {
      holdFired.current = false;
      void stop(true);
    }
  }, [stop, cancel, clearHoldTimer]);

  const onClick = useCallback(() => {
    // Pointer gestures already handled this; only keyboard activation (Enter /
    // Space, which fires click with no preceding pointer sequence) reaches here.
    if (skipNextClick.current) {
      skipNextClick.current = false;
      return;
    }
    if (state === "transcribing") return;
    haptic("medium");
    toggle();
  }, [state, toggle]);

  // Surface "listening" to the parent so it can light up around the composer.
  // Cleanup clears it if we unmount mid-recording.
  useEffect(() => {
    onRecordingChange?.(state === "recording");
    return () => onRecordingChange?.(false);
  }, [state, onRecordingChange]);

  // Belt-and-suspenders: if recording ends any other way (silence auto-stop,
  // Escape) while a cancel-drag happened to be armed, drop the preview so a
  // stray pointerup later doesn't look like it's still arming a cancel.
  useEffect(() => {
    if (state !== "recording") setCancelArmed(false);
  }, [state]);

  if (!supported) return null;
  const recording = state === "recording";
  // While recording, the button reacts to the live mic level: it scales up and
  // throws a red glow ring that swells with your volume. Inline transitions keep
  // it snappy (the className `transition` would lag the per-frame updates by
  // ~150ms and make it feel sluggish).
  const reactiveStyle = recording ? recordingButtonStyle(level) : undefined;
  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={
        recording
          ? cancelArmed
            ? "Release to cancel dictation"
            : "Stop dictation — hold and drag away, or press Esc, to cancel"
          : "Dictate"
      }
      title={recording ? "Tap to send · hold + drag away to cancel · Esc to cancel" : "Tap to dictate · hold to talk"}
      style={reactiveStyle}
      className={cn(
        "flex shrink-0 touch-none select-none items-center justify-center rounded-full transition",
        recording
          ? cancelArmed
            ? "z-10 bg-muted-foreground text-background"
            : "z-10 bg-destructive text-destructive-foreground"
          : minimal
            ? "relative z-10 bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground"
            : "text-muted-foreground hover:bg-muted",
        className,
      )}
    >
      {cancelArmed ? (
        <X className="size-4" />
      ) : state === "transcribing" ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Mic className="size-4" />
      )}
    </button>
  );
});
