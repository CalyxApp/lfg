// tool-card.tsx — Converse tool-call chip that expands to preview what happened.
//
// Sam 2026-07-29: "if it's doing a tool call or creating something, I'd like to
// preview it — click on the thing and it opens up a bit in the chat." The
// collapsed state is the familiar friendly chip (per-tool icon + one-line label +
// ✓/✗ colour); clicking reveals the tool's Input (args) and Result (output),
// pretty-printed. Used for both voice and typed tool calls.

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ChevronRight,
  Search,
  Globe,
  Info,
  List,
  FolderOpen,
  FileText,
  FilePlus,
  FolderPlus,
  Pencil,
  Wrench,
} from "lucide-react";

export type ToolDetail = {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  ok?: boolean;
};

const ICONS: Record<string, LucideIcon> = {
  search: Search,
  web_search: Globe,
  describe_vault: Info,
  list_by_type: List,
  browse: FolderOpen,
  read: FileText,
  create: FilePlus,
  create_project: FolderPlus,
  update: Pencil,
};

function pretty(s?: string): string {
  if (!s) return "";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

export function ToolCard({ label, detail }: { label: string; detail: ToolDetail }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[detail.name] ?? Wrench;
  const failed = detail.ok === false;
  const argsStr = detail.args && Object.keys(detail.args).length ? JSON.stringify(detail.args, null, 2) : "";
  const resStr = pretty(detail.result);
  const expandable = !!(argsStr || resStr);

  return (
    <div className="w-fit max-w-full">
      <button
        type="button"
        onClick={() => expandable && setOpen((o) => !o)}
        className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
          failed
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : "border-border bg-muted/40 text-muted-foreground"
        } ${expandable ? "cursor-pointer hover:bg-muted/70" : "cursor-default"}`}
        aria-expanded={expandable ? open : undefined}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        {expandable && (
          <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        )}
      </button>
      {open && expandable && (
        <div className="mt-1 max-w-full overflow-hidden rounded-lg border border-border bg-muted/30 text-xs">
          {argsStr && (
            <div className="border-b border-border px-3 py-2">
              <div className="mb-1 font-medium text-muted-foreground">Input</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
                {argsStr}
              </pre>
            </div>
          )}
          {resStr && (
            <div className="px-3 py-2">
              <div className="mb-1 font-medium text-muted-foreground">Result</div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
                {resStr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
