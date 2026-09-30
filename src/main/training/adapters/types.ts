import type { AgentProvider, CodexReasoningEffort, TrainingEvent } from "../../../shared/types";
import type { StdioServer } from "../mcpConfig";

export interface AgentTurnRequest {
  providerThreadId: string | null;
  prompt: string;
  cwd: string;
  mcp: StdioServer;
  model: string;
  /** Codex only; empty keeps the user's Codex config. */
  reasoningEffort?: CodexReasoningEffort;
  apiKey: string | null;
  title: string;
  signal: AbortSignal;
  onEvent: (e: TrainingEvent) => void;
}

export interface AgentTurnResult {
  providerThreadId: string;
  status: "completed" | "failed" | "cancelled";
  finalText: string;
  error?: string;
}

/**
 * Common surface for Codex SDK and Cursor SDK. A turn continues `providerThreadId`
 * when given; otherwise a new provider thread/agent is created and its real ID returned.
 */
export interface AgentAdapter {
  provider: AgentProvider;
  runTurn(req: AgentTurnRequest): Promise<AgentTurnResult>;
}

export class ThreadUnavailableError extends Error {}

export function ts(): string {
  return new Date().toISOString();
}

export function mcpResultText(result: unknown): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown[] }).content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const block = c as { type?: string; text?: string };
        return block.type === "text" ? (block.text ?? "") : block.type ? `[${block.type}]` : "";
      })
      .join("\n");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
