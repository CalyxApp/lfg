// The agent's questions in a Calyx Cloud chat, drawn with LFG's own Calyx ask
// card (components/ask-center.tsx) and answered through the chat room (LFG
// plan L3a). Pure: what the card shows, and what the room is sent.

import type { CalyxAsk } from "@/components/ask-center";
import type { AskAnswerPart, AskQuestionData, RoomAsk } from "./room-state";

/** A room question in the shape LFG's ask card draws. */
export function roomAskToCard(ask: RoomAsk, chatTitle: string): CalyxAsk {
  return {
    id: ask.id,
    // A vault task's address on your own server; a room question has none.
    path: "",
    repo: "",
    title: chatTitle || "This chat",
    questions: ask.questions.map((q) => ({
      text: q.text,
      header: q.header,
      options: (q.options ?? []).map((o) => ({
        label: o.label,
        description: o.description,
        recommended: o.recommended,
        preview: o.previews?.[0] ?? o.preview,
      })),
      multiSelect: q.multiSelect,
      allowOther: q.allowOther,
      attachments: q.attachments,
    })),
    answered: ask.status !== "open",
    answer: ask.answer?.text,
    blockedAt: ask.createdAt,
  };
}

/**
 * Each question's answer as the room takes it: the options chosen, by id, or
 * what was typed as a note. The card hands over, per question, an option's
 * label, several labels joined by ", " (with `picks`, the labels themselves),
 * or typed text.
 */
export function answerParts(questions: AskQuestionData[], answers: string[], picks: string[][]): AskAnswerPart[] {
  const parts: AskAnswerPart[] = [];
  questions.forEach((q, i) => {
    const said = (answers[i] ?? "").trim();
    if (!said) return;
    const questionId = q.id ?? `q${i + 1}`;
    const options = q.options ?? [];
    const idOf = (label: string) => options.find((o) => o.label === label)?.id;
    const chosen = q.multiSelect && picks[i]?.length && picks[i].join(", ") === said ? picks[i] : [said];
    const ids = chosen.map(idOf);
    if (ids.length && ids.every((id): id is string => !!id)) parts.push({ questionId, optionIds: ids });
    else parts.push({ questionId, optionIds: [], note: said });
  });
  return parts;
}

/** The answered card's headline. */
export function answeredTitle(ask: RoomAsk, answeredHere: boolean, computer: string | null): string {
  if (answeredHere || !ask.answer) return `Answered — waiting for ${computer || "your computer"}`;
  return `Answered on ${ask.answer.from}`;
}
