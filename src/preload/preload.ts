import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("bridge", {
  call: (method: string, args: unknown[]) => ipcRenderer.invoke("api", method, args),
  on: (listener: (evt: { type: string; payload: unknown }) => void) => {
    const handler = (_e: unknown, evt: { type: string; payload: unknown }) => listener(evt);
    ipcRenderer.on("app-event", handler);
    return () => ipcRenderer.removeListener("app-event", handler);
  },
});
