import type { AgentAdapter, AgentTurnRequest, AgentTurnResult } from "./types";
import { ThreadUnavailableError, mcpResultText, ts } from "./types";
import { StreamedTextBuffer } from "../../../core/trainingEvents";

type CursorModule = typeof import("@cursor/sdk");

let mod: CursorModule | null = null;
async function load(): Promise<CursorModule> {
  mod ??= await import("@cursor/sdk");
  return mod;
}

/** Cursor tool_call payloads are not a stable schema; extract MCP server/tool names defensively. */
function toolIdentity(name: string, args: unknown): { tool: string; server?: string; args: unknown } {
  const a = (args ?? {}) as Record<string, unknown>;
  const mcpMatch = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (mcpMatch) return { server: mcpMatch[1], tool: mcpMatch[2], args };
  const inner = (a.toolName ?? a.tool_name ?? a.name ?? a.tool) as string | undefined;
  if (inner && (name === "mcp" || name.toLowerCase().includes("mcp"))) {
    const server = (a.serverName ?? a.server_name ?? a.server ?? a.providerIdentifier) as string | undefined;
    return { tool: inner, server, args: a.args ?? a.arguments ?? a.input ?? args };
  }
  return { tool: name, args };
}

export interface CursorModelOption {
  id: string;
  label: string;
  /** Lets Cursor pick the model per request, like Auto in the Cursor app. */
  auto: boolean;
}

/** Local agents only accept ids (or aliases) from this account-specific list. */
export async function listCursorModels(apiKey: string): Promise<CursorModelOption[]> {
  const { Cursor } = await load();
  const models = await Cursor.models.list({ apiKey });
  return models.map((m) => ({
    id: m.id,
    label: m.displayName || m.id,
    auto: m.id === "auto" || !!m.aliases?.includes("auto"),
  }));
}

export const cursorAdapter: AgentAdapter = {
  provider: "cursor",
  async runTurn(req: AgentTurnRequest): Promise<AgentTurnResult> {
    const { Agent } = await load();
    if (!req.apiKey) throw new Error("Chưa cấu hình Cursor API key trong Cài đặt");
    const mcpServers = {
      playwright: { type: "stdio" as const, command: req.mcp.command, args: req.mcp.args, env: req.mcp.env },
    };
    const base = {
      apiKey: req.apiKey,
      model: { id: req.model || "composer-2.5" },
      local: { cwd: req.cwd, settingSources: [] },
      mcpServers,
    };
    let agent;
    if (req.providerThreadId) {
      try {
        agent = await Agent.resume(req.providerThreadId, base);
      } catch (e) {
        throw new ThreadUnavailableError((e as Error).message);
      }
    } else {
      agent = await Agent.create({ ...base, name: req.title });
      req.onEvent({ ts: ts(), kind: "status", text: `Cursor agent ${agent.agentId}` });
    }

    const agentId = agent.agentId;
    let finalText = "";
    try {
      const run = await agent.send(req.prompt, { mcpServers });
      const onAbort = () => {
        if (run.supports("cancel")) run.cancel().catch(() => undefined);
      };
      req.signal.addEventListener("abort", onAbort, { once: true });
      const texts: string[] = [];
      const streamed = new StreamedTextBuffer(req.onEvent);
      const emit: typeof req.onEvent = (e) => {
        streamed.flush();
        req.onEvent(e);
      };
      try {
        for await (const m of run.stream()) {
          if (m.type === "assistant") {
            const text = m.message.content
              .filter((b): b is { type: "text"; text: string } => (b as { type: string }).type === "text")
              .map((b) => b.text)
              .join("");
            if (text) {
              texts.push(text);
              streamed.push("message", text, ts());
            }
          } else if (m.type === "thinking") {
            if (m.text) streamed.push("thinking", m.text, ts());
          } else if (m.type === "tool_call") {
            const id = toolIdentity(m.name, m.args);
            if (m.status === "running") {
              emit({ ts: ts(), kind: "tool_call", call_id: m.call_id, tool: id.tool, server: id.server, args: id.args });
            } else {
              emit({
                ts: ts(),
                kind: "tool_result",
                call_id: m.call_id,
                tool: id.tool,
                server: id.server,
                args: id.args,
                ok: m.status === "completed",
                result: mcpResultText(m.result),
              });
            }
          } else if (m.type === "status" && (m.status === "ERROR" || m.status === "EXPIRED")) {
            emit({ ts: ts(), kind: "error", text: m.message ?? m.status });
          }
        }
      } finally {
        streamed.flush();
        req.signal.removeEventListener("abort", onAbort);
      }
      const result = await run.wait();
      // Assistant messages arrive as deltas, so they join without a separator.
      finalText = result.result ?? texts.join("");
      if (result.status === "cancelled" || req.signal.aborted) {
        return { providerThreadId: agentId, status: "cancelled", finalText, error: String(req.signal.reason ?? "cancelled") };
      }
      if (result.status === "error") {
        return { providerThreadId: agentId, status: "failed", finalText, error: result.error?.message ?? "Cursor run lỗi" };
      }
      return { providerThreadId: agentId, status: "completed", finalText };
    } catch (e) {
      if (req.signal.aborted) return { providerThreadId: agentId, status: "cancelled", finalText, error: String(req.signal.reason ?? "cancelled") };
      return { providerThreadId: agentId, status: "failed", finalText, error: (e as Error).message };
    } finally {
      await agent[Symbol.asyncDispose]().catch(() => undefined);
    }
  },
};
