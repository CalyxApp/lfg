// Converse — a NEW, standalone realtime voice interface (OpenAI gpt-realtime-2.1).
//
// Separate from the existing ElevenLabs/LiveKit `voice-call.tsx` (Cascade); shares
// only the server-side tool backend. Browser holds WebRTC directly to OpenAI; the
// lfg server (voice-rt.ts) mints the ephemeral token, runs relayed tool calls, and
// persists the finished conversation as an `ai-voice-conversation` note.
//
// Flow: token → mic + RTCPeerConnection → "oai-events" channel → SDP to
// /v1/realtime/calls → talk. On End: tear down, then a review step (title +
// properties, editable) → save to the workspace vault. See Rev 4 plan §2.

import { useEffect, useRef, useState } from "react";
import { NoteMetaEditor, type PropRow } from "./note-meta-editor";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const MODEL = "gpt-realtime-2.1-mini";

type Status = "connecting" | "live" | "error";
type Phase = "live" | "review";
type LogEntry = { role: "you" | "assistant" | "tool" | "system"; text: string };

const pad = (n: number) => String(n).padStart(2, "0");
function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function Converse({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status>("connecting");
  const [phase, setPhase] = useState<Phase>("live");
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  // review-step state
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [properties, setProperties] = useState<PropRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const append = (role: LogEntry["role"], text: string) =>
    setLog((l) => [...l.slice(-60), { role, text }]);

  function teardown() {
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
  }

  // --- run a tool call the model relays over the data channel ---
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
      output = await res.text();
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
      case "response.done":
        for (const item of ev.response?.output ?? []) {
          if (item?.type === "function_call") void handleFunctionCall(item.name, item.call_id, item.arguments);
        }
        break;
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
        const tokenRes = await fetch(`/api/voice/rt/token?user=${encodeURIComponent(user)}`, { method: "POST" });
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
        dc.onopen = () => {
          if (cancelled) return;
          startedAtRef.current = Date.now();
          setStatus("live");
        };
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
        await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });
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
      teardown();
    };
  }, []);

  const transcriptTurns = () => log.filter((e) => e.role === "you" || e.role === "assistant");

  function buildTranscript(): string {
    const body = transcriptTurns()
      .map((e) => `**${e.role === "you" ? "You" : "Assistant"}:** ${e.text}`)
      .join("\n\n");
    return `## Transcript\n\n${body}\n`;
  }

  // End the live session → tear down, then move to the save-review step (unless
  // nothing was said, in which case just close).
  function endSession() {
    teardown();
    if (transcriptTurns().length === 0) {
      onClose();
      return;
    }
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const durMs = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
    const firstUser = log.find((e) => e.role === "you")?.text ?? "";
    setTitle(firstUser ? firstUser.slice(0, 60) : `Voice note ${dateStr}`);
    setTags([]);
    setProperties([
      { key: "date", value: dateStr },
      { key: "duration", value: formatDuration(durMs) },
      { key: "model", value: MODEL },
    ]);
    setPhase("review");
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const props = Object.fromEntries(
        properties.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]),
      );
      const res = await fetch("/api/voice/rt/save-conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), tags, properties: props, transcript: buildTranscript() }),
      });
      if (!res.ok) throw new Error(`save ${res.status}: ${await res.text()}`);
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  // ---------- review step ----------
  if (phase === "review") {
    return (
      <div style={overlay}>
        <div style={card}>
          <div style={headerRow}>
            <strong>Save conversation</strong>
            <span style={{ opacity: 0.6, fontSize: 13 }}>{transcriptTurns().length} turns</span>
          </div>
          {saveError && <div style={errorBox}>{saveError}</div>}
          <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
            <NoteMetaEditor
              title={title}
              onTitle={setTitle}
              tags={tags}
              onTags={setTags}
              properties={properties}
              onProperties={setProperties}
            />
            <details style={{ fontSize: 13, opacity: 0.85 }}>
              <summary style={{ cursor: "pointer" }}>Transcript preview</summary>
              <pre style={transcriptPre}>{buildTranscript()}</pre>
            </details>
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button style={discardBtn} onClick={onClose} disabled={saving}>
              Discard
            </button>
            <button style={saveBtn} onClick={handleSave} disabled={saving || !title.trim()}>
              {saving ? "Saving…" : "Save note"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- live step ----------
  return (
    <div style={overlay}>
      <audio ref={audioRef} autoPlay />
      <div style={card}>
        <div style={headerRow}>
          <strong>Converse</strong>
          <span style={{ opacity: 0.6, fontSize: 13 }}>
            {status === "connecting" && "connecting…"}
            {status === "live" && "● live"}
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

        <button style={endBtn} onClick={endSession}>
          End
        </button>
      </div>
    </div>
  );
}

// --- self-contained dark styling (do NOT use app CSS vars — they render invisible) ---
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
  maxHeight: "85vh",
  background: "#1c1c1e",
  color: "#f2f2f7",
  borderRadius: 16,
  padding: 20,
  display: "flex",
  flexDirection: "column",
  gap: 14,
  boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
};
const headerRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};
const logBox: React.CSSProperties = { flex: 1, overflowY: "auto", fontSize: 14, lineHeight: 1.5, minHeight: 120 };
const errorBox: React.CSSProperties = {
  background: "rgba(255,60,60,0.15)",
  color: "#ff9b9b",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 13,
  whiteSpace: "pre-wrap",
};
const transcriptPre: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  marginTop: 8,
  fontSize: 13,
  lineHeight: 1.5,
  opacity: 0.9,
  fontFamily: "inherit",
};
const endBtn: React.CSSProperties = {
  alignSelf: "center",
  padding: "10px 28px",
  borderRadius: 999,
  border: "none",
  background: "#e5484d",
  color: "white",
  fontSize: 15,
  cursor: "pointer",
};
const saveBtn: React.CSSProperties = {
  padding: "10px 24px",
  borderRadius: 999,
  border: "none",
  background: "#3b82f6",
  color: "white",
  fontSize: 15,
  cursor: "pointer",
};
const discardBtn: React.CSSProperties = {
  padding: "10px 24px",
  borderRadius: 999,
  border: "1px solid #3a3a3c",
  background: "transparent",
  color: "#f2f2f7",
  fontSize: 15,
  cursor: "pointer",
};
