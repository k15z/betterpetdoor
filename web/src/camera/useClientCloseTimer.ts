import { useEffect } from "react";
import { cameraApi } from "../api";
import type { CameraSession } from "../api";

export function useClientCloseTimer(
  doorId: string,
  dueAt: string | null,
  onState: (state: CameraSession) => void,
  onError: (message: string) => void,
) {
  // The phone owns scheduling; this request also wakes an auto-stopped host.
  // Keep the timer after disarming detection, until cancellation or route exit.
  useEffect(() => {
    if (!dueAt) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const due = Date.parse(dueAt);
    if (!Number.isFinite(due)) return;
    const check = async () => {
      try {
        const value = await cameraApi.checkClose(doorId);
        if (!stopped) {
          onState(value);
          if (!value.close_due_at) return;
        }
      } catch {
        if (!stopped) onError("Automatic close request failed. Keep this page open; retrying in 15 seconds.");
      }
      if (!stopped) timer = setTimeout(() => void check(), 15000);
    };
    timer = setTimeout(() => void check(), Math.max(0, due - Date.now()));
    return () => { stopped = true; clearTimeout(timer); };
  }, [doorId, dueAt, onState, onError]);
}
