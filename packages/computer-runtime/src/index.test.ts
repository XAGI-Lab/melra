// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ComputerOperationSchema, type ComputerOperation } from "@melra/protocol";
import {
  ComputerRuntime,
  matchElement,
  parseOcrElements,
  parseSecureInput,
  type ComputerAdapter,
  type ComputerCapabilities,
  type DesktopElement,
} from "./index.js";

class TestAdapter implements ComputerAdapter {
  readonly calls: string[] = [];
  readonly operations: ComputerOperation[] = [];
  /** What `inspect` reports back; a live desktop is the only other source. */
  elements: DesktopElement[] = [];

  constructor(
    private readonly overrides: Partial<ComputerCapabilities> = {},
  ) {}

  async capabilities(): Promise<ComputerCapabilities> {
    return {
      platform: "darwin",
      adapter: "macos-native",
      available: true,
      screenshot: true,
      pointer: true,
      keyboard: true,
      scroll: true,
      inspect: true,
      elements: true,
      ocr: false,
      drag: true,
      coordinateSpaces: ["normalized", "pixel"],
      limitations: [],
      ...this.overrides,
    };
  }

  async execute(operation: ComputerOperation): Promise<Record<string, unknown>> {
    this.calls.push(operation.action);
    this.operations.push(operation);
    return {
      success: true,
      action: operation.action,
      ...(operation.action === "inspect" ? { elements: this.elements } : {}),
    };
  }
}

const BUTTON = (name: string, x: number): DesktopElement => ({
  role: "AXButton",
  name,
  x,
  y: 40,
  width: 80,
  height: 20,
});

describe("ComputerRuntime", () => {
  it("reports adapter capabilities without a mutation", async () => {
    const adapter = new TestAdapter();
    const runtime = new ComputerRuntime({
      artifactDirectory: "/tmp",
      adapter,
    });
    const result = await runtime.execute(
      ComputerOperationSchema.parse({
        kind: "computer",
        action: "capabilities",
      }),
    );
    expect(result.available).toBe(true);
    expect(adapter.calls).toEqual([]);
  });

  it("requires explicit bounded coordinates for pointer actions", async () => {
    const runtime = new ComputerRuntime({
      artifactDirectory: "/tmp",
      adapter: new TestAdapter(),
    });
    await expect(
      runtime.execute(
        ComputerOperationSchema.parse({
          kind: "computer",
          action: "click",
        }),
      ),
    ).rejects.toThrow("computer_click_requires_coordinates");
    await expect(
      runtime.execute(
        ComputerOperationSchema.parse({
          kind: "computer",
          action: "click",
          coordinateSpace: "normalized",
          x: 2,
          y: 0.5,
        }),
      ),
    ).rejects.toThrow("computer_normalized_coordinates_out_of_range");
  });

  it.each([
    ["screenshot", "screenshot", "computer_screenshot_unavailable"],
    ["inspect", "inspect", "computer_inspect_unavailable"],
    ["click", "pointer", "computer_pointer_unavailable"],
    ["drag", "drag", "computer_drag_unavailable"],
    ["type", "keyboard", "computer_keyboard_unavailable"],
    ["scroll", "scroll", "computer_scroll_unavailable"],
  ] as const)(
    "rejects %s when its adapter capability is unavailable",
    async (action, capability, error) => {
      const adapter = new TestAdapter({ [capability]: false });
      const runtime = new ComputerRuntime({
        artifactDirectory: "/tmp",
        adapter,
      });
      const operation = {
        kind: "computer",
        action,
        ...(action === "click"
          ? { coordinateSpace: "pixel", x: 10, y: 10 }
          : {}),
        ...(action === "drag"
          ? { coordinateSpace: "pixel", x: 10, y: 10, toX: 40, toY: 40 }
          : {}),
        ...(action === "type" ? { text: "safe" } : {}),
      };

      await expect(
        runtime.execute(ComputerOperationSchema.parse(operation)),
      ).rejects.toThrow(error);
      expect(adapter.calls).toEqual([]);
    },
  );

  it("requires a destination for a drag and bounds it like the press point", async () => {
    const adapter = new TestAdapter();
    const runtime = new ComputerRuntime({
      artifactDirectory: "/tmp",
      adapter,
    });
    await expect(
      runtime.execute(
        ComputerOperationSchema.parse({
          kind: "computer",
          action: "drag",
          coordinateSpace: "pixel",
          x: 10,
          y: 10,
        }),
      ),
    ).rejects.toThrow("computer_drag_requires_destination");
    // The destination shares the coordinate space, so it has to be bounded by
    // the same rule — an out-of-range `toY` used to slip through untouched.
    await expect(
      runtime.execute(
        ComputerOperationSchema.parse({
          kind: "computer",
          action: "drag",
          coordinateSpace: "normalized",
          x: 0.1,
          y: 0.1,
          toX: 0.5,
          toY: 4,
        }),
      ),
    ).rejects.toThrow("computer_normalized_coordinates_out_of_range");
    expect(adapter.calls).toEqual([]);
  });

  it("passes a bounded drag and a read-only inspect to the adapter", async () => {
    const adapter = new TestAdapter();
    const runtime = new ComputerRuntime({
      artifactDirectory: "/tmp",
      adapter,
    });
    await runtime.execute(
      ComputerOperationSchema.parse({ kind: "computer", action: "inspect" }),
    );
    await runtime.execute(
      ComputerOperationSchema.parse({
        kind: "computer",
        action: "drag",
        coordinateSpace: "normalized",
        x: 0.1,
        y: 0.2,
        toX: 0.8,
        toY: 0.9,
      }),
    );
    expect(adapter.calls).toEqual(["inspect", "drag"]);
  });
});

