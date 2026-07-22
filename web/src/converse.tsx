// Converse — the unified chat ↔ voice surface (one thread, two engines).
//
// Text mode (default): a composer with a dictation mic — typed or dictated turns
// go to POST /api/voice/rt/chat, which runs the user-selected chat model (OpenAI
// first; Gemini/Claude registered as coming-soon — see src/chat-providers.ts)
// with the same vault tool suite the voice call uses. Dictation is deliberately
// review-before-send: the mic drops editable text into the box, nothing auto-sends.
//
// Voice mode (◉): the original realtime interface (OpenAI gpt-realtime) — browser
// holds WebRTC directly to OpenAI; the lfg server (voice-rt.ts) mints the
// ephemeral token and runs relayed tool calls. Entering voice mode replays the
// thread so far into the realtime session as conversation items, so the spoken
// assistant knows what was typed; spoken turns land back in the same log. This is
// the "one shared thread" decision from the unified-chat-and-voice plan.
//
// On close with any turns: review step (title + properties, editable) → save to
// the workspace vault as an `ai-voice-conversation` note (unchanged).

import { useEffect, useRef, useState } from "react";
import { NoteMetaEditor, type PropRow } from "./note-meta-editor";
import { MicButton } from "./components/dictation";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const MODEL = "gpt-realtime-2.1-mini";

type Mode = "chat" | "voice";
type VoiceStatus = "connecting" | "live" | "error";
type Phase = "live" | "review";
type LogEntry = { role: "you" | "assistant" | "tool" | "system"; text: string };

type ChatConfig = {
  settings: { provider: string; model: string };
  providers: { id: string; label: string; models: string[]; available: boolean; implemented: boolean }[];
};

