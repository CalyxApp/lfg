// CreateTaskDrawer — bottom-sheet form to create a new Calyx task via the
// /api/vault/create-task endpoint. Minimal: title (required), priority, due.
// The server calls createContent() from the Calyx CLI shared core and commits
// the new file under the vault's `tasks/` folder.

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { postJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "./ui/drawer";
import { Input } from "./ui/input";

const PRIORITIES = ["low", "normal", "high"] as const;
type Priority = (typeof PRIORITIES)[number];

interface Props {
  open: boolean;
  repo: string;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateTaskDrawer({ open, repo, onClose, onCreated }: Props) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setTitle("");
    setPriority("normal");
    setDue("");
    setError(null);
  }

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await postJson("/api/vault/create-task", {
        repo,
        title: trimmed,
        priority,
        ...(due ? { due } : {}),
      });
      reset();
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o) { reset(); onClose(); }
      }}
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>New Task</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-col gap-4 px-4 pb-2">
          {/* Title */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Title
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title…"
              autoFocus
              className="text-[15px]"
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            />
          </div>

          {/* Priority */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Priority
            </label>
            <div className="flex gap-2">
              {PRIORITIES.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={cn(
                    "flex-1 rounded-xl py-2.5 text-[13px] font-medium capitalize transition-colors",
                    priority === p
                      ? "bg-primary text-white"
                      : "bg-secondary text-muted-foreground hover:bg-secondary/70",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Due date */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Due (optional)
            </label>
            <Input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              className="text-[15px]"
            />
          </div>

          {error ? (
            <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DrawerFooter>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!title.trim() || saving}
            className="flex h-11 items-center justify-center gap-2 rounded-2xl bg-primary text-[15px] font-semibold text-white disabled:opacity-50"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Create Task
          </button>
          <DrawerClose asChild>
            <button
              type="button"
              className="flex h-11 items-center justify-center rounded-2xl bg-secondary text-[15px] font-medium text-muted-foreground"
            >
              Cancel
            </button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
