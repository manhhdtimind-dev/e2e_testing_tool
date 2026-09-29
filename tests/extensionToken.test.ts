import { describe, expect, it } from "vitest";
import { normalizeExtensionToken } from "../src/core/extensionToken";

describe("normalizeExtensionToken", () => {
  it.each([
    ["abc123-XYZ_9", "abc123-XYZ_9"],
    ["  abc123  ", "abc123"],
    ["PLAYWRIGHT_MCP_EXTENSION_TOKEN=abc123", "abc123"],
    ["PLAYWRIGHT_MCP_EXTENSION_TOKEN = abc123", "abc123"],
    ['PLAYWRIGHT_MCP_EXTENSION_TOKEN="abc123"', "abc123"],
    ["export PLAYWRIGHT_MCP_EXTENSION_TOKEN=abc123", "abc123"],
    ["set PLAYWRIGHT_MCP_EXTENSION_TOKEN=abc123", "abc123"],
    ["'abc123'", "abc123"],
    ["", ""],
    [null, ""],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeExtensionToken(raw)).toBe(expected);
  });
});
