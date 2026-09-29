export function normalizeDomains(baseUrl: string, allowed: string[]): string[] {
  const set = new Set<string>();
  try {
    set.add(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    // invalid base URL is reported by environment validation
  }
  for (const d of allowed) {
    const v = d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
    if (v) set.add(v);
  }
  return [...set];
}

export function isHostAllowed(host: string, domains: string[]): boolean {
  const h = host.toLowerCase();
  return domains.some((d) => {
    if (d.startsWith("*.")) {
      const suffix = d.slice(2);
      return h === suffix || h.endsWith(`.${suffix}`);
    }
    return h === d;
  });
}

export function isUrlAllowed(url: string, domains: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "about:" || parsed.protocol === "data:" || parsed.protocol === "blob:") return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return isHostAllowed(parsed.hostname, domains);
}

/** Origins for Playwright MCP `--allowed-origins` (semicolon separated, wildcards not supported there). */
export function allowedOriginsArg(baseUrl: string, allowed: string[]): string {
  const origins = new Set<string>();
  try {
    origins.add(new URL(baseUrl).origin);
  } catch {
    // ignore
  }
  for (const d of normalizeDomains(baseUrl, allowed)) {
    const host = d.startsWith("*.") ? d.slice(2) : d;
    origins.add(`https://${host}`);
    origins.add(`http://${host}`);
  }
  return [...origins].join(";");
}
