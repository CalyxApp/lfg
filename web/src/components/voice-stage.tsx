// voice-stage.tsx — the big "we're live" indicator for Converse voice mode. A
// soft circular orb that swells with your mic level while the line is live, calms
// when muted, and spins while connecting. Mic level drives transforms in a rAF
// loop (no React re-render per frame — same technique as VoiceMeter), with a gentle
// breathing baseline so it feels alive even in silence. Honors reduced-motion.

import { useEffect, useRef } from "react";
import { Loader2, Mic, MicOff } from "lucide-react";
import { cn } from "@/lib/utils";

export function VoiceStage({
  stream,
  status,
  muted,
}: {
  stream: MediaStream | null;
  status: "connecting" | "live" | "error";
  muted: boolean;
}) {
  const coreRef = useRef<HTMLDivElement | null>(null);
  const haloRef = useRef<HTMLDivElement | null>(null);
  const reactive = status === "live" && !muted;

  useEffect(() => {
    const core = coreRef.current;
    const halo = haloRef.current;
    const rest = () => {
      if (core) core.style.transform = "scale(1)";
      if (halo) {
        halo.style.transform = "scale(1)";
        halo.style.opacity = "0.22";
      }
    };
    if (!stream || !reactive) {
      rest();
      return;
    }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      rest();
      return;
    }
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
      analyser.smoothingTimeConstant = 0.8;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const level = Math.min(1, (sum / data.length / 255) * 2.2); // 0..1
        const breathe = 1 + Math.sin(performance.now() / 650) * 0.012;
        if (core) core.style.transform = `scale(${(breathe + level * 0.18).toFixed(3)})`;
        if (halo) {
          halo.style.transform = `scale(${(1 + level * 0.9).toFixed(3)})`;
          halo.style.opacity = (0.18 + level * 0.5).toFixed(3);
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* no reactive orb if WebAudio is unavailable */
    }
    return () => {
      cancelAnimationFrame(raf);
      try {
        ctx?.close();
      } catch {
        /* ignore */
      }
    };
  }, [stream, reactive]);

  const Icon = muted ? MicOff : status === "connecting" ? Loader2 : Mic;
  const tone =
    status === "error"
      ? "bg-destructive/15 text-destructive"
      : muted
        ? "bg-muted text-muted-foreground"
        : "bg-primary/15 text-primary";
  const haloTone =
    status === "error" ? "bg-destructive/25" : muted ? "bg-muted-foreground/15" : "bg-primary/25";

  return (
    <div className="relative flex size-56 items-center justify-center" aria-hidden="true">
      <div
        ref={haloRef}
        className={cn("absolute size-40 rounded-full blur-xl", haloTone)}
        style={{ transform: "scale(1)", opacity: 0.22 }}
      />
      <div
        ref={coreRef}
        className={cn(
          "relative flex size-28 items-center justify-center rounded-full transition-colors duration-300",
          tone,
        )}
        style={{ transform: "scale(1)" }}
      >
        <Icon className={cn("size-10", status === "connecting" && "animate-spin")} />
      </div>
    </div>
  );
}
