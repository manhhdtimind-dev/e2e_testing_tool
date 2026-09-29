import type { AuthCheck, AuthRule } from "../shared/types";

export interface PageFacts {
  url: string;
  text: string;
  cssPresent: Record<string, boolean>;
}

export function evaluateAuthRules(rules: AuthRule[], facts: PageFacts): AuthRule[] {
  return rules.filter((rule) => {
    switch (rule.type) {
      case "url_contains":
        return !facts.url.includes(rule.value);
      case "url_not_contains":
        return facts.url.includes(rule.value);
      case "text_present":
        return !facts.text.toLowerCase().includes(rule.value.toLowerCase());
      case "css_present":
        return !facts.cssPresent[rule.value];
      default:
        return true;
    }
  });
}

export function authCheckConfigured(check: AuthCheck | null | undefined): boolean {
  return !!check && check.rules.length > 0 && check.rules.every((r) => r.value.trim().length > 0);
}

export function resolveCheckUrl(baseUrl: string, check: AuthCheck): string {
  if (!check.check_url) return baseUrl;
  return new URL(check.check_url, baseUrl).toString();
}

export function describeRule(rule: AuthRule): string {
  switch (rule.type) {
    case "url_contains":
      return `URL chứa "${rule.value}"`;
    case "url_not_contains":
      return `URL không chứa "${rule.value}"`;
    case "text_present":
      return `Trang có chữ "${rule.value}"`;
    case "css_present":
      return `Có phần tử "${rule.value}"`;
  }
}
