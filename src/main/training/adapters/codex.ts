import type { AgentAdapter, AgentTurnRequest, AgentTurnResult } from "./types";
import { ThreadUnavailableError, mcpResultText, ts } from "./types";

type CodexModule = typeof import("@openai/codex-sdk");

let mod: CodexModule | null = null;
async function load(): Promise<CodexModule> {
  mod ??= await import("@openai/codex-sdk");
  return mod;
}

export const codexAdapter: AgentAdapter = {
  provider: "codex",
  async runTurn(req: AgentTurnRequest): Promise<AgentTurnResult> {
    const { Codex } = await load();
    const codex = new Codex({
      ...(req.apiKey ? { apiKey: req.apiKey } : {}),
      config: {
        // Personal skills (e.g. brainstorming with design sign-off) stall unattended Training turns.
        skills: { include_instructions: false },
        mcp_servers: {
          playwright: {
            command: req.mcp.command,
            args: req.mcp.args,
            env: req.mcp.env,
            startup_timeout_sec: 90,
            tool_timeout_sec: 180,
            // approvalPolicy "never" rejects any tool that asks for approval, and Codex's
            // default ("auto") asks for Playwright's destructive/open-world tools.
            default_tools_approval_mode: "approve",
          },
        },
      },
    });
    const threadOptions = {
      workingDirectory: req.cwd,
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write" as const,
      approvalPolicy: "never" as const,
      networkAccessEnabled: false,
      webSearchMode: "disabled" as const,
      ...(req.model ? { model: req.model } : {}),
    };
    let thread;
    try {
      thread = req.providerThreadId ? codex.resumeThread(req.providerThreadId, threadOptions) : codex.startThread(threadOptions);
    } catch (e) {
      if (req.providerThreadId) throw new ThreadUnavailableError((e as Error).message);
      throw e;
    }

    let threadId = req.providerThreadId;
    let finalText = "";
    let error: string | undefined;
    try {
      const { events } = await thread.runStreamed(req.prompt, { signal: req.signal });
      for await (const ev of events) {
        switch (ev.type) {
          case "thread.started":
            threadId = ev.thread_id;
            req.onEvent({ ts: ts(), kind: "status", text: `Codex thread ${ev.thread_id}` });
            break;
          case "item.started":
            if (ev.item.type === "mcp_tool_call") {
              req.onEvent({ ts: ts(), kind: "tool_call", call_id: ev.item.id, server: ev.item.server, tool: ev.item.tool, args: ev.item.arguments });
            }
            break;
          case "item.completed": {
            const item = ev.item;
            if (item.type === "mcp_tool_call") {
              req.onEvent({
                ts: ts(),
                kind: "tool_result",
                call_id: item.id,
                server: item.server,
                tool: item.tool,
                args: item.arguments,
                ok: item.status === "completed" && !item.error,
                result: item.error ? item.error.message : mcpResultText(item.result),
              });
            } else if (item.type === "agent_message") {
              finalText = item.text;
              req.onEvent({ ts: ts(), kind: "message", text: item.text });
            } else if (item.type === "reasoning") {
              req.onEvent({ ts: ts(), kind: "thinking", text: item.text });
            } else if (item.type === "command_execution") {
              req.onEvent({ ts: ts(), kind: "command", text: item.command, ok: item.exit_code === 0, result: item.aggregated_output.slice(-4000) });
            } else if (item.type === "file_change") {
              req.onEvent({ ts: ts(), kind: "file_change", text: item.changes.map((c) => `${c.kind} ${c.path}`).join(", "), ok: item.status === "completed" });
            } else if (item.type === "error") {
              req.onEvent({ ts: ts(), kind: "error", text: item.message });
            }
            break;
          }
          case "turn.failed":
            error = ev.error.message;
            req.onEvent({ ts: ts(), kind: "error", text: ev.error.message });
            break;
          case "error":
            error = ev.message;
            req.onEvent({ ts: ts(), kind: "error", text: ev.message });
            break;
        }
      }
    } catch (e) {
      if (req.signal.aborted) {
        return { providerThreadId: threadId ?? "", status: "cancelled", finalText, error: String(req.signal.reason ?? "cancelled") };
      }
      const msg = (e as Error).message;
      if (req.providerThreadId && /no rollout|session.*not found|thread.*not found|could not find/i.test(msg)) {
        throw new ThreadUnavailableError(msg);
      }
      error = msg;
    }
    if (!threadId) throw new Error(error ?? "Codex không trả về thread id");
    return { providerThreadId: threadId, status: error ? "failed" : "completed", finalText, error };
  },
};
