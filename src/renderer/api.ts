import { useEffect, useRef } from "react";
import type { Api } from "../main/api";

type Promisified<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;
};

interface Bridge {
  call(method: string, args: unknown[]): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  on(listener: (evt: { type: string; payload: unknown }) => void): () => void;
}

declare global {
  interface Window {
    bridge: Bridge;
  }
}

export const api = new Proxy({} as Promisified<Api>, {
  get: (_t, method: string) => async (...args: unknown[]) => {
    const res = await window.bridge.call(method, args);
    if (!res.ok) throw new Error(res.error ?? "Lỗi không xác định");
    return res.data;
  },
});

export type ApiResult<K extends keyof Api> = Awaited<ReturnType<Api[K]>>;

export function useAppEvent<T = unknown>(type: string, handler: (payload: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(
    () =>
      window.bridge.on((evt) => {
        if (evt.type === type) ref.current(evt.payload as T);
      }),
    [type],
  );
}

export function artifactUrl(ref: string): string {
  return `artifact://local/${ref.split("/").map(encodeURIComponent).join("/")}`;
}
