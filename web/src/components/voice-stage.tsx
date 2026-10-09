// voice-stage.tsx — the "we're live" hero for Converse voice mode. Renders the
// ElevenLabs-style fluid Orb (web/src/eleven-orb.tsx, WebGL via R3F) in auto mode:
// it animates itself from `agentState` (a soft shimmer while listening, a gentle
// wander when idle/muted, a thinking swell while connecting) — no icon, no box.
// Lazy-loaded (three.js is heavy) behind an error boundary + a static gradient
// fallback, so a no-WebGL / stale-chunk case degrades to a blurred orb, never a crash.

import { Component, Suspense, type ReactNode } from "react";
import { lazyWithReload } from "../lib/lazy-with-reload";

const Orb = lazyWithReload("ConverseOrb", () =>
  import("../eleven-orb").then((m) => ({ default: m.Orb })),
);

type Status = "connecting" | "live" | "error";
type OrbAgentState = "listening" | "thinking" | "talking" | "consulting" | null;

// State → orb gradient, echoing voice-call.tsx so both voice surfaces speak the
// same colour language.
const COLORS: Record<string, [string, string]> = {
  idle: ["#9aa7b8", "#7c8a9c"],
  listening: ["#CADCFC", "#A0B9D1"],
  thinking: ["#cfc2ff", "#9f8be6"],
  error: ["#fca5a5", "#f87171"],
};

class OrbBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function VoiceStage({ status, muted }: { status: Status; muted: boolean }) {
  const agentState: OrbAgentState =
    status === "connecting" ? "thinking" : status === "error" || muted ? null : "listening";
  const colorKey = status === "error" ? "error" : (agentState ?? "idle");
  const colors = COLORS[colorKey] ?? COLORS.idle;

  const fallback = (
    <div
      className="h-full w-full rounded-full"
      style={{
        background: `conic-gradient(from 0deg, ${colors[0]}, ${colors[1]}, ${colors[0]})`,
        filter: "blur(12px)",
        opacity: 0.7,
      }}
    />
  );

  return (
    <div
      className="flex items-center justify-center"
      style={{ width: "min(62vw, 240px)", height: "min(62vw, 240px)" }}
    >
      <OrbBoundary fallback={fallback}>
        <Suspense fallback={fallback}>
          <Orb className="h-full w-full min-w-0" colors={colors} agentState={agentState} volumeMode="auto" />
        </Suspense>
      </OrbBoundary>
    </div>
  );
}
