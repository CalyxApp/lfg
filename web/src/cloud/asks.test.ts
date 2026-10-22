// The agent's questions in a Calyx Cloud chat (LFG plan L3a).
// Run: bun test web/src/cloud   (from the repo root)

import { describe, expect, test } from "bun:test";
import { answerParts, answeredTitle, roomAskToCard } from "./asks";
import type { AskQuestionData, RoomAsk } from "./room-state";

const QUESTIONS: AskQuestionData[] = [
  {
    id: "q1",
    text: "Which layout should the page use?",
    header: "Layout",
    options: [
      { id: "o1", label: "Grid", description: "Cards in rows", recommended: true, previews: ["mockups/grid.html", "mockups/grid.png"] },
      { id: "o2", label: "List" },
    ],
    attachments: ["notes/brief.md"],
  },
  { id: "q2", text: "Which colours?", header: "Colours", multiSelect: true, allowOther: true, options: [{ id: "o1", label: "Light" }, { id: "o2", label: "Dark" }] },
];

const ASK: RoomAsk = { id: "ask-1", questions: QUESTIONS, context: "Two calls first.", batch: true, createdAt: 7, status: "open" };

describe("roomAskToCard", () => {
  test("draws the room question in LFG's card shape", () => {
    const card = roomAskToCard(ASK, "Plan the week");
    expect(card).toMatchObject({ id: "ask-1", title: "Plan the week", answered: false, blockedAt: 7 });
    expect(card.questions[0]).toEqual({
      text: "Which layout should the page use?",
      header: "Layout",
      options: [
        { label: "Grid", description: "Cards in rows", recommended: true, preview: "mockups/grid.html" },
        { label: "List", description: undefined, recommended: undefined, preview: undefined },
      ],
      multiSelect: undefined,
      allowOther: undefined,
      attachments: ["notes/brief.md"],
    });
    expect(card.questions[1].multiSelect).toBe(true);
    const answered = roomAskToCard({ ...ASK, status: "answered", answer: { text: "Grid", from: "iPhone", at: 9 } }, "");
    expect(answered).toMatchObject({ answered: true, answer: "Grid", title: "This chat" });
  });
});

describe("answerParts", () => {
  test("options by id; several choices; typed text as a note", () => {
    expect(answerParts(QUESTIONS, ["Grid", "Light, Dark"], [["Grid"], ["Light", "Dark"]])).toEqual([
      { questionId: "q1", optionIds: ["o1"] },
      { questionId: "q2", optionIds: ["o1", "o2"] },
    ]);
    expect(answerParts(QUESTIONS, ["Something else entirely", "Blue please"], [[], []])).toEqual([
      { questionId: "q1", optionIds: [], note: "Something else entirely" },
      { questionId: "q2", optionIds: [], note: "Blue please" },
    ]);
    // A single choice made on the last tap, before its pick was stored, still maps by its label.
    expect(answerParts(QUESTIONS.slice(0, 1), ["List"], [[]])).toEqual([{ questionId: "q1", optionIds: ["o2"] }]);
    // A question left unanswered sends nothing for it.
    expect(answerParts(QUESTIONS, ["Grid", ""], [["Grid"], []])).toEqual([{ questionId: "q1", optionIds: ["o1"] }]);
  });

  test("a question or option without an id", () => {
    const loose: AskQuestionData[] = [{ text: "Go?", options: [{ label: "Yes" }] }];
    expect(answerParts(loose, ["Yes"], [["Yes"]])).toEqual([{ questionId: "q1", optionIds: [], note: "Yes" }]);
  });
});

describe("answeredTitle", () => {
  const answered: RoomAsk = { ...ASK, status: "answered", answer: { text: "Grid", from: "MacBook", at: 9 } };
  test("this phone's answer waits for the computer; another device's is named", () => {
    expect(answeredTitle(answered, true, "MacBook Air")).toBe("Answered — waiting for MacBook Air");
    expect(answeredTitle(answered, true, null)).toBe("Answered — waiting for your computer");
    expect(answeredTitle(answered, false, "MacBook Air")).toBe("Answered on MacBook");
  });
});
