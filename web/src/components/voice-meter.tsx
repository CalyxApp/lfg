// voice-meter.tsx — a small live "we can hear you" indicator for Converse voice
// mode. Taps the mic MediaStream with a WebAudio AnalyserNode and drives a row of
// bars off the input level (Sam 2026-07-29: "something that shows you can actually
// hear me… a little wobbly bar"). Bars are animated by writing transform directly
// in the rAF loop — no React re-render per frame. When the mic is muted the level
// reads ~0, so the bars naturally go flat.

import { useEffect, useRef } from "react";

const BARS = 7;

export function VoiceMeter({ stream, active }: { stream: MediaStream | null; active: boolean }) {
  const barsRef = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (!stream || !active) return;
    let raf = 0;
    let ctx: AudioContext | null = null;
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const per = Math.floor(data.length / BARS);
        for (let i = 0; i < BARS; i++) {
          let sum = 0;
          for (let j = i * per; j < (i + 1) * per; j++) sum += data[j];
          const avg = sum / Math.max(1, per) / 255; // 0..1
          const el = barsRef.current[i];
          if (el) el.style.transform = `scaleY(${(0.12 + avg * 1.8).toFixed(3)})`;
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* no meter if WebAudio is unavailable */
    }
    return () => {
      cancelAnimationFrame(raf);
      try {
        ctx?.close();
      } catch {
        /* ignore */
      }
    };
  }, [stream, active]);

  return (
    <div className="flex h-5 items-center gap-[3px]" aria-hidden="true">
      {Array.from({ length: BARS }).map((_, i) => (
        <div
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          className="h-full w-1 origin-center rounded-full bg-primary/70"
          style={{ transform: "scaleY(0.12)" }}
        />
      ))}
    </div>
  );
}
