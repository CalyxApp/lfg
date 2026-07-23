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
import { marked } from "marked";
import { ArrowUp, AudioLines, Mic, X } from "lucide-react";
import { NoteMetaEditor, type PropRow } from "./note-meta-editor";
import { useWaveformDictation, WaveformRecorderRow } from "./components/dictation";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const MODEL = "gpt-realtime-2.1-mini";

type Mode = "chat" | "voice";
type VoiceStatus = "connecting" | "live" | "error";
type Phase = "live" | "review";
// `id` keys realtime-voice turns so their text can be upserted in place as
// transcript deltas stream in (see handleEvent) — that's what keeps the thread
// in sync with the audio you actually hear. `ok` marks a tool chip's outcome.
type LogEntry = { role: "you" | "assistant" | "tool" | "system"; text: string; id?: string; ok?: boolean };

// Friendly one-line label for a tool call — "Created project “X”", not raw
// JSON args (Sam, 2026-07-22: tool calls looked like "a whole bunch of random
// text"; a successful create should read as exactly that).
function toolLabel(name: string, args: Record<string, unknown>, ok?: boolean): string {
  const a = (k: string) => String((args as Record<string, unknown>)[k] ?? "").trim();
  const failed = ok === false;
  switch (name) {
    case "search":
      return `Searched the vault for “${a("query")}”`;
    case "web_search":
      return `Searched the web for “${a("query")}”`;
    case "describe_vault":
      return a("type") ? `Checked the “${a("type")}” note type` : "Checked how the vault is organized";
    case "list_by_type":
      return `Listed ${a("type") || "notes"}`;
    case "browse":
      return `Browsed ${a("path") || "the vault"}`;
    case "read":
      return `Read “${a("name")}”`;
    case "create":
      return `${failed ? "Couldn't create" : "Created"} ${a("type") || "note"}${a("title") ? ` “${a("title")}”` : ""}`;
    case "create_project":
      return `${failed ? "Couldn't create" : "Created"} project${a("title") ? ` “${a("title")}”` : ""}`;
    case "update":
      return `${failed ? "Couldn't update" : "Updated"} “${a("name")}”`;
    default:
      return name.replaceAll("_", " ");
  }
}

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

  const append = (role: LogEntry["role"], text: string, ok?: boolean) =>
    setLog((l) => {
      const next = [...l.slice(-60), { role, text, ok }];
      logRef.current = next;
      return next;
    });

  // Insert-or-update a voice turn by realtime item id. Lets speech placeholders
  // and streaming transcript deltas update one entry in place, in the position
  // it was first heard — instead of whole turns popping in out of order when
  // the (slow) full-transcript events finally arrive.
  const upsert = (id: string, role: LogEntry["role"], text: string) =>
    setLog((l) => {
      const idx = l.findIndex((e) => e.id === id);
      let next: LogEntry[];
      if (idx >= 0) {
        next = [...l];
        next[idx] = { ...next[idx], text };
      } else {
        next = [...l.slice(-60), { id, role, text }];
      }
      logRef.current = next;
      return next;
    });
  // running transcript per realtime item while its deltas stream in
  const rtTextRef = useRef<Record<string, string>>({});

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

  // Real conversation turns — skips tool/system lines and the transient "…"
  // speech placeholders that never got a transcription.
  const threadTurns = () =>
    logRef.current.filter(
      (e) => (e.role === "you" || e.role === "assistant") && e.text.trim() && e.text !== "…",
    );

  // ---------------- text mode: one typed/dictated turn ----------------
  // Takes the text explicitly so both the form submit (input box) and the
  // dictation stop-&-send path can use it.
  async function sendChatText(raw: string) {
    const text = raw.trim();
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
        toolCalls?: { name: string; args: Record<string, unknown>; ok?: boolean }[];
      };
      for (const tc of data.toolCalls ?? []) append("tool", toolLabel(tc.name, tc.args, tc.ok), tc.ok);
      if (data.text) append("assistant", data.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  // ---------------- dictation (waveform widget) ----------------
  // The shared ChatGPT-style recorder (components/dictation.tsx) — tapping the
  // mic swaps the composer for a live waveform strip with ✕ cancel, ✓ stop
  // (transcript → editable text in the box), and ↑ stop-&-send. No silence
  // auto-stop; the Deepgram KeepAlive carries thinking pauses.
  const dict = useWaveformDictation({
    baseText: input,
    onText: setInput,
    onInterim: setInput,
    onSend: (t) => {
      setInput("");
      void sendChatText(t);
    },
    onCancel: (b) => setInput(b),
  });

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
    // Friendly outcome chip (not raw args): parse the tool result for ok/error.
    let ok: boolean | undefined;
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      ok = parsed?.error ? false : ((parsed?.ok as boolean | undefined) ?? true);
    } catch {
      /* unknown outcome */
    }
    append("tool", toolLabel(name, args, ok), ok);
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
      // The moment you start speaking, drop a placeholder turn in the thread —
      // the transcription itself arrives seconds later (often AFTER the
      // assistant has begun replying), which is what made the transcript feel
      // out of sync with the audio. The placeholder pins the correct position.
      case "input_audio_buffer.speech_started":
        if (ev.item_id) upsert(ev.item_id, "you", "…");
        break;
      // Stream the assistant's transcript word-by-word as it speaks (instead of
      // one paragraph popping in when the whole utterance is done).
      case "response.output_audio_transcript.delta":
        if (ev.item_id && ev.delta) {
          rtTextRef.current[ev.item_id] = (rtTextRef.current[ev.item_id] || "") + ev.delta;
          upsert(ev.item_id, "assistant", rtTextRef.current[ev.item_id]);
        }
        break;
      case "response.output_audio_transcript.done":
        if (ev.transcript) {
          if (ev.item_id) {
            delete rtTextRef.current[ev.item_id];
            upsert(ev.item_id, "assistant", ev.transcript);
          } else append("assistant", ev.transcript);
        }
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript) {
          if (ev.item_id) upsert(ev.item_id, "you", ev.transcript);
          else append("you", ev.transcript);
        }
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

        // Explicit echo cancellation / noise suppression: the phone speaker's
        // own output leaking back into the mic can read as the user barging in,
        // which makes the realtime API cut its reply mid-word (semantic VAD +
        // interrupt_response). Sam hit exactly that on a first, loudest reply.
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
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
  // Renders as a normal full-screen app view (bg-background + theme classes),
  // matching the agent chat — the old self-contained dark overlay looked alien
  // next to the rest of the PWA (Sam, 2026-07-22).
  if (phase === "review") {
    return (
      <div className="fixed inset-0 z-[1000] flex flex-col bg-background text-foreground">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <strong className="text-base font-semibold">Save conversation</strong>
          <span className="text-xs text-muted-foreground">{threadTurns().length} turns</span>
        </div>
        {saveError && (
          <div className="mx-4 mt-2 whitespace-pre-wrap rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {saveError}
          </div>
        )}
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
          <NoteMetaEditor
            title={title}
            onTitle={setTitle}
            tags={tags}
            onTags={setTags}
            properties={properties}
            onProperties={setProperties}
          />
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">Transcript preview</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
              {buildTranscript()}
            </pre>
          </details>
        </div>
        <div className="flex justify-center gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            className="rounded-full border border-border px-5 py-2 text-sm font-medium text-foreground disabled:opacity-50"
            onClick={onClose}
            disabled={saving}
          >
            Discard
          </button>
          <button
            className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            onClick={handleSave}
            disabled={saving || !title.trim()}
          >
            {saving ? "Saving…" : "Save note"}
          </button>
        </div>
      </div>
    );
  }

  // ---------- live step (one thread; chat or voice mode) ----------
  // Same interface as the agent chat (Sam, 2026-07-22): a full-screen themed
  // page — user turns in .user-bubble, assistant turns as plain markdown-style
  // text — instead of the old dark overlay card. The composer's right button
  // MORPHS: voice (◉) when the box is empty, send (↑) once there's text.
  const activeProvider = cfg?.providers.find((p) => p.id === cfg.settings.provider);
  const modelChip = cfg ? `${activeProvider?.label ?? cfg.settings.provider} · ${cfg.settings.model}` : null;
  const hasText = !!input.trim();

  return (
    <div className="fixed inset-0 z-[1000] flex flex-col bg-background text-foreground">
      <audio ref={audioRef} autoPlay />

      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <strong className="text-base font-semibold">Chat</strong>
        <div className="flex items-center gap-2">
          {mode === "voice" ? (
            <span className="text-xs text-muted-foreground">
              {voiceStatus === "connecting" && "◉ connecting…"}
              {voiceStatus === "live" && "◉ voice live"}
              {voiceStatus === "error" && "◉ voice error"}
            </span>
          ) : modelChip ? (
            <button
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground"
              onClick={() => setPickerOpen((o) => !o)}
              title="Choose chat model"
            >
              {modelChip}
            </button>
          ) : null}
          <button
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
            onClick={closeSurface}
            aria-label="Close chat"
            title="Close"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {pickerOpen && cfg && mode === "chat" && (
        <div className="flex gap-2 border-b border-border px-4 py-2">
          <select
            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-sm"
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
            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-sm"
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

      {error && (
        <div className="mx-4 mt-2 whitespace-pre-wrap rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3" ref={scrollRef}>
        {log.length === 0 && !error ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            Type, tap the mic to dictate (you review before sending), or tap ◉ for a live voice
            conversation — it's all one thread.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {log.map((e, i) =>
              e.role === "you" ? (
                <div
                  key={i}
                  className="msg-text markdown user-bubble ml-auto w-fit max-w-[85%] whitespace-pre-wrap text-base"
                >
                  {e.text}
                </div>
              ) : e.role === "assistant" ? (
                // Rendered markdown (same .msg-text.markdown styles as the
                // agent chat) — assistant replies use headings/lists/bold.
                <div
                  key={i}
                  className="msg-text markdown max-w-full text-base"
                  dangerouslySetInnerHTML={{ __html: marked.parse(e.text, { async: false }) as string }}
                />
              ) : e.role === "tool" ? (
                <div key={i} className="flex">
                  <span
                    className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                      e.ok === false
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-border bg-muted/40 text-muted-foreground"
                    }`}
                  >
                    {e.ok === false ? "✗" : "✓"} {e.text}
                  </span>
                </div>
              ) : (
                <div key={i} className="text-center text-xs text-muted-foreground">
                  {e.text}
                </div>
              ),
            )}
            {sending && <div className="text-sm text-muted-foreground">…</div>}
          </div>
        )}
      </div>

      {mode === "voice" ? (
        <div className="flex items-center justify-center gap-3 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <span className="text-sm text-muted-foreground">
            {voiceStatus === "live"
              ? "voice is live — just talk"
              : voiceStatus === "connecting"
                ? "connecting…"
                : "voice error"}
          </span>
          <button
            className="rounded-full bg-destructive px-5 py-2 text-sm font-medium text-destructive-foreground"
            onClick={() => setMode("chat")}
          >
            End voice
          </button>
        </div>
      ) : dict.active ? (
        // ---- dictation in progress: the shared waveform recorder ----
        <div className="border-t border-border bg-background px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <WaveformRecorderRow rec={dict} />
        </div>
      ) : (
        <form
          className="flex items-end gap-2 border-t border-border bg-background px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
          onSubmit={(e) => {
            e.preventDefault();
            void sendChatText(input);
          }}
        >
          <input
            className="lfg-gfield h-11 min-h-11 min-w-0 flex-1 rounded-2xl border-transparent px-4 text-base shadow-sm placeholder:text-muted-foreground"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask…"
            disabled={sending}
          />
          {dict.supported && (
            <button
              type="button"
              className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border text-foreground disabled:opacity-50 md:size-9"
              onClick={() => void dict.start()}
              disabled={sending}
              aria-label="Dictate"
              title="Dictate — you review before sending"
            >
              <Mic className="size-5 md:size-4" />
            </button>
          )}
          {/* Morphing button: ◉ voice when the box is empty, ↑ send when there's text. */}
          {hasText ? (
            <button
              type="submit"
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50 md:size-9"
              disabled={sending}
              aria-label="Send"
            >
              <ArrowUp className="size-5 md:size-4" />
            </button>
          ) : (
            <button
              type="button"
              className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border text-foreground disabled:opacity-50 md:size-9"
              onClick={() => setMode("voice")}
              disabled={sending}
              title="Start realtime voice conversation"
              aria-label="Start voice mode"
            >
              <AudioLines className="size-5 md:size-4" />
            </button>
          )}
        </form>
      )}
    </div>
  );
}

