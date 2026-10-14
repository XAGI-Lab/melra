# Computer-use research

## Implemented control plane

MELRA exposes computer use through the same bounded operation contract as
every other runtime. The current adapters provide:

- read-only capability discovery;
- `inspect`: frontmost window, display geometry, and addressable elements from
  the accessibility tree, or words read off a screenshot with `tesseract` and a
  confidence where there is no tree;
- screenshots with size and SHA-256 artifact evidence;
- normalized or pixel pointer movement, click, and drag, or a `target: { role,
  name }` resolved against `inspect`;
- bounded text entry;
- an allowlist of named keys;
- bounded vertical scroll.

macOS uses typed native adapter scripts and requires OS Screen Recording or
Accessibility permission, and refuses typing while secure input is held.
Windows uses Windows PowerShell and .NET, with UI Automation for the element
tree. Linux supports screenshot tools and `xdotool` on X11 when installed.
Unsupported platforms report capability absence instead of pretending an action
is available.

## Current measurement

Thirty read-only platform capability probes passed:

- success: `30/30`;
- latency: `0.032 ms` p50, `0.052 ms` p95;
- detected adapter on the recorded machine: `macos-native`.

This is a control-plane microbenchmark only. It is not a task-success or
perception score.

## Research findings

- A robust loop is observe → target → act → re-observe → verify.
- Accessibility/semantic targets should be the first tier; vision is a
  fallback when structured UI evidence is absent.
- Coordinates should be resolution-independent where possible and must name
  their coordinate space.
- Focus, active window, display, and secure-input state are part of the safety
  boundary.
- Pixel change alone is weak evidence; the runtime needs a task-specific final
  predicate.
- Previously successful targets can be replay candidates only after drift
  checks and independent validation.

## Honest benchmark status

MELRA has not submitted an official
[OSWorld](https://github.com/xlang-ai/OSWorld) or
[OSWorld-MCP](https://arxiv.org/abs/2510.24563) result. Those environments
measure full agent decision-making, application state, GUI execution, and
goal completion. A public score requires a controlled VM, pinned model and
policy, released traces, and the official evaluator.

## Next gates

Shipped since this page was first written: accessibility-tree inspection and
semantic targeting (macOS and Windows), a screenshot/OCR fallback with
confidence, the Windows adapter, macOS secure-input detection, post-action
`inspect` observation a task can verify with `result_equals`, and replayable
safety fixtures under `evals/scenarios/`. Still open:

- focus verification between approval and action, and multi-display
  verification;
- pre/post screenshot evidence for mutations;
- official OSWorld-MCP subset before any leaderboard claim.
