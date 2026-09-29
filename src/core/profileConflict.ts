export interface ProfileRef {
  browser_profile_id: string;
  display_name: string;
  profile_dir_name: string;
}

function mentions(text: string, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (n.length < 3) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, "iu").test(text.toLowerCase());
}

/**
 * The profile is chosen only in the UI. A prompt that names another registered profile is a conflict
 * the user must resolve by picking the profile explicitly.
 */
export function findProfileConflicts(prompt: string, profiles: ProfileRef[], selectedId: string): ProfileRef[] {
  const selected = profiles.find((p) => p.browser_profile_id === selectedId);
  return profiles.filter((p) => {
    if (p.browser_profile_id === selectedId) return false;
    const names = [p.display_name, p.profile_dir_name].filter(
      (n) => !selected || (n.toLowerCase() !== selected.display_name.toLowerCase() && n.toLowerCase() !== selected.profile_dir_name.toLowerCase()),
    );
    return names.some((n) => mentions(prompt, n));
  });
}
