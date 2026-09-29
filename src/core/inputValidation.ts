import type { InputSchema, InputValues } from "../shared/types";

export const SECRET_MASK = "***";

export function validateInput(schema: InputSchema, values: InputValues): string[] {
  const issues: string[] = [];
  const known = new Set(schema.fields.map((f) => f.name));
  for (const f of schema.fields) {
    const v = values[f.name];
    if (v === undefined || v === "") {
      if (f.required) issues.push(`Thiếu giá trị cho "${f.name}"`);
      continue;
    }
    if (f.type === "number" && Number.isNaN(Number(v))) issues.push(`"${f.name}" phải là số`);
    if (f.type === "boolean" && !/^(true|false)$/i.test(v)) issues.push(`"${f.name}" phải là true/false`);
  }
  for (const k of Object.keys(values)) {
    if (!known.has(k)) issues.push(`"${k}" không thuộc input_schema`);
  }
  return issues;
}

export function secretFieldNames(schema: InputSchema, extra: string[] = []): Set<string> {
  return new Set([...schema.fields.filter((f) => f.secret).map((f) => f.name), ...extra]);
}

export function maskInput(values: InputValues, secretFields: Set<string>): InputValues {
  const out: InputValues = {};
  for (const [k, v] of Object.entries(values)) out[k] = secretFields.has(k) ? SECRET_MASK : v;
  return out;
}

/** Converts string inputs to the runtime types declared in the schema. */
export function coerceInput(schema: InputSchema, values: InputValues): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const f of schema.fields) {
    const v = values[f.name];
    if (v === undefined) continue;
    if (f.type === "number") out[f.name] = Number(v);
    else if (f.type === "boolean") out[f.name] = /^true$/i.test(v);
    else out[f.name] = v;
  }
  return out;
}

export function redactText(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join(SECRET_MASK);
  }
  return out;
}
