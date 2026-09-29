const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

/**
 * The Playwright Extension shows the token as `PLAYWRIGHT_MCP_EXTENSION_TOKEN=<token>`; users often paste the
 * whole line (sometimes with `export`/`set` or quotes). Only the token itself may be sent to the extension.
 */
export function normalizeExtensionToken(raw: string | null | undefined): string {
  let s = unquote(raw ?? "");
  s = s.replace(/^(?:export|set)\s+/i, "");
  s = unquote(s.replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*[=:]\s*/i, ""));
  return s;
}
