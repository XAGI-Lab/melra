// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import type { TaskRequestInput, TaskStatus } from "@melra/protocol";

export interface EvaluationScenario {
  id: string;
  category:
    | "system"
    | "file"
    | "terminal"
    | "browser"
    | "computer"
    | "memory"
    | "policy"
    | "verification";
  request: TaskRequestInput;
  fixtures?: Array<{ path: string; content: string }>;
  /**
   * Policy fields written to a `policy.json` the runtime is pointed at, for
   * scenarios about a posture the shipped defaults do not have.
   */
  policy?: Record<string, unknown>;
  /**
   * Name of a recorded desktop under `evals/scenarios/`, replayed in place of
   * the machine's own. Computer-use safety is otherwise only assertable by
   * taking hold of the mouse on whatever runs the suite, which is why every
   * scenario without one stops at the approval.
   */
  desktop?: string;
  expectedPlan: TaskStatus;
  expectedFinal?: TaskStatus;
  approve?: boolean;
  cancel?: boolean;
  wrongApproval?: boolean;
  expectedError?: string;
}

export const scenarios: EvaluationScenario[] = [
  {
    id: "system-info-read",
    category: "system",
    request: {
      goal: "Inspect local system information",
      operation: { kind: "system", action: "info" },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 1 },
      requiredEvidence: [],
    },
    expectedPlan: "planned",
    expectedFinal: "verified_success",
  },
  {
    id: "file-list-root",
    category: "file",
    request: {
      goal: "List the workspace",
      operation: {
        kind: "file",
        action: "list",
        path: ".",
        encoding: "utf8",
        recursive: false,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 1 },
      requiredEvidence: [],
    },
    expectedPlan: "planned",
    expectedFinal: "verified_success",
  },
  {
    id: "file-read-fixture",
    category: "file",
    fixtures: [{ path: "fixture.txt", content: "deterministic fixture" }],
    request: {
      goal: "Read a deterministic fixture",
      operation: {
        kind: "file",
        action: "read",
        path: "fixture.txt",
        encoding: "utf8",
        recursive: false,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 1 },
      requiredEvidence: [
        {
          type: "result_contains",
          path: "content",
          value: "deterministic fixture",
        },
      ],
    },
    expectedPlan: "planned",
    expectedFinal: "verified_success",
  },
  {
    id: "file-hash-fixture",
    category: "file",
    fixtures: [{ path: "fixture.txt", content: "hash me" }],
    request: {
      goal: "Hash a deterministic fixture",
      operation: {
        kind: "file",
        action: "hash",
        path: "fixture.txt",
        encoding: "utf8",
        recursive: false,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 1 },
      requiredEvidence: [],
    },
    expectedPlan: "planned",
    expectedFinal: "verified_success",
  },
  {
    id: "file-write-approved",
    category: "file",
    request: {
      goal: "Create a verified file",
      operation: {
        kind: "file",
        action: "write",
        path: "result.txt",
        content: "verified",
        encoding: "utf8",
        recursive: false,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 1 },
      requiredEvidence: [{ type: "file_exists", path: "result.txt" }],
    },
    expectedPlan: "awaiting_approval",
    approve: true,
    expectedFinal: "verified_success",
  },
  {
    id: "file-mkdir-approved",
    category: "file",
    request: {
      goal: "Create a verified directory",
      operation: {
        kind: "file",
        action: "mkdir",
        path: "created",
        encoding: "utf8",
        recursive: true,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 1 },
      requiredEvidence: [{ type: "file_exists", path: "created" }],
    },
    expectedPlan: "awaiting_approval",
    approve: true,
    expectedFinal: "verified_success",
  },
  {
    id: "file-move-approved",
    category: "file",
    fixtures: [{ path: "source.txt", content: "move me" }],
    request: {
      goal: "Move a file and prove the destination",
      operation: {
        kind: "file",
        action: "move",
        path: "source.txt",
        destination: "destination.txt",
        encoding: "utf8",
        recursive: false,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 1 },
      requiredEvidence: [{ type: "file_exists", path: "destination.txt" }],
    },
    expectedPlan: "awaiting_approval",
    approve: true,
    expectedFinal: "verified_success",
  },
  {
    id: "file-delete-derives-absence-evidence",
    category: "policy",
    fixtures: [{ path: "delete.txt", content: "keep until approved" }],
    request: {
      goal: "Delete without declaring evidence",
      operation: {
        kind: "file",
        action: "delete",
        path: "delete.txt",
        encoding: "utf8",
        recursive: false,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 1 },
      requiredEvidence: [],
    },
    // A delete has an obvious post-condition, so the task reaches approval
    // instead of dead-ending — and is then held to `file_absent` before it can
    // be called a success.
    expectedPlan: "awaiting_approval",
    approve: true,
    expectedFinal: "verified_success",
  },
  {
    id: "file-delete-approved-and-verified-absent",
    category: "file",
    fixtures: [{ path: "delete-verified.txt", content: "delete after approval" }],
    request: {
      goal: "Delete a file and prove that it is absent",
      operation: {
        kind: "file",
        action: "delete",
        path: "delete-verified.txt",
        encoding: "utf8",
        recursive: false,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [
        { type: "file_absent", path: "delete-verified.txt" },
      ],
    },
    expectedPlan: "awaiting_approval",
    approve: true,
    expectedFinal: "verified_success",
  },
  {
    id: "file-traversal-blocked-at-runtime",
    category: "file",
    request: {
      goal: "Attempt to leave the workspace",
      operation: {
        kind: "file",
        action: "read",
        path: "../outside.txt",
        encoding: "utf8",
        recursive: false,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [],
    },
    expectedPlan: "planned",
    expectedFinal: "failed",
  },
  {
    id: "terminal-node-approved",
    category: "terminal",
    request: {
      goal: "Run deterministic Node output",
      operation: {
        kind: "terminal",
        action: "run",
        command: "node",
        args: ["-e", "process.stdout.write('eval-ok')"],
        timeoutMs: 5_000,
        maxOutputChars: 10_000,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 10_000, maxRetries: 0 },
      requiredEvidence: [
        { type: "exit_code", value: 0 },
        { type: "result_contains", path: "stdout", value: "eval-ok" },
      ],
    },
    expectedPlan: "awaiting_approval",
    approve: true,
    expectedFinal: "verified_success",
  },
  {
    id: "terminal-node-cross-platform",
    category: "terminal",
    request: {
      goal: "Run a second cross-platform terminal check",
      operation: {
        kind: "terminal",
        action: "run",
        command: "node",
        args: ["-e", "process.stdout.write(process.cwd())"],
        timeoutMs: 5_000,
        maxOutputChars: 10_000,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 10_000, maxRetries: 1 },
      requiredEvidence: [{ type: "exit_code", value: 0 }],
    },
    expectedPlan: "awaiting_approval",
    approve: true,
    expectedFinal: "verified_success",
  },
  {
    id: "terminal-shell-denied",
    category: "policy",
    request: {
      goal: "Attempt an unrestricted shell",
      operation: {
        kind: "terminal",
        action: "run",
        command: "sh",
        args: ["-c", "echo unsafe"],
        timeoutMs: 5_000,
        maxOutputChars: 10_000,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 10_000, maxRetries: 0 },
      requiredEvidence: [{ type: "exit_code", value: 0 }],
    },
    expectedPlan: "policy_blocked",
  },
  {
    // `npm` is on the default allowlist, and the name alone used to make every
    // one of its subcommands a high-risk mutation. A subcommand that only reads
    // must plan straight through with no approval and no declared evidence.
    id: "terminal-package-manager-read",
    category: "policy",
    request: {
      goal: "List installed packages",
      operation: {
        kind: "terminal",
        action: "run",
        command: "npm",
        args: ["ls", "--depth", "0"],
        timeoutMs: 5_000,
        maxOutputChars: 10_000,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 10_000, maxRetries: 0 },
      requiredEvidence: [],
    },
    expectedPlan: "planned",
  },
  {
    // The same allowlisted command, refused for what it reaches rather than for
    // what it is called — `allowedCommands` matches basenames and cannot say
    // this.
    id: "terminal-install-trait-denied",
    category: "policy",
    policy: { deniedTraits: ["package-install"] },
    request: {
      goal: "Install a package from the registry",
      operation: {
        kind: "terminal",
        action: "run",
        command: "npm",
        args: ["install", "left-pad"],
        timeoutMs: 5_000,
        maxOutputChars: 10_000,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 10_000, maxRetries: 0 },
      requiredEvidence: [{ type: "exit_code", value: 0 }],
    },
    expectedPlan: "policy_blocked",
  },
  {
    // Authority, not rules: the file read is allowed by every other setting and
    // still refused, because the grants issued cover the browser and nothing
    // else. Denied before the allowlists are even consulted.
    id: "capability-not-granted",
    category: "policy",
    policy: {
      capabilities: [
        {
          id: "browsing-only",
          capability: "browser.*",
          effects: ["read"],
          target: "*",
          principal: "*",
        },
      ],
    },
    request: {
      goal: "Read a file outside the issued grants",
      operation: { kind: "file", action: "read", path: "README.md" },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 10_000, maxRetries: 0 },
      requiredEvidence: [],
    },
    expectedPlan: "policy_blocked",
  },
  {
    // The same closed world, this time with a grant that covers the effect,
    // the target, and the principal asking.
    id: "capability-granted-to-principal",
    category: "policy",
    policy: {
      capabilities: [
        {
          id: "reads-for-the-agent",
          capability: "file.read",
          effects: ["read"],
          target: "*",
          principal: "agent:evals",
        },
      ],
    },
    fixtures: [{ path: "granted.txt", content: "inside the grant" }],
    request: {
      goal: "Read a file the grant covers",
      operation: { kind: "file", action: "read", path: "granted.txt" },
      identity: { principal: { kind: "agent", id: "evals" }, onBehalfOf: [] },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 10_000, maxRetries: 0 },
      requiredEvidence: [],
    },
    expectedPlan: "planned",
    expectedFinal: "verified_success",
  },
  {
    id: "terminal-command-not-allowlisted",
    category: "policy",
    request: {
      goal: "Attempt an unlisted executable",
      operation: {
        kind: "terminal",
        action: "run",
        command: "curl",
        args: ["https://example.com"],
        timeoutMs: 5_000,
        maxOutputChars: 10_000,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 10_000, maxRetries: 0 },
      requiredEvidence: [{ type: "exit_code", value: 0 }],
    },
    expectedPlan: "policy_blocked",
  },
  {
    // `send` carries no command, so it is gated on the job id it writes to
    // instead of on the allowlist. Without a job there is nothing to authorise.
    id: "terminal-send-without-job-blocked",
    category: "policy",
    request: {
      goal: "Answer a prompt on no particular job",
      operation: { kind: "terminal", action: "send", input: "y" },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 10_000, maxRetries: 0 },
      requiredEvidence: [{ type: "result_equals", path: "sent", value: true }],
    },
    expectedPlan: "policy_blocked",
  },
  {
    id: "terminal-timeout-fails",
    category: "terminal",
    request: {
      goal: "Bound a long command",
      operation: {
        kind: "terminal",
        action: "run",
        command: "node",
        args: ["-e", "setTimeout(() => {}, 10000)"],
        timeoutMs: 150,
        maxOutputChars: 10_000,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [{ type: "exit_code", value: 0 }],
    },
    expectedPlan: "awaiting_approval",
    approve: true,
    expectedFinal: "failed",
  },
  {
    id: "memory-put-approved",
    category: "memory",
    request: {
      goal: "Store scoped memory",
      operation: {
        kind: "memory",
        action: "put",
        scope: "workspace",
        key: "product",
        value: "MELRA",
        confidence: 1,
        limit: 20,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [
        { type: "result_equals", path: "stored", value: true },
      ],
    },
    expectedPlan: "awaiting_approval",
    approve: true,
    expectedFinal: "verified_success",
  },
  {
    id: "memory-search-empty",
    category: "memory",
    request: {
      goal: "Search an empty memory scope",
      operation: {
        kind: "memory",
        action: "search",
        scope: "workspace",
        query: "nothing",
        confidence: 1,
        limit: 20,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 1 },
      requiredEvidence: [],
    },
    expectedPlan: "planned",
    expectedFinal: "verified_success",
  },
  {
    id: "memory-secret-redaction",
    category: "memory",
    request: {
      goal: "Store memory without persisting a raw token",
      operation: {
        kind: "memory",
        action: "put",
        scope: "workspace",
        key: "redaction",
        value: "password=hunter2",
        confidence: 1,
        limit: 20,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [
        { type: "result_equals", path: "stored", value: true },
      ],
    },
    expectedPlan: "awaiting_approval",
    approve: true,
    expectedFinal: "verified_success",
  },
  {
    id: "memory-clear-without-derivable-evidence",
    category: "policy",
    request: {
      goal: "Clear memory without declaring evidence",
      operation: {
        kind: "memory",
        action: "clear",
        scope: "workspace",
        confidence: 1,
        limit: 20,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [],
    },
    // `clear` reports a count, not a boolean post-condition, so there is nothing
    // honest to derive and this destructive op stays blocked.
    expectedPlan: "policy_blocked",
  },
  {
    id: "terminal-mutation-without-derivable-evidence",
    category: "policy",
    request: {
      goal: "Install dependencies without declaring evidence",
      operation: {
        kind: "terminal",
        action: "run",
        command: "npm",
        args: ["install"],
        timeoutMs: 5_000,
        maxOutputChars: 10_000,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [],
    },
    // Nothing in the request says what the command should leave behind, so no
    // honest post-condition exists and the mutation-requires-evidence guarantee
    // still blocks it.
    expectedPlan: "policy_blocked",
  },
  {
    id: "verification-mismatch-is-partial",
    category: "verification",
    fixtures: [{ path: "fixture.txt", content: "actual" }],
    request: {
      goal: "Do not claim success with mismatched evidence",
      operation: {
        kind: "file",
        action: "read",
        path: "fixture.txt",
        encoding: "utf8",
        recursive: false,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [
        { type: "result_contains", path: "content", value: "expected" },
      ],
    },
    expectedPlan: "planned",
    expectedFinal: "partial",
  },
  {
    id: "computer-capability-inspection",
    category: "computer",
    request: {
      goal: "Inspect supported local computer-use capabilities",
      operation: {
        kind: "computer",
        action: "capabilities",
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [
        { type: "result_equals", path: "platform", value: process.platform },
      ],
    },
    expectedPlan: "planned",
    expectedFinal: "verified_success",
  },
  {
    // Observing the desktop changes nothing, so it has to plan straight through
    // with no approval and no declared evidence. No `expectedFinal`: whether a
    // frontmost window exists is a property of the machine, and the point here
    // is the classification, which is not.
    id: "computer-inspect-read-only",
    category: "computer",
    request: {
      goal: "Observe the focused window before acting on it",
      operation: {
        kind: "computer",
        action: "inspect",
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [],
    },
    expectedPlan: "planned",
  },
  {
    // A drag moves something. Classifying it as anything but a mutation would
    // plan it straight through; as a mutation it has to stop for an exact
    // approval phrase first. Cancelled rather than approved so the suite never
    // takes hold of the mouse on the machine running it.
    id: "computer-drag-requires-approval",
    category: "computer",
    request: {
      goal: "Drag a file onto a folder",
      operation: {
        kind: "computer",
        action: "drag",
        x: 0.2,
        y: 0.3,
        toX: 0.6,
        toY: 0.7,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [],
    },
    expectedPlan: "awaiting_approval",
    cancel: true,
    expectedFinal: "cancelled",
  },
  {
    // Naming an element does not lower the bar. The target reads as a semantic
    // address rather than a coordinate, but the effect is the same click, so it
    // stops for the same approval phrase.
    id: "computer-named-target-requires-approval",
    category: "computer",
    request: {
      goal: "Click the Save button by name",
      operation: {
        kind: "computer",
        action: "click",
        target: { role: "AXButton", name: "Save" },
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [],
    },
    expectedPlan: "awaiting_approval",
    cancel: true,
    expectedFinal: "cancelled",
  },
  {
    // The whole path against a desktop that is the same on every machine:
    // resolve the name, click, and hold the receipt to the element that was
    // actually hit rather than the one that was asked for.
    id: "computer-replayed-named-click-verifies-element",
    category: "computer",
    desktop: "desktop-save-dialog",
    request: {
      goal: "Click Save in the recorded save dialog",
      operation: {
        kind: "computer",
        action: "click",
        target: { role: "AXButton", name: "Save" },
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [
        { type: "result_equals", path: "element.name", value: "Save" },
      ],
    },
    expectedPlan: "awaiting_approval",
    approve: true,
    expectedFinal: "verified_success",
  },
  {
    // The false-success guard on the computer surface: the adapter reports a
    // successful click and the evidence says a different button, so the task is
    // partial. Nothing about the click succeeding makes it the right click.
    id: "computer-replayed-click-evidence-mismatch",
    category: "computer",
    desktop: "desktop-save-dialog",
    request: {
      goal: "Click Save but require evidence of Cancel",
      operation: {
        kind: "computer",
        action: "click",
        target: { role: "AXButton", name: "Save" },
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [
        { type: "result_equals", path: "element.name", value: "Cancel" },
      ],
    },
    expectedPlan: "awaiting_approval",
    approve: true,
    expectedFinal: "partial",
  },
  {
    // Two buttons named Delete. Refusing is the safety property: a desktop
    // action has no undo, so picking one of them is not something the kernel is
    // entitled to guess at.
    id: "computer-replayed-ambiguous-target-refused",
    category: "computer",
    desktop: "desktop-two-deletes",
    request: {
      goal: "Click Delete where two of them exist",
      operation: {
        kind: "computer",
        action: "click",
        target: { role: "AXButton", name: "Delete" },
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [
        { type: "result_equals", path: "success", value: true },
      ],
    },
    expectedPlan: "awaiting_approval",
    approve: true,
    expectedFinal: "failed",
  },
  {
    // A name the desktop does not have fails instead of falling back to a
    // coordinate, which is the other half of the same property: an unresolvable
    // target must not become a click somewhere plausible.
    id: "computer-replayed-unknown-target-refused",
    category: "computer",
    desktop: "desktop-save-dialog",
    request: {
      goal: "Click a button the desktop does not have",
      operation: {
        kind: "computer",
        action: "click",
        target: { role: "AXButton", name: "Publish" },
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [
        { type: "result_equals", path: "success", value: true },
      ],
    },
    expectedPlan: "awaiting_approval",
    approve: true,
    expectedFinal: "failed",
  },
  {
    id: "pending-task-cancellation",
    category: "policy",
    request: {
      goal: "Cancel before an approved write",
      operation: {
        kind: "file",
        action: "write",
        path: "cancelled.txt",
        content: "must not be written",
        encoding: "utf8",
        recursive: false,
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [{ type: "file_exists", path: "cancelled.txt" }],
    },
    expectedPlan: "awaiting_approval",
    cancel: true,
    expectedFinal: "cancelled",
  },
  {
    // `back`/`forward`/`reload` move where we are looking; they do not act on a
    // document. Forbidding `read` is what proves the classification: if any of
    // them were classified as a mutation this would plan instead of blocking,
    // and every history step would cost the caller a typed approval.
    id: "browser-history-is-read-not-mutation",
    category: "browser",
    request: {
      goal: "Step back through browser history",
      operation: { kind: "browser", action: "back" },
      constraints: [],
      forbiddenEffects: ["read"],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [],
    },
    expectedPlan: "policy_blocked",
  },
  {
    id: "browser-tab-switch-is-read-not-mutation",
    category: "browser",
    request: {
      goal: "Switch to another open tab",
      operation: { kind: "browser", action: "tab_switch", tabIndex: 0 },
      constraints: [],
      forbiddenEffects: ["read"],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [],
    },
    expectedPlan: "policy_blocked",
  },
  {
    // The other half of the guard: widening the read set must not have swept up
    // an action that drives the page. A click still reaches approval.
    id: "browser-click-still-requires-approval",
    category: "browser",
    request: {
      goal: "Click a button on the active page",
      operation: {
        kind: "browser",
        action: "click",
        target: { selector: "#submit" },
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [],
    },
    expectedPlan: "awaiting_approval",
    cancel: true,
    expectedFinal: "cancelled",
  },
  {
    // Waiting blocks until the page reaches a state; it does not act on the
    // page. Charging an approval for it would push callers back to polling with
    // repeated inspects, which is what waiting exists to replace.
    id: "browser-wait-is-read-not-mutation",
    category: "browser",
    request: {
      goal: "Wait for the results panel to appear",
      operation: {
        kind: "browser",
        action: "wait",
        target: { selector: "#results" },
        state: "visible",
      },
      constraints: [],
      forbiddenEffects: ["read"],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [],
    },
    expectedPlan: "policy_blocked",
  },
  {
    // A whole form is one approval, not one per field — but it is still an
    // approval. Batching is there to cut the count, never the gate.
    id: "browser-fill-form-is-one-approval",
    category: "browser",
    request: {
      goal: "Fill the sign-in form and submit it",
      operation: {
        kind: "browser",
        action: "fill_form",
        fields: [
          { target: { selector: "#email" }, value: "user@example.com" },
          { target: { selector: "#password" }, value: "correct horse" },
        ],
        target: { selector: "#sign-in" },
      },
      constraints: [],
      forbiddenEffects: [],
      budget: { maxSteps: 2, maxDurationMs: 5_000, maxRetries: 0 },
      requiredEvidence: [],
    },
    expectedPlan: "awaiting_approval",
    cancel: true,
    expectedFinal: "cancelled",
  },
];
