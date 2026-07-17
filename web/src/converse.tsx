// Converse — a NEW, standalone realtime voice interface (OpenAI gpt-realtime-2.1).
//
// This is a SEPARATE interface from the existing ElevenLabs/LiveKit `voice-call.tsx`
// (Cascade) — it shares no state or transport with it, only the server-side tool
// backend. The browser holds the WebRTC peer connection directly to OpenAI; the lfg
// server (voice-rt.ts) only mints the ephemeral token and runs relayed tool calls.
//
// Flow (verified against the live API 2026-07-17): fetch ephemeral token → mic +
// RTCPeerConnection → "oai-events" data channel → POST SDP offer to
// /v1/realtime/calls → play remote audio → on function_call, hit the gateway tool
// endpoint and return function_call_output + response.create. See
// docs/voice-agent-architecture.md (Rev 4) §2 in the extension repo.

import { useEffect, useRef, useState } from "react";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

type Status = "connecting" | "live" | "ended" | "error";
type LogEntry = { role: "you" | "assistant" | "tool" | "system"; text: string };

export function Converse({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const append = (role: LogEntry["role"], text: string) =>
    setLog((l) => [...l.slice(-40), { role, text }]);

  // --- run a tool call the model relays over the data channel, return the result ---
  async function handleFunctionCall(name: string, callId: string, argsJson: string) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson || "{}");
    } catch {
      /* leave empty */
    }
    append("tool", `${name}(${JSON.stringify(args)})`);
    let output: string;
    try {
      const res = await fetch(`/api/voice/rt/tools/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args }),
      });
      output = await res.text(); // gateway already returns JSON; forward verbatim
    } catch (e) {
      output = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      }),
    );
    dc.send(JSON.stringify({ type: "response.create" }));
  }

  function handleEvent(ev: any) {
    switch (ev?.type) {
      case "response.done": {
        for (const item of ev.response?.output ?? []) {
          if (item?.type === "function_call") {
            void handleFunctionCall(item.name, item.call_id, item.arguments);
          }
        }
        break;
      }
      case "response.output_audio_transcript.done":
        if (ev.transcript) append("assistant", ev.transcript);
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript) append("you", ev.transcript);
        break;
      case "error":
        setError(ev.error?.message ?? "realtime error");
        break;
      default:
        break;
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      try {
        const user = localStorage.getItem("lfg_user") || "anon";
        const tokenRes = await fetch(`/api/voice/rt/token?user=${encodeURIComponent(user)}`, {
          method: "POST",
        });
        if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}: ${await tokenRes.text()}`);
        const { value: ephemeralKey } = (await tokenRes.json()) as { value: string };
        if (!ephemeralKey) throw new Error("no ephemeral token returned");
        if (cancelled) return;

        const pc = new RTCPeerConnection();
        pcRef.current = pc;
        pc.ontrack = (e) => {
          if (audioRef.current) audioRef.current.srcObject = e.streams[0];
        };

        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        micRef.current = mic;
        for (const track of mic.getTracks()) pc.addTrack(track, mic);

        const dc = pc.createDataChannel("oai-events");
        dcRef.current = dc;
        dc.onopen = () => !cancelled && setStatus("live");
        dc.onmessage = (e) => {
          try {
            handleEvent(JSON.parse(e.data));
          } catch {
            /* non-JSON keepalive */
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const sdpRes = await fetch(CALLS_URL, {
          method: "POST",
          body: offer.sdp,
          headers: { Authorization: `Bearer ${ephemeralKey}`, "Content-Type": "application/sdp" },
        });
        if (!sdpRes.ok) throw new Error(`sdp ${sdpRes.status}: ${await sdpRes.text()}`);
        const answer = await sdpRes.text();
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
        if (!cancelled) append("system", "Connected — start talking.");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    }

    void connect();

    return () => {
      cancelled = true;
      try {
        dcRef.current?.close();
      } catch {
        /* noop */
      }
      try {
        pcRef.current?.close();
      } catch {
        /* noop */
      }
      micRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const hangUp = () => {
    setStatus("ended");
    onClose();
  };

  return (
    <div style={overlay}>
      <audio ref={audioRef} autoPlay />
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>Converse</strong>
          <span style={{ opacity: 0.6, fontSize: 13 }}>
            {status === "connecting" && "connecting…"}
            {status === "live" && "● live"}
            {status === "ended" && "ended"}
            {status === "error" && "error"}
          </span>
        </div>

        {error && <div style={errorBox}>{error}</div>}

        <div style={logBox}>
          {log.length === 0 && !error ? (
            <div style={{ opacity: 0.5 }}>Say “find my notes about …” or “make a note …”.</div>
          ) : (
            log.map((e, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <span style={{ opacity: 0.5, marginRight: 6 }}>{e.role}</span>
                <span>{e.text}</span>
              </div>
            ))
          )}
        </div>

        <button style={hangUpBtn} onClick={hangUp}>
          End
        </button>
      </div>
    </div>
  );
}

// --- minimal inline styling (kept self-contained; no dependency on app CSS) ---
const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  backdropFilter: "blur(4px)",
};
const card: React.CSSProperties = {
  width: "min(480px, 92vw)",
  maxHeight: "80vh",
  background: "var(--card, #1b1b1f)",
  color: "var(--fg, #f5f5f7)",
  borderRadius: 16,
  padding: 20,
  display: "flex",
  flexDirection: "column",
  gap: 14,
  boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
};
const logBox: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  fontSize: 14,
  lineHeight: 1.5,
  minHeight: 120,
};
const errorBox: React.CSSProperties = {
  background: "rgba(255,60,60,0.15)",
  color: "#ff9b9b",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 13,
  whiteSpace: "pre-wrap",
};
const hangUpBtn: React.CSSProperties = {
  alignSelf: "center",
  padding: "10px 28px",
  borderRadius: 999,
  border: "none",
  background: "#e5484d",
  color: "white",
  fontSize: 15,
  cursor: "pointer",
};
