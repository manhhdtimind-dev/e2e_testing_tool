import { describe, expect, it } from "vitest";
import { findProfileConflicts } from "../src/core/profileConflict";
import { parseVerdict } from "../src/main/training/prompt";

const profiles = [
  { browser_profile_id: "a", display_name: "QA Admin", profile_dir_name: "Profile 1" },
  { browser_profile_id: "b", display_name: "Sales User", profile_dir_name: "Profile 2" },
];

describe("profile conflicts", () => {
  it("detects prompts that name another profile", () => {
    expect(findProfileConflicts("hãy dùng profile Sales User để chạy", profiles, "a").map((p) => p.browser_profile_id)).toEqual(["b"]);
    expect(findProfileConflicts("switch to Profile 2", profiles, "a")).toHaveLength(1);
    expect(findProfileConflicts("dùng QA Admin", profiles, "a")).toHaveLength(0);
    expect(findProfileConflicts("Profile 12 is unrelated", profiles, "a")).toHaveLength(0);
  });
});

describe("agent verdict", () => {
  it("parses the last JSON verdict line", () => {
    expect(parseVerdict('done.\n{"status":"done","reason":"ok","steps_done":[1,2]}')).toEqual({ status: "done", reason: "ok" });
    expect(parseVerdict('{"status":"blocked","reason":"a"}\n{"status":"auth_required","reason":"login"}').status).toBe("auth_required");
    expect(parseVerdict("no json").status).toBe("unknown");
  });
});
