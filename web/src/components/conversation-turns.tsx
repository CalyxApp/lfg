// conversation-turns.tsx — shared per-turn renderer for Converse.
//
// Used by BOTH the live chat thread (converse.tsx) and the history viewer
// (conversation-history.tsx) so they render identically and can't drift. Returns
// a fragment of turn rows; the caller supplies the scroll container / gap wrapper.

import { marked } from "marked";
import { File as FileIcon } from "lucide-react";
import { ToolCard, type ToolDetail } from "./tool-card";

export type ConversationTurn = {
  role: "you" | "assistant" | "tool" | "system";
  text: string;
  ok?: boolean;
  tool?: ToolDetail;
  images?: string[];
  files?: string[];
};

export function ConversationTurns({ turns }: { turns: ConversationTurn[] }) {
  return (
    <>
      {turns.map((e, i) =>
        e.role === "you" ? (
          e.text === "…" ? (
            // Distinct "we're hearing you" state (not a real turn yet) vs a
            // finished user bubble — the transcript lands a beat later.
            <div key={i} className="ml-auto w-fit max-w-[85%] text-sm italic text-muted-foreground" aria-live="polite">
              transcribing…
            </div>
          ) : (
            <div key={i} className="ml-auto flex w-fit max-w-[85%] flex-col items-end gap-1">
              {e.images && e.images.length > 0 && (
                <div className="flex flex-wrap justify-end gap-1">
                  {e.images.map((src, k) => (
                    <img
                      key={k}
                      src={src}
                      alt="attachment"
                      className="max-h-40 rounded-lg border border-border object-cover"
                    />
                  ))}
                </div>
              )}
              {e.files && e.files.length > 0 && (
                <div className="flex flex-wrap justify-end gap-1">
                  {e.files.map((name, k) => (
                    <span
                      key={k}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground"
                    >
                      <FileIcon className="size-3.5 shrink-0" />
                      <span className="max-w-[12rem] truncate">{name}</span>
                    </span>
                  ))}
                </div>
              )}
              {e.text && (
                <div className="msg-text markdown user-bubble whitespace-pre-wrap text-base">{e.text}</div>
              )}
            </div>
          )
        ) : e.role === "assistant" ? (
          <div
            key={i}
            className="msg-text markdown max-w-full text-base"
            dangerouslySetInnerHTML={{ __html: marked.parse(e.text, { async: false }) as string }}
          />
        ) : e.role === "tool" ? (
          <div key={i} className="flex">
            {e.tool ? (
              <ToolCard label={e.text} detail={e.tool} />
            ) : (
              <span
                className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                  e.ok === false
                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                    : "border-border bg-muted/40 text-muted-foreground"
                }`}
              >
                {e.ok === false ? "✗" : "✓"} {e.text}
              </span>
            )}
          </div>
        ) : (
          <div key={i} className="text-center text-xs text-muted-foreground">
            {e.text}
          </div>
        ),
      )}
    </>
  );
}
