# @melra/computer-runtime

Screen and input control for [MELRA](https://github.com/XAGI-Lab/melra):
capabilities, inspect, screenshot, click, move, drag, type, key, and scroll,
driven through the host's own automation tooling: native scripts on macOS,
Windows PowerShell and .NET on Windows, and screenshot tools plus `xdotool` on
Linux/X11.

```bash
npm install @melra/computer-runtime
```

```ts
import { ComputerOperationSchema } from "@melra/protocol";
import { ComputerRuntime } from "@melra/computer-runtime";

const computer = new ComputerRuntime({ artifactDirectory });
const report = await computer.execute(
  ComputerOperationSchema.parse({ kind: "computer", action: "capabilities" }),
);
```

Ask `capabilities` first. Desktop control depends on platform tooling and on
permissions the OS grants to the process — on macOS that means Accessibility and
Screen Recording — so the honest answer on many machines is that some actions are
unavailable. `capabilities` reports what this host can actually do instead of
letting a call fail halfway through a sequence; every other action is refused
with `computer_use_unavailable` when the host cannot support it.

Coordinates are validated against the reported screen bounds before an event is
synthesised, and typed text is escaped for the underlying tool rather than
concatenated into a script — `escapeSendKeys` is exported for that reason.

`inspect` is the read that makes the mutations checkable. It reports the
frontmost application, the focused window's title, and the display geometry, so
a task can declare "the frontmost application is Safari" as a post-condition
with `result_equals` rather than accepting an adapter's `success: true`. Fields
the platform cannot observe — a window title without macOS Accessibility
permission, an application on a bare X session — come back absent rather than
empty, because an empty string would verify as an observation.

On macOS `inspect` also reports `secureInput`, and `type` and `key` are refused
while it is held. Secure keyboard entry means the window server is dropping
synthetic keystrokes, so the alternative is a task that verifies as a success
having typed nothing into a focused password field.

This is the widest-blast-radius capability in MELRA: it drives the same input
devices the human is using, and it is not confined to a workspace the way files
and terminals are. Screenshots capture whatever is on screen, including windows
belonging to other applications, so treat the artifacts as sensitive.

Requires Node.js 22 or newer. Full documentation:
[github.com/XAGI-Lab/melra](https://github.com/XAGI-Lab/melra)

AGPL-3.0-only, or a commercial license from XAGI Labs Private Limited. See
[licensing](https://github.com/XAGI-Lab/melra/blob/main/LICENSING.md).