describe("an input helper stopped mid-run", () => {
  /** Fails each action as a helper that timed out, or that a cancel stopped. */
  class StoppedAdapter extends TestAdapter {
    constructor(private readonly how: "timeout" | "cancel") {
      super();
    }

    override async execute(operation: ComputerOperation, _directory?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
      await super.execute(operation);
      if (this.how === "timeout") throw new Error("computer_helper_timeout:osascript:10000ms");
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
      throw new Error("task_cancelled");
    }
  }
  const act = (action: string, extra: Record<string, unknown> = {}) =>
    ComputerOperationSchema.parse({ kind: "computer", action, ...extra });

  it("reports a click, keystroke or scroll it may have landed as an unknown outcome", async () => {
    const runtime = new ComputerRuntime({ artifactDirectory: "/tmp", adapter: new StoppedAdapter("timeout") });
    for (const operation of [
      act("click", { x: 0.5, y: 0.5 }),
      act("type", { text: "hello" }),
      act("scroll", { x: 0.5, y: 0.5, deltaY: 100 }),
    ]) {
      await expect(runtime.execute(operation), operation.action).rejects.toThrow(
        "effect_outcome_unknown:computer_helper_timeout:",
      );
    }
    // A screenshot changes nothing, so its timeout is a plain failure.
    await expect(runtime.execute(act("screenshot"))).rejects.toThrow(/^computer_helper_timeout:/);
  });

  it("reports an input action cancelled while its helper ran as an unknown outcome", async () => {
    const runtime = new ComputerRuntime({ artifactDirectory: "/tmp", adapter: new StoppedAdapter("cancel") });
    const controller = new AbortController();
    const clicking = runtime.execute(act("click", { x: 0.5, y: 0.5 }), controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(clicking).rejects.toThrow("effect_outcome_unknown:task_cancelled");
    // Cancelled before anything ran, nothing could have landed.
    await expect(runtime.execute(act("click", { x: 0.5, y: 0.5 }), controller.signal)).rejects.toThrow(/^task_cancelled$/);
  });
});

// A shell script stands in for tesseract, so these need a POSIX shell.
describe.skipIf(process.platform === "win32")("reading the screen when no tree came back", () => {
  const TSV = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "1\t1\t0\t0\t0\t0\t0\t0\t200\t100\t-1\t",
    "5\t1\t1\t1\t1\t1\t10\t10\t40\t12\t96.5\tSave",
  ].join("\n");

  /** Reports no tree, and writes each screenshot where a real adapter does. */
  class BlindAdapter extends TestAdapter {
    constructor(
      private readonly directory: string,
      private readonly capture: "ok" | "fails" = "ok",
      ocr = true,
    ) {
      super({ elements: false, ocr });
    }

    override async execute(operation: ComputerOperation): Promise<Record<string, unknown>> {
      await super.execute(operation);
      if (operation.action === "inspect") {
        return { success: true, action: "inspect", application: "Finder", displayWidth: 100 };
      }
      if (this.capture === "fails") throw new Error("computer_helper_failed: screen recording denied");
      const path = join(this.directory, "computer-capture.png");
      writeFileSync(path, "png");
      return { success: true, action: "screenshot", path };
    }
  }

  const scenario = (ocr: string, capture: "ok" | "fails" = "ok") => {
    const root = mkdtempSync(join(tmpdir(), "melra-ocr-"));
    const directory = join(root, "artifacts");
    mkdirSync(directory);
    const program = join(root, "tesseract");
    writeFileSync(program, `#!/bin/sh\n${ocr}\n`, { mode: 0o755 });
    const runtime = new ComputerRuntime({
      artifactDirectory: directory,
      adapter: new BlindAdapter(directory, capture),
      ocrProgram: program,
    });
    const inspect = () =>
      runtime.execute(ComputerOperationSchema.parse({ kind: "computer", action: "inspect" }));
    const click = () =>
      runtime.execute(ComputerOperationSchema.parse({ kind: "computer", action: "click", target: { name: "Save" } }));
    return { directory, inspect, click, done: () => rmSync(root, { recursive: true, force: true }) };
  };

  it("reads the words and keeps no screenshot", async () => {
    const { directory, inspect, done } = scenario(`printf '${TSV}'`);
    try {
      const observed = (await inspect()) as { elements?: DesktopElement[] };
      expect(observed.elements?.map(({ name }) => name)).toEqual(["Save"]);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      done();
    }
  });

  it("returns the observation, and no screenshot, when the reading fails", async () => {
    for (const [ocr, capture] of [["exit 1", "ok"], [`printf '${TSV}'`, "fails"]] as const) {
      const { directory, inspect, click, done } = scenario(ocr, capture);
      try {
        const observed = await inspect();
        expect(observed, `${ocr} / ${capture}`).toMatchObject({ application: "Finder", displayWidth: 100 });
        expect(observed).not.toHaveProperty("elements");
        expect(readdirSync(directory)).toEqual([]);
        // A target has nothing to fall back on: it reports why the reading
        // failed, not a bare computer_elements_unavailable.
        await expect(click(), `${ocr} / ${capture}`).rejects.toThrow(/computer_helper_failed|screen recording denied/);
      } finally {
        done();
      }
    }
  });

  it("reads the screen with an OCR program outside tesseract's usual paths", async () => {
    // The adapter reports no OCR, as the real ones do when tesseract is not
    // where they look; naming the program is what makes it available.
    const directory = mkdtempSync(join(tmpdir(), "melra-ocr-"));
    const program = join(directory, "ocr");
    writeFileSync(program, `#!/bin/sh\nprintf '${TSV}'\n`, { mode: 0o755 });
    const adapter = new BlindAdapter(directory, "ok", false);
    try {
      const runtime = new ComputerRuntime({ artifactDirectory: directory, adapter, ocrProgram: program });
      const observed = (await runtime.execute(
        ComputerOperationSchema.parse({ kind: "computer", action: "inspect" }),
      )) as { elements?: DesktopElement[] };
      expect(observed.elements?.map(({ name }) => name)).toEqual(["Save"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("matchElement", () => {
  const elements = [
    BUTTON("Save", 0),
    BUTTON("Save As…", 100),
    { role: "AXTextField", name: "Save", x: 200, y: 40, width: 60, height: 20 },
  ];

  it("prefers an exact name over the substring it is a prefix of", () => {
    expect(matchElement(elements, { role: "AXButton", name: "Save" }).x).toBe(0);
  });

  it("matches a role case-insensitively and a name by substring", () => {
    expect(matchElement(elements, { role: "axbutton", name: "as…" }).x).toBe(
      100,
    );
  });

  it("refuses rather than guessing between equally good candidates", () => {
    // Two exact "Save" matches across roles: picking either would be a coin
    // flip on which control gets clicked.
    expect(() => matchElement(elements, { name: "Save" })).toThrow(
      "computer_target_ambiguous",
    );
    expect(() => matchElement(elements, { name: "Print" })).toThrow(
      "computer_target_not_found",
    );
    expect(() => matchElement(elements, {})).toThrow(
      "computer_target_requires_role_or_name",
    );
  });

  it("refuses to click a reading it is not sure of", () => {
    // Reported by `inspect` — a caller may want to know the word is there — but
    // not clickable, because the point under a doubtful reading is a guess.
    const read = [{ ...BUTTON("Delete", 0), role: "text", confidence: 0.42 }];
    expect(() => matchElement(read, { name: "Delete" })).toThrow(
      "computer_target_confidence_too_low",
    );
    expect(
      matchElement([{ ...read[0]!, confidence: 0.91 }], { name: "Delete" }).x,
    ).toBe(0);
  });
});

describe("parseOcrElements", () => {
  // Real `tesseract 5 … tsv` output, trimmed: a page row, the block/para/line
  // rows above a word, and the words themselves.
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "1\t1\t0\t0\t0\t0\t0\t0\t2940\t1912\t-1\t",
    "4\t1\t1\t1\t1\t0\t42\t15\t167\t31\t-1\t",
    "5\t1\t1\t1\t1\t1\t100\t40\t80\t20\t96.720352\tSave",
    "5\t1\t1\t1\t1\t2\t300\t40\t90\t20\t41.5\tCancel",
    "5\t1\t1\t1\t1\t3\t500\t40\t60\t20\t12.25\tl1lI",
    "5\t1\t1\t1\t1\t4\t600\t40\t60\t20\t95.0\t   ",
  ].join("\n");

  it("scales a Retina capture back onto the display it came from", () => {
    // The image measured 2940 wide, the display is 1470: every box halves, so a
    // click computed from one lands where the word actually is.
    expect(parseOcrElements(tsv, 1470)).toEqual([
      { role: "text", name: "Save", x: 50, y: 20, width: 40, height: 10, confidence: 0.97 },
      { role: "text", name: "Cancel", x: 150, y: 20, width: 45, height: 10, confidence: 0.42 },
    ]);
  });

  it("drops noise and reads nothing at all from a capture with no page row", () => {
    // `l1lI` is under the reporting floor and the blank token has no name;
    // without a page row there is no scale, and guessing one would move a click.
    expect(parseOcrElements(tsv, 1470).map((e) => e.name)).not.toContain("l1lI");
    expect(parseOcrElements("level\tpage_num\n4\t1", 1470)).toEqual([]);
  });
});

describe("named targets", () => {
  const click = (
    target: Record<string, string>,
    extra: Record<string, unknown> = {},
  ): ComputerOperation =>
    ComputerOperationSchema.parse({
      kind: "computer",
      action: "click",
      target,
      ...extra,
    });

  it("inspects, then clicks the centre of the resolved element", async () => {
    const adapter = new TestAdapter();
    adapter.elements = [BUTTON("Save", 300)];
    const runtime = new ComputerRuntime({ artifactDirectory: "/tmp", adapter });

    const result = await runtime.execute(click({ name: "Save" }));

    expect(adapter.calls).toEqual(["inspect", "click"]);
    const acted = adapter.operations[1]!;
    // 300 + 80/2, 40 + 20/2 — in pixels, because that is what the tree measures.
    expect([acted.coordinateSpace, acted.x, acted.y]).toEqual(["pixel", 340, 50]);
    expect(acted.target).toBe(undefined);
    expect(result.element).toEqual(BUTTON("Save", 300));
  });

  it("drags a named element only to a destination given in pixels", async () => {
    const adapter = new TestAdapter();
    adapter.elements = [BUTTON("report.pdf", 300)];
    const runtime = new ComputerRuntime({ artifactDirectory: "/tmp", adapter });
    const drag = (extra: Record<string, unknown>) =>
      ComputerOperationSchema.parse({ kind: "computer", action: "drag", target: { name: "report.pdf" }, ...extra });
    // 0.8 of the screen used to arrive as 0.8 pixels: a drop at the corner.
    await expect(runtime.execute(drag({ toX: 0.8, toY: 0.5 }))).rejects.toThrow(
      "computer_target_drag_requires_pixel_destination",
    );
    expect(adapter.calls).not.toContain("drag");
    await runtime.execute(drag({ coordinateSpace: "pixel", toX: 900, toY: 400 }));
    const acted = adapter.operations.at(-1)!;
    expect([acted.coordinateSpace, acted.x, acted.y, acted.toX, acted.toY]).toEqual(["pixel", 340, 50, 900, 400]);
  });

  it("refuses a target the platform or the request cannot support", async () => {
    const adapter = new TestAdapter();
    const runtime = new ComputerRuntime({ artifactDirectory: "/tmp", adapter });

    adapter.elements = [BUTTON("Save", 300)];
    await expect(
      runtime.execute(click({ name: "Save" }, { x: 10, y: 10 })),
    ).rejects.toThrow("computer_target_conflicts_with_coordinates");

    adapter.elements = [];
    await expect(runtime.execute(click({ name: "Save" }))).rejects.toThrow(
      "computer_elements_unavailable",
    );

    const blind = new ComputerRuntime({
      artifactDirectory: "/tmp",
      adapter: new TestAdapter({ elements: false }),
    });
    await expect(blind.execute(click({ name: "Save" }))).rejects.toThrow(
      "computer_elements_unavailable",
    );
  });
});

describe("parseSecureInput", () => {
  // Trimmed from real `ioreg -l -d 1 -w 0 -r -c IOResources` output on macOS 26.
  const session =
    '"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kSCSecuritySessionID"=100024,' +
    '"kCGSSessionIDKey"=257,"kCGSSessionUserNameKey"="dheeraj"';

  it("reads a held secure-input session as active", () => {
    expect(
      parseSecureInput(`${session},"kCGSSessionSecureInputPID"=843})`),
    ).toBe(true);
  });

  it("reads a session without the key, or with it cleared, as inactive", () => {
    expect(parseSecureInput(`${session}})`)).toBe(false);
    expect(
      parseSecureInput(`${session},"kCGSSessionSecureInputPID"=0})`),
    ).toBe(false);
  });

  it("reports no reading at all when no console session was dumped", () => {
    // Absence of the key in output that never described a session is not
    // evidence that secure input is off — reporting `false` here would let a
    // keystroke-swallowing state through as verified.
    expect(parseSecureInput("+-o Root  <class IORegistryEntry>")).toBe(
      undefined,
    );
  });
});
