import { createHash, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class AppError extends Error {}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(đã cắt ${text.length - max} ký tự)` : text;
}
