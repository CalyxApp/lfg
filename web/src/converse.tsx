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
import {
  ArrowUp,
  AudioLines,
  File as FileIcon,
  History,
  Mic,
  MicOff,
  Paperclip,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { NoteMetaEditor, type PropRow } from "./note-meta-editor";
import { useWaveformDictation, WaveformRecorderRow } from "./components/dictation";
import { VoiceMeter } from "./components/voice-meter";
import { type ToolDetail } from "./components/tool-card";
import { ConversationTurns } from "./components/conversation-turns";
import { ConversationHistory } from "./conversation-history";
import {
  primeAudio,
  playReady,
  playError,
  startWorking,
  stopWorking,
  areSoundsMuted,
  setSoundsMuted,
} from "./lib/earcons";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const MODEL = "gpt-realtime-2.1";
// Unresolved "…" speech placeholders are cleared after this long if no transcript
// ever arrives (noise-triggered VAD, empty transcription) so they don't stick.
const PLACEHOLDER_TTL_MS = 9000;

type Mode = "chat" | "voice";
type VoiceStatus = "connecting" | "live" | "error";
type Phase = "live" | "review";
// `id` keys realtime-voice turns so their text can be upserted in place as
// transcript deltas stream in (see handleEvent) — that's what keeps the thread
// in sync with the audio you actually hear. `ok` marks a tool chip's outcome.
type LogEntry = {
  role: "you" | "assistant" | "tool" | "system";
  text: string;
  id?: string;
  ok?: boolean;
  tool?: ToolDetail; // set on tool rows → expandable input/result preview
  images?: string[]; // data: URLs shown as thumbnails on a "you" turn
  files?: string[]; // attached non-image file names shown as chips on a "you" turn
};

// Something the user attached to the composer. Images go inline as base64
// (dataUrl); other files (PDF/doc) upload to the OpenAI Files API and carry a
// fileId once the upload finishes.
type Attachment = {
  id: string;
  name: string;
  kind: "image" | "file";
  dataUrl?: string; // images
  fileId?: string; // files, once uploaded
  status: "ready" | "uploading" | "failed";
};
const MAX_ATTACHMENTS = 6;

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
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  // cue-sound mute (earcons) — distinct from `muted` above, which mutes the mic
  const [soundsMuted, setSoundsMutedState] = useState(areSoundsMuted());
  // Bumped to force a voice reconnect after a dropped WebRTC connection.
  const [connNonce, setConnNonce] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);

  // chat-mode state
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Auto-grow the chat box with its content (iOS Safari lacks CSS field-sizing),
  // capped at ~40vh then it scrolls. Runs on every value change so it also
  // shrinks back to one line after the box is cleared on send.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [input]);
  const [sending, setSending] = useState(false);
  const [cfg, setCfg] = useState<ChatConfig | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  const appendUser = (text: string, images?: string[], files?: string[]) =>
    setLog((l) => {
      const entry: LogEntry = { role: "you", text };
      if (images && images.length) entry.images = images;
      if (files && files.length) entry.files = files;
      const next = [...l.slice(-60), entry];
      logRef.current = next;
      return next;
    });

  // Tool row carrying the full call detail (name/args/result) so the chip can
  // expand to a preview. `label` stays the friendly one-liner from toolLabel().
  const appendTool = (name: string, args: Record<string, unknown>, ok: boolean | undefined, result?: string) =>
    setLog((l) => {
      const next = [
        ...l.slice(-60),
        { role: "tool" as const, text: toolLabel(name, args, ok), ok, tool: { name, args, result, ok } },
      ];
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
  // ---- image attachments (typed chat) ----
  function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }
  async function uploadFile(id: string, f: File) {
    try {
      const res = await fetch(`/api/voice/rt/upload-file?filename=${encodeURIComponent(f.name)}`, {
        method: "POST",
        headers: { "Content-Type": f.type || "application/octet-stream" },
        body: f,
      });
      if (!res.ok) throw new Error((await res.text()).slice(0, 200));
      const j = (await res.json()) as { file_id: string };
      setAttachments((a) => a.map((x) => (x.id === id ? { ...x, fileId: j.file_id, status: "ready" } : x)));
    } catch {
      setAttachments((a) => a.map((x) => (x.id === id ? { ...x, status: "failed" } : x)));
    }
  }
  async function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    const arr = Array.from(files);
    if (!arr.length) return;
    const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    for (const f of arr.slice(0, room)) {
      const id = `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 7)}`;
      if (f.type.startsWith("image/")) {
        // images ride inline as base64 — no upload needed
        try {
          const dataUrl = await readAsDataUrl(f);
          setAttachments((a) =>
            a.length >= MAX_ATTACHMENTS ? a : [...a, { id, name: f.name, kind: "image", dataUrl, status: "ready" }],
          );
        } catch {
          /* skip unreadable image */
        }
      } else {
        // other files → upload to the Files API, reference by file_id
        setAttachments((a) =>
          a.length >= MAX_ATTACHMENTS ? a : [...a, { id, name: f.name, kind: "file", status: "uploading" }],
        );
        void uploadFile(id, f);
      }
    }
  }
  const removeAttachment = (id: string) => setAttachments((a) => a.filter((x) => x.id !== id));

  // running transcript per realtime item while its deltas stream in
  const rtTextRef = useRef<Record<string, string>>({});
  // timers that clear an unresolved "…" user placeholder (see handleEvent)
  const placeholderTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const retryRef = useRef(0); // reconnect attempts for the current voice session

  // ---- per-session debug log (Sam wants every realtime call recorded) ----
  // The browser holds WebRTC directly to OpenAI, so the server can't see the
  // transcript/turn events. We batch them here and POST to /api/voice/rt/log,
  // which appends JSONL to data/converse-logs/ (git-ignored, local). Buffered +
  // flushed on a timer / at teardown so a crash mid-call still leaves a trail.
  const sessionIdRef = useRef<string | null>(null);
  const logBufRef = useRef<Record<string, unknown>[]>([]);
  const logTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One debug-log id per Converse surface — spans text turns, the voice call, and
  // any reconnects, so a single conversation is one file.
  function ensureSessionId() {
    if (!sessionIdRef.current) {
      sessionIdRef.current = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    }
  }

  function flushLog() {
    const sid = sessionIdRef.current;
    if (logTimerRef.current) {
      clearTimeout(logTimerRef.current);
      logTimerRef.current = null;
    }
    if (!sid || logBufRef.current.length === 0) return;
    const events = logBufRef.current;
    logBufRef.current = [];
    // fire-and-forget; keepalive lets it survive the surface closing
    void fetch("/api/voice/rt/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid, events }),
      keepalive: true,
    }).catch(() => {
      /* best-effort debug log */
    });
  }

  function logEvent(kind: string, data: Record<string, unknown>) {
    if (!sessionIdRef.current) return;
    logBufRef.current.push({ t: new Date().toISOString(), kind, ...data });
    if (logBufRef.current.length >= 20) flushLog();
    else if (!logTimerRef.current) logTimerRef.current = setTimeout(flushLog, 2500);
  }

  function toggleSounds() {
    const next = !soundsMuted;
    setSoundsMuted(next); // earcons module (persists + stops any working loop)
    setSoundsMutedState(next); // local UI state for the toggle icon
  }

  // Resolve a user-speech transcript onto its placeholder. Prefer the matching
  // item id; fall back to the most recent unresolved "…" placeholder when ids
  // don't line up (or none was given) so the text can't land after the reply.
  function resolveUserTranscript(itemId: string | undefined, text: string) {
    if (itemId && placeholderTimers.current[itemId]) {
      clearTimeout(placeholderTimers.current[itemId]);
      delete placeholderTimers.current[itemId];
    }
    setLog((l) => {
      let idx = itemId ? l.findIndex((e) => e.id === itemId) : -1;
      if (idx < 0) {
        for (let i = l.length - 1; i >= 0; i--) {
          if (l[i].role === "you" && l[i].text === "…") {
            idx = i;
            break;
          }
        }
      }
      let next: LogEntry[];
      if (idx >= 0) {
        next = [...l];
        next[idx] = { ...next[idx], role: "you", text };
      } else {
        next = [...l.slice(-60), { id: itemId, role: "you", text }];
      }
      logRef.current = next;
      return next;
    });
  }

  // keep the thread pinned to the latest turn
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, sending, mode]);

  // Flush any buffered debug events when the whole surface unmounts (covers a
  // text-only conversation that never mounted the voice effect).
  useEffect(() => () => flushLog(), []);

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
    // Only send attachments that finished (drop still-uploading / failed ones).
    const atts = attachments.filter((a) => a.status === "ready");
    if ((!text && atts.length === 0) || sending || attachments.some((a) => a.status === "uploading")) return;
    if (!startedAtRef.current) startedAtRef.current = Date.now();
    // Outgoing content: a plain string when nothing's attached, else text + parts
    // (images as inline base64 image_url; files as Files-API file_id references).
    type Part =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
      | { type: "file"; file: { file_id: string } };
    const parts: Part[] = [];
    if (text) parts.push({ type: "text", text });
    for (const a of atts) {
      if (a.kind === "image" && a.dataUrl) parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
      else if (a.kind === "file" && a.fileId) parts.push({ type: "file", file: { file_id: a.fileId } });
    }
    const hasAttParts = parts.some((p) => p.type !== "text");
    const userContent: string | Part[] = hasAttParts ? parts : text;
    const messages = [
      ...threadTurns().map((e) => ({ role: e.role === "you" ? "user" : "assistant", content: e.text })),
      { role: "user", content: userContent },
    ];
    appendUser(
      text,
      atts.filter((a) => a.kind === "image" && a.dataUrl).map((a) => a.dataUrl as string),
      atts.filter((a) => a.kind === "file").map((a) => a.name),
    );
    setAttachments([]);
    ensureSessionId();
    logEvent("chat_user", { text, images: atts.filter((a) => a.kind === "image").length, files: atts.filter((a) => a.kind === "file").length });
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
        toolCalls?: { name: string; args: Record<string, unknown>; ok?: boolean; result?: string }[];
      };
      for (const tc of data.toolCalls ?? []) appendTool(tc.name, tc.args, tc.ok, tc.result);
      if (data.text) append("assistant", data.text);
      logEvent("chat_assistant", { text: data.text, toolCalls: data.toolCalls ?? [] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      logEvent("chat_error", { message: msg });
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
    setMuted(false);
  }

  // Mute/unmute the outgoing mic without tearing down the session. Disabling the
  // track stops audio reaching the model (so it won't hear you or ambient noise)
  // while the connection stays live.
  function toggleMute() {
    const stream = micRef.current;
    if (!stream) return;
    const next = !muted;
    for (const t of stream.getAudioTracks()) t.enabled = !next;
    setMuted(next);
  }

  // run a tool call the model relays over the data channel
  async function handleFunctionCall(name: string, callId: string, argsJson: string) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson || "{}");
    } catch {
      /* leave empty */
    }

    // wait_for_user: the model chose to stay silent on ambient noise/silence.
    // Acknowledge the call but DON'T trigger a response (no forced reply) and
    // don't clutter the thread with a chip.
    if (name === "wait_for_user") {
      logEvent("tool", { name, args, waiting: true });
      const dc = dcRef.current;
      if (dc && dc.readyState === "open") {
        dc.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ ok: true, waiting: true }) },
          }),
        );
      }
      return;
    }

    startWorking(); // subtle "something's happening" heartbeat while the tool runs
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
    } finally {
      stopWorking();
    }
    // Friendly outcome chip (not raw args): parse the tool result for ok/error.
    let ok: boolean | undefined;
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      ok = parsed?.error ? false : ((parsed?.ok as boolean | undefined) ?? true);
    } catch {
      /* unknown outcome */
    }
    logEvent("tool", { name, args, ok, output: output.slice(0, 2000) });
    appendTool(name, args, ok, output);
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
    // Debug log: every realtime event, verbatim, to this session's JSONL.
    logEvent("rt", { event: ev });
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
      // A TTL clears it if the transcription never arrives (noise-triggered VAD).
      case "input_audio_buffer.speech_started":
        if (ev.item_id) {
          const id = ev.item_id as string;
          upsert(id, "you", "…");
          if (placeholderTimers.current[id]) clearTimeout(placeholderTimers.current[id]);
          placeholderTimers.current[id] = setTimeout(() => {
            delete placeholderTimers.current[id];
            setLog((l) => {
              const idx = l.findIndex((e) => e.id === id);
              if (idx < 0 || l[idx].text !== "…") return l; // resolved meanwhile
              const next = l.filter((_, i) => i !== idx);
              logRef.current = next;
              return next;
            });
          }, PLACEHOLDER_TTL_MS);
        }
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
        // Resolve onto the pinned placeholder (id match, else newest unresolved).
        if (ev.transcript) resolveUserTranscript(ev.item_id, ev.transcript);
        break;
      case "error":
        setError(ev.error?.message ?? "realtime error");
        playError();
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
        ensureSessionId();
        primeAudio(); // unlock WebAudio on this user-gesture-initiated connect
        logEvent("session_start", { user, model: MODEL, attempt: retryRef.current });
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
        // Auto-reconnect once or twice on a dropped connection before giving up.
        pc.onconnectionstatechange = () => {
          const st = pc.connectionState;
          logEvent("conn", { state: st });
          if (st === "failed" && !cancelled) {
            if (retryRef.current < 2) {
              retryRef.current++;
              setConnNonce((n) => n + 1); // effect cleanup tears down, then reconnects
            } else {
              setError("voice connection lost — tap End and start again");
              setVoiceStatus("error");
              playError();
            }
          }
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
          retryRef.current = 0; // a clean open clears the reconnect budget
          setVoiceStatus("live");
          playReady(); // soft chime: the session is listening — start talking
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
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setVoiceStatus("error");
        playError();
        logEvent("error", { message: msg });
      }
    }

    void connect();
    return () => {
      cancelled = true;
      stopWorking();
      teardownVoice();
      flushLog(); // persist whatever's buffered before we drop the session
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, connNonce]);

  // ---------------- close / save ----------------
  function buildTranscript(): string {
    const body = threadTurns()
      .map((e) => `**${e.role === "you" ? "You" : "Assistant"}:** ${e.text}`)
      .join("\n\n");
    return `## Transcript\n\n${body}\n`;
  }

  // Close the surface → tear down voice if live, AUTO-SAVE the conversation to the
  // vault (no manual review step — Sam 2026-07-29: "just automatically save it
  // somewhere so I can revisit these"), then close. Best-effort: we still close if
  // the save fails (the raw per-session debug log under data/converse-logs is the
  // backstop). Every conversation with real turns is kept.
  async function closeSurface() {
    if (mode === "voice") setMode("chat"); // effect cleanup tears the session down
    flushLog();
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
    const noteTitle = firstUser ? firstUser.slice(0, 60) : `Voice note ${dateStr}`;
    const model = models.join(" + ") || MODEL;
    const noteProps = { date: dateStr, duration: formatDuration(durMs), model };

    // (1) human-friendly markdown note in the vault (Calyx export, unchanged).
    try {
      await fetch("/api/voice/rt/save-conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: noteTitle, tags: [], properties: noteProps, transcript: buildTranscript() }),
        keepalive: true,
      });
    } catch {
      /* raw debug log is the backstop */
    }

    // (2) structured record for the universal view — the machine-readable source
    // of truth (keeps tool calls + attachments the markdown drops). Written behind
    // the storage adapter (see docs/converse-universal-view.md).
    ensureSessionId();
    const turns = logRef.current
      .filter((e) => !(e.role === "you" && e.text === "…"))
      .filter((e) => e.text.trim() || (e.images && e.images.length) || (e.files && e.files.length) || e.tool)
      .map((e) => ({
        role: e.role,
        text: e.text,
        ...(e.ok !== undefined ? { ok: e.ok } : {}),
        ...(e.tool ? { tool: e.tool } : {}),
        ...(e.images ? { images: e.images } : {}),
        ...(e.files ? { files: e.files } : {}),
      }));
    try {
      await fetch("/api/converse/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: sessionIdRef.current,
          title: noteTitle,
          date: dateStr,
          model,
          durationMs: durMs,
          createdAt: new Date().toISOString(),
          turns,
        }),
        keepalive: true,
      });
    } catch {
      /* non-fatal — the markdown note + debug log still exist */
    }
    onClose();
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
  const uploading = attachments.some((a) => a.status === "uploading");

  return (
    <div className="fixed inset-0 z-[1000] flex flex-col bg-background text-foreground">
      <audio ref={audioRef} autoPlay />
      {historyOpen && <ConversationHistory onClose={() => setHistoryOpen(false)} />}

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
            onClick={() => setHistoryOpen(true)}
            aria-label="Past conversations"
            title="Past conversations"
          >
            <History className="size-4" />
          </button>
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
            <ConversationTurns turns={log} />
            {sending && <div className="text-sm text-muted-foreground">…</div>}
          </div>
        )}
      </div>

      {mode === "voice" ? (
        <div className="flex items-center justify-center gap-3 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {voiceStatus === "live" && <VoiceMeter stream={micRef.current} active={voiceStatus === "live"} />}
          <span className="text-sm text-muted-foreground">
            {voiceStatus === "live"
              ? muted
                ? "muted — tap the mic to talk"
                : "voice is live — just talk"
              : voiceStatus === "connecting"
                ? "connecting…"
                : "voice error"}
          </span>
          <button
            type="button"
            className="flex size-9 items-center justify-center rounded-full border border-border text-muted-foreground hover:text-foreground"
            onClick={toggleSounds}
            title={soundsMuted ? "Cue sounds off" : "Cue sounds on"}
            aria-label={soundsMuted ? "Turn cue sounds on" : "Turn cue sounds off"}
          >
            {soundsMuted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
          </button>
          <button
            type="button"
            onClick={toggleMute}
            disabled={voiceStatus !== "live"}
            className={
              muted
                ? "flex size-11 items-center justify-center rounded-full bg-destructive text-destructive-foreground disabled:opacity-50 md:size-9"
                : "flex size-11 items-center justify-center rounded-full border border-border text-foreground disabled:opacity-50 md:size-9"
            }
            title={muted ? "Unmute microphone" : "Mute microphone"}
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          >
            {muted ? <MicOff className="size-5 md:size-4" /> : <Mic className="size-5 md:size-4" />}
          </button>
          <button
            type="button"
            onClick={() => setMode("chat")}
            className="flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground"
            title="Stop voice — back to the keyboard, keeps the conversation"
            aria-label="Stop voice"
          >
            <Square className="size-4" /> Stop
          </button>
        </div>
      ) : dict.active ? (
        // ---- dictation in progress: the shared waveform recorder ----
        <div className="border-t border-border bg-background px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <WaveformRecorderRow rec={dict} />
        </div>
      ) : (
        <div className="border-t border-border bg-background">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-2">
              {attachments.map((a) => (
                <div key={a.id} className="relative">
                  {a.kind === "image" ? (
                    <img
                      src={a.dataUrl}
                      alt={a.name}
                      className="size-16 rounded-lg border border-border object-cover"
                    />
                  ) : (
                    <div
                      className={`flex h-16 max-w-[10rem] items-center gap-2 rounded-lg border px-3 text-xs ${
                        a.status === "failed"
                          ? "border-destructive/40 bg-destructive/10 text-destructive"
                          : "border-border bg-muted/40 text-muted-foreground"
                      }`}
                    >
                      <FileIcon className="size-4 shrink-0" />
                      <div className="min-w-0">
                        <div className="truncate">{a.name}</div>
                        <div className="text-[10px] opacity-70">
                          {a.status === "uploading" ? "uploading…" : a.status === "failed" ? "failed" : "ready"}
                        </div>
                      </div>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:text-foreground"
                    aria-label={`Remove ${a.name}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <form
            className={`flex items-end gap-2 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] ${
              dragging ? "rounded-2xl ring-2 ring-primary/50" : ""
            }`}
            onSubmit={(e) => {
              e.preventDefault();
              void sendChatText(input);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (!dragging) setDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void addFiles(e.dataTransfer?.files ?? null);
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border text-foreground disabled:opacity-50 md:size-9"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending || attachments.length >= MAX_ATTACHMENTS}
              aria-label="Attach a file or image"
              title="Attach a file or image (PDF, doc, image…)"
            >
              <Paperclip className="size-5 md:size-4" />
            </button>
          <textarea
            ref={inputRef}
            rows={1}
            className="lfg-gfield max-h-[40vh] min-h-11 min-w-0 flex-1 resize-none overflow-y-auto rounded-2xl border-transparent px-4 py-2.5 text-base leading-6 shadow-sm placeholder:text-muted-foreground"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const files = e.clipboardData?.files;
              if (files && Array.from(files).some((f) => f.type.startsWith("image/"))) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter (or ⌘/Ctrl+Enter) inserts a newline.
              if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                void sendChatText(input);
              }
            }}
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
          {/* Morphing button: ◉ voice when empty, ↑ send when there's text or an image. */}
          {hasText || attachments.length > 0 ? (
            <button
              type="submit"
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50 md:size-9"
              disabled={sending || uploading}
              title={uploading ? "Waiting for upload…" : "Send"}
              aria-label="Send"
            >
              <ArrowUp className="size-5 md:size-4" />
            </button>
          ) : (
            <button
              type="button"
              className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border text-foreground disabled:opacity-50 md:size-9"
              onClick={() => {
                retryRef.current = 0;
                setMode("voice");
              }}
              disabled={sending}
              title="Start realtime voice conversation"
              aria-label="Start voice mode"
            >
              <AudioLines className="size-5 md:size-4" />
            </button>
          )}
          </form>
        </div>
      )}
    </div>
  );
}