const pad = (n: number) => String(n).padStart(2, "0");
function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function Converse({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("chat");
  const [phase, setPhase] = useState<Phase>("live");
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  // chat-mode state
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [cfg, setCfg] = useState<ChatConfig | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

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
  const usedVoiceRef = useRef(false);
  const logRef = useRef<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const append = (role: LogEntry["role"], text: string) =>
    setLog((l) => {
      const next = [...l.slice(-60), { role, text }];
      logRef.current = next;
      return next;
    });

  // keep the thread pinned to the latest turn
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, sending, mode]);

  // which chat model powers typed turns (selection persists server-side)
  useEffect(() => {
    fetch("/api/chat/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setCfg(j as ChatConfig))
      .catch(() => {
        /* picker just stays hidden */
      });
  }, []);

  async function updateChatConfig(patch: { provider?: string; model?: string }) {
    try {
      const res = await fetch("/api/chat/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) return;
      const j = (await res.json()) as { settings: ChatConfig["settings"] };
      setCfg((c) => (c ? { ...c, settings: j.settings } : c));
    } catch {
      /* keep old selection */
    }
  }

  const threadTurns = () => logRef.current.filter((e) => e.role === "you" || e.role === "assistant");

  // ---------------- text mode: one typed/dictated turn ----------------
  async function sendChat() {
    const text = input.trim();
    if (!text || sending) return;
    if (!startedAtRef.current) startedAtRef.current = Date.now();
    const messages = [
      ...threadTurns().map((e) => ({ role: e.role === "you" ? "user" : "assistant", content: e.text })),
      { role: "user", content: text },
    ];
    append("you", text);
    setInput("");
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/voice/rt/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
      });
      if (!res.ok) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as {
        text: string;
        toolCalls?: { name: string; args: Record<string, unknown> }[];
      };
      for (const tc of data.toolCalls ?? []) append("tool", `${tc.name}(${JSON.stringify(tc.args)})`);
      if (data.text) append("assistant", data.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  // ---------------- voice mode: realtime session lifecycle ----------------
  function teardownVoice() {
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
    dcRef.current = null;
    pcRef.current = null;
    micRef.current = null;
  }

  // run a tool call the model relays over the data channel
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
    if (mode !== "voice") return;
    let cancelled = false;
    setVoiceStatus("connecting");
    setError(null);

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
          // One shared thread: replay what was already typed/spoken into the new
          // realtime session so the spoken assistant has the full conversation.
          for (const e of logRef.current) {
            if (e.role !== "you" && e.role !== "assistant") continue;
            dc.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: e.role === "you" ? "user" : "assistant",
                  content: [
                    e.role === "you"
                      ? { type: "input_text", text: e.text }
                      : { type: "text", text: e.text },
                  ],
                },
              }),
            );
          }
          if (!startedAtRef.current) startedAtRef.current = Date.now();
          usedVoiceRef.current = true;
          setVoiceStatus("live");
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
        if (!cancelled) append("system", "Voice connected — start talking.");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setVoiceStatus("error");
      }
    }

    void connect();
    return () => {
      cancelled = true;
      teardownVoice();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ---------------- close / save ----------------
  function buildTranscript(): string {
    const body = threadTurns()
      .map((e) => `**${e.role === "you" ? "You" : "Assistant"}:** ${e.text}`)
      .join("\n\n");
    return `## Transcript\n\n${body}\n`;
  }

  // Close the surface → tear down voice if live, then the save-review step
  // (unless nothing was said, in which case just close).
  function closeSurface() {
    if (mode === "voice") setMode("chat"); // effect cleanup tears the session down
    if (threadTurns().length === 0) {
      onClose();
      return;
    }
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const durMs = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
    const firstUser = logRef.current.find((e) => e.role === "you")?.text ?? "";
    const models = [
      ...(cfg ? [`${cfg.settings.provider}/${cfg.settings.model}`] : []),
      ...(usedVoiceRef.current ? [MODEL] : []),
    ];
    setTitle(firstUser ? firstUser.slice(0, 60) : `Voice note ${dateStr}`);
    setTags([]);
    setProperties([
      { key: "date", value: dateStr },
      { key: "duration", value: formatDuration(durMs) },
      { key: "model", value: models.join(" + ") || MODEL },
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
            <span style={{ opacity: 0.6, fontSize: 13 }}>{threadTurns().length} turns</span>
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

  // ---------- live step (one thread; chat or voice mode) ----------
  const activeProvider = cfg?.providers.find((p) => p.id === cfg.settings.provider);
  const modelChip = cfg ? `${activeProvider?.label ?? cfg.settings.provider} · ${cfg.settings.model}` : null;

  return (
    <div style={overlay}>
      <audio ref={audioRef} autoPlay />
      <div style={card}>
        <div style={headerRow}>
          <strong>Chat</strong>
          <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {mode === "voice" ? (
              <span style={{ opacity: 0.7, fontSize: 13 }}>
                {voiceStatus === "connecting" && "◉ connecting…"}
                {voiceStatus === "live" && "◉ voice live"}
                {voiceStatus === "error" && "◉ voice error"}
              </span>
            ) : modelChip ? (
              <button style={chipBtn} onClick={() => setPickerOpen((o) => !o)} title="Choose chat model">
                {modelChip}
              </button>
            ) : null}
            <button style={closeX} onClick={closeSurface} aria-label="Close chat" title="Close">
              ✕
            </button>
          </span>
        </div>

        {pickerOpen && cfg && mode === "chat" && (
          <div style={pickerRow}>
            <select
              style={selectStyle}
              value={cfg.settings.provider}
              onChange={(e) => void updateChatConfig({ provider: e.target.value })}
            >
              {cfg.providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.implemented}>
                  {p.label}
                  {!p.implemented ? " (soon)" : !p.available ? " (no key)" : ""}
                </option>
              ))}
            </select>
            <select
              style={selectStyle}
              value={cfg.settings.model}
              onChange={(e) => void updateChatConfig({ model: e.target.value })}
            >
              {(activeProvider?.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && <div style={errorBox}>{error}</div>}

        <div style={logBox} ref={scrollRef}>
          {log.length === 0 && !error ? (
            <div style={{ opacity: 0.5 }}>
              Type, tap 🎤 to dictate (you review before sending), or tap ◉ for a live voice
              conversation — it's all one thread.
            </div>
          ) : (
            log.map((e, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <span style={{ opacity: 0.5, marginRight: 6 }}>{e.role}</span>
                <span style={{ whiteSpace: "pre-wrap" }}>{e.text}</span>
              </div>
            ))
          )}
          {sending && <div style={{ opacity: 0.5 }}>…</div>}
        </div>

        {mode === "voice" ? (
          <button style={endBtn} onClick={() => setMode("chat")}>
            End voice
          </button>
        ) : (
          <form
            style={composerRow}
            onSubmit={(e) => {
              e.preventDefault();
              void sendChat();
            }}
          >
            <input
              style={inputStyle}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask…"
              disabled={sending}
            />
            {/* Dictation is review-before-send by construction: no onAutoSubmit
                wired, so stopping the mic leaves editable text in the box. */}
            <MicButton
              baseText={input}
              onText={(text, base) => setInput(base.trim() ? `${base.trimEnd()} ${text}` : text)}
              onInterim={(text, base) => setInput(base.trim() ? `${base.trimEnd()} ${text}` : text)}
              onCancel={(base) => setInput(base)}
              className="size-10"
            />
            <button
              type="button"
              style={voiceModeBtn}
              onClick={() => setMode("voice")}
              title="Start realtime voice conversation"
              aria-label="Start voice mode"
            >
              ◉
            </button>
            <button type="submit" style={sendBtn} disabled={sending || !input.trim()} aria-label="Send">
              ↑
            </button>
          </form>
        )}
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
  height: "min(640px, 85vh)",
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
const composerRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
};
const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "10px 14px",
  borderRadius: 999,
  border: "1px solid #3a3a3c",
  background: "#2c2c2e",
  color: "#f2f2f7",
  fontSize: 15,
  outline: "none",
};
const voiceModeBtn: React.CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 999,
  border: "1px solid #3a3a3c",
  background: "#2c2c2e",
  color: "#7dd3fc",
  fontSize: 18,
  cursor: "pointer",
  flexShrink: 0,
};
const sendBtn: React.CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 999,
  border: "none",
  background: "#3b82f6",
  color: "white",
  fontSize: 18,
  cursor: "pointer",
  flexShrink: 0,
};
const chipBtn: React.CSSProperties = {
  border: "1px solid #3a3a3c",
  background: "#2c2c2e",
  color: "#f2f2f7",
  borderRadius: 999,
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
};
const closeX: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#f2f2f7",
  fontSize: 16,
  cursor: "pointer",
  opacity: 0.7,
};
const pickerRow: React.CSSProperties = { display: "flex", gap: 8 };
const selectStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid #3a3a3c",
  background: "#2c2c2e",
  color: "#f2f2f7",
  fontSize: 13,
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
