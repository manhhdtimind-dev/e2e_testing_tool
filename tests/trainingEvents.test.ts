import { describe, expect, it } from "vitest";
import { StreamedTextBuffer, mergeStreamedText } from "../src/core/trainingEvents";
import type { TrainingEvent } from "../src/shared/types";

const ev = (kind: TrainingEvent["kind"], text?: string, ts = "t"): TrainingEvent => ({ ts, kind, text });

describe("mergeStreamedText", () => {
  it("joins consecutive deltas of the same kind and keeps the first timestamp", () => {
    const out = mergeStreamedText([
      ev("thinking", "The user wants a", "1"),
      ev("thinking", " screenshot.", "2"),
      ev("thinking", "\n\n", "3"),
      ev("message", "I'll read the", "4"),
      ev("message", " script.", "5"),
      ev("tool_result", undefined, "6"),
      ev("message", "Done.", "7"),
    ]);
    expect(out.map((e) => [e.kind, e.text, e.ts])).toEqual([
      ["thinking", "The user wants a screenshot.\n\n", "1"],
      ["message", "I'll read the script.", "4"],
      ["tool_result", undefined, "6"],
      ["message", "Done.", "7"],
    ]);
  });

  it("drops whitespace-only text left between other events", () => {
    expect(mergeStreamedText([ev("tool_result"), ev("thinking", "\n\n"), ev("tool_result")]).map((e) => e.kind)).toEqual(["tool_result", "tool_result"]);
  });
});

describe("StreamedTextBuffer", () => {
  it("emits one event per paragraph or kind change, never per delta", () => {
    const out: TrainingEvent[] = [];
    const buf = new StreamedTextBuffer((e) => out.push(e));
    for (const d of ["Those \"10", "|\" mark", "ers are line numbers.", "\n\n", "Next I", " edit."]) buf.push("thinking", d, "a");
    buf.push("message", "I'm", "b");
    buf.push("message", " adding it.", "c");
    buf.flush();
    buf.flush();
    expect(out.map((e) => [e.kind, e.text, e.ts])).toEqual([
      ["thinking", 'Those "10|" markers are line numbers.\n\n', "a"],
      ["thinking", "Next I edit.", "a"],
      ["message", "I'm adding it.", "b"],
    ]);
  });

  it("skips whitespace-only buffers", () => {
    const out: TrainingEvent[] = [];
    const buf = new StreamedTextBuffer((e) => out.push(e));
    buf.push("thinking", "\n", "a");
    buf.push("message", "ok", "b");
    buf.flush();
    expect(out.map((e) => e.text)).toEqual(["ok"]);
  });
});
