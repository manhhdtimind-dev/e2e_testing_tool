import type { TrainingEvent } from "../shared/types";

const isText = (e: TrainingEvent) => e.kind === "message" || e.kind === "thinking";

/**
 * Cursor streams assistant text and thinking as small deltas. Joins consecutive deltas of the
 * same kind into one event (keeping the first timestamp) and drops whitespace-only leftovers.
 * Only for streamed providers: complete items (Codex) would be glued together without a separator.
 */
export function mergeStreamedText(events: TrainingEvent[]): TrainingEvent[] {
  const out: TrainingEvent[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (isText(e) && last && last.kind === e.kind) out[out.length - 1] = { ...last, text: (last.text ?? "") + (e.text ?? "") };
    else out.push(e);
  }
  return out.filter((e) => !isText(e) || (e.text ?? "").trim());
}

/** Buffers streamed deltas and emits one event per paragraph, or earlier when the kind changes. */
export class StreamedTextBuffer {
  private pending: { kind: "message" | "thinking"; text: string; ts: string } | null = null;

  constructor(private emit: (e: TrainingEvent) => void) {}

  push(kind: "message" | "thinking", text: string, ts: string) {
    if (this.pending && this.pending.kind !== kind) this.flush();
    this.pending ??= { kind, text: "", ts };
    this.pending.text += text;
    if (/\n\s*\n\s*$/.test(this.pending.text)) this.flush();
  }

  flush() {
    const p = this.pending;
    this.pending = null;
    if (p && p.text.trim()) this.emit({ ts: p.ts, kind: p.kind, text: p.text });
  }
}
