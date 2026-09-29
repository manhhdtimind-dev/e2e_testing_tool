import type { AgentAdapter, AgentTurnRequest, AgentTurnResult } from "./types";
import { ThreadUnavailableError, mcpResultText, ts } from "./types";

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
      try {
        for await (const m of run.stream()) {
          if (m.type === "assistant") {
            const text = m.message.content
              .filter((b): b is { type: "text"; text: string } => (b as { type: string }).type === "text")
              .map((b) => b.text)
              .join("");
            if (text) {
              texts.push(text);
              req.onEvent({ ts: ts(), kind: "message", text });
            }
          } else if (m.type === "thinking") {
            req.onEvent({ ts: ts(), kind: "thinking", text: m.text });
          } else if (m.type === "tool_call") {
            const id = toolIdentity(m.name, m.args);
            if (m.status === "running") {
              req.onEvent({ ts: ts(), kind: "tool_call", call_id: m.call_id, tool: id.tool, server: id.server, args: id.args });
            } else {
              req.onEvent({
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
            req.onEvent({ ts: ts(), kind: "error", text: m.message ?? m.status });
          }
        }
      } finally {
        req.signal.removeEventListener("abort", onAbort);
      }
      const result = await run.wait();
      finalText = result.result ?? texts.join("\n");
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
