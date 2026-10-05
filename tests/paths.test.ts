import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cursorStorePathLength, pickWorkspacesDir } from "../src/main/paths";

const home = "C:\\Users\\Admin";
const env = { LOCALAPPDATA: "C:\\Users\\Admin\\AppData\\Local" };

describe("pickWorkspacesDir", () => {
  it("matches the Cursor SDK store path length for an existing agent", () => {
    // store.db measured at 249 characters; the estimate adds "-journal".
    expect(cursorStorePathLength("C:\\Users\\Admin\\AppData\\Roaming\\E2E AI Trainer\\data\\workspaces", home)).toBe(249 + "-journal".length);
  });

  it("keeps workspaces in the data folder when the Cursor store path fits", () => {
    expect(pickWorkspacesDir("C:\\Users\\Admin\\AppData\\Roaming\\E2E AI Trainer\\data", "win32", env, home)).toBe(
      "C:\\Users\\Admin\\AppData\\Roaming\\E2E AI Trainer\\data\\workspaces",
    );
  });

  it("moves workspaces to a short folder when the data folder is deep (portable)", () => {
    const dir = pickWorkspacesDir("C:\\Project\\e2e_test\\release\\E2E-AI-Trainer-0.1.0-portable-x64\\data", "win32", env, home);
    expect(dir).toBe("C:\\Users\\Admin\\AppData\\Local\\E2E-AI-Trainer\\ws");
    expect(cursorStorePathLength(dir, home)).toBeLessThanOrEqual(259);
  });

  it("does not move workspaces outside Windows", () => {
    const deep = "/very/long/".repeat(30) + "data";
    expect(pickWorkspacesDir(deep, "linux", env, home)).toBe(join(deep, "workspaces"));
  });
});
