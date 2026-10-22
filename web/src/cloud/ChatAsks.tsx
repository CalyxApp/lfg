// The agent's questions in a Calyx Cloud chat (LFG plan L3a), drawn above the
// chat's composer with LFG's own Calyx ask card: one question or a batch,
// single or several choices, "other" text, a typed reply. Any device may
// answer; the first answer wins. Once answered the card says so until the
// computer has applied it, then it goes.

import { createContext, useContext } from "react";
import { CalyxAskCard } from "@/components/ask-center";
import { answerParts, answeredTitle, roomAskToCard } from "./asks";
import type { AskAnswerPart } from "./room-state";
import type { ChatAskInfo, ChatAskView } from "./useCloudChats";

export interface ChatAsksValue {
  asksBySid: Record<string, ChatAskView[]>;
  askInfoBySid: Record<string, ChatAskInfo>;
  answer: (chatId: string, askId: string, text: string, answers: AskAnswerPart[]) => void;
}

export const ChatAsksContext = createContext<ChatAsksValue | null>(null);

export function ChatAsksPanel({ chatId }: { chatId: string }) {
  const ctx = useContext(ChatAsksContext);
  const asks = ctx?.asksBySid[chatId] ?? [];
  if (!ctx || !asks.length) return null;
  const info = ctx.askInfoBySid[chatId] ?? { title: "", computer: null };
  return (
    <div className="max-h-[55%] shrink-0 overflow-y-auto border-t border-border/70 px-3 py-2">
      <div className="flex flex-col gap-2">
        {asks.map((v) => (
          <CalyxAskCard
            key={v.ask.id}
            ask={roomAskToCard(v.ask, info.title)}
            source={{
              answer: (text, d) => ctx.answer(chatId, v.ask.id, text, answerParts(v.ask.questions, d.answers, d.picks)),
              busy: v.busy,
              answeredTitle: answeredTitle(v.ask, v.answeredHere, info.computer),
              promise: info.computer
                ? `Your answer goes to ${info.computer}. Any device can answer; the first answer counts.`
                : "Your answer waits here until your computer opens this chat.",
              briefing: v.ask.context,
              filesUnavailable: true,
              error: v.error,
            }}
          />
        ))}
      </div>
    </div>
  );
}
