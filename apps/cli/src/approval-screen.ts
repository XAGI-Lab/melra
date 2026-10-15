// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Text a terminal shows as text and nothing else. Everything in an approval
 * render except its labels was chosen by the agent asking for approval, and a
 * raw escape sequence in it can erase the line saying so, paint a different
 * effect, and hide the real one: C0 and C1 controls, DEL, and the format
 * characters that reorder or hide text are all spelled out instead.
 */
export function printable(text: string, keepNewlines = false): string {
  return text.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
    (character) =>
      keepNewlines && character === "\n"
        ? character
        : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export interface ApprovalScreenView {
  task: { id: string; approval?: { expiresAt: string } };
  contract: {
    capability: string;
    target: string;
    effect: string;
    risk: string;
    metadata: { goal: string };
  };
  renderDigest: string;
}

/**
 * The approval screen, ending with what MELRA itself vouches for: the full
 * contract first, so however long the agent's content runs it cannot push the
 * effect off the screen, then the trusted summary right above the question.
 */
export function approvalScreen(view: ApprovalScreenView): string {
  const { contract } = view;
  const goal = printable(contract.metadata.goal);
  return [
    printable(JSON.stringify(contract, null, 2), true),
    "\u001b[0m",
    `Task ${view.task.id}, waiting for approval until ${view.task.approval?.expiresAt ?? "unknown"}`,
    `Effect: ${printable(contract.capability)} on ${printable(contract.target)} (${printable(contract.effect)}, ${printable(contract.risk)} risk)`,
    `Goal (stated by the agent, unverified): ${goal.length > 200 ? `${goal.slice(0, 200)}…` : goal}`,
    `Contract digest: ${view.renderDigest}`,
    "",
  ].join("\n");
}
