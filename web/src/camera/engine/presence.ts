import { clamp } from "./types";
import type { Evidence } from "./types";

export type PresenceStatus = "unknown" | "absent" | "present";
export type PresencePhase =
  | "unknown"
  | "arriving"
  | "present"
  | "leaving"
  | "absent";

export interface PresenceConfig {
  minArea: number;
  minScore: number;
  minMotion: number;
  arrivalMs: number;
  absenceMs: number;
  staleMs: number;
}

export const DEFAULT_PRESENCE_CONFIG: PresenceConfig = {
  minArea: 0.025,
  minScore: 0.62,
  minMotion: 0.08,
  arrivalMs: 1200,
  absenceMs: 5000,
  staleMs: 1500,
};

export interface PresenceState {
  status: PresenceStatus;
  phase: PresencePhase;
  candidateSince: number | null;
  absenceSince: number | null;
  lastAt: number | null;
  progress: number;
  reason: string;
  motionLatched: boolean;
}

export function createPresenceState(): PresenceState {
  return {
    status: "unknown",
    phase: "unknown",
    candidateSince: null,
    absenceSince: null,
    lastAt: null,
    progress: 0,
    reason: "Waiting for a usable camera frame",
    motionLatched: false,
  };
}

function configWithDefaults(config: Partial<PresenceConfig>): PresenceConfig {
  const result = { ...DEFAULT_PRESENCE_CONFIG };
  for (const key of Object.keys(result) as (keyof PresenceConfig)[]) {
    const value = config[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    result[key] = key.endsWith("Ms") ? Math.max(0, value) : clamp(value);
  }
  return result;
}

function unknown(now: number | null, reason: string): PresenceState {
  return { ...createPresenceState(), lastAt: now, reason };
}

/**
 * Pure temporal reducer. Call with a monotonic timestamp (performance.now()).
 * A missing frame must be passed as unavailable evidence, including on pause,
 * hidden-tab suspension, camera errors, and inference failure. A watchdog may
 * also do that if no new frame arrives. No timer alone ever establishes absence.
 */
export function updatePresence(
  state: PresenceState,
  evidence: Evidence,
  nowMs: number,
  config: Partial<PresenceConfig> = {},
): PresenceState {
  const settings = configWithDefaults(config);
  if (!Number.isFinite(nowMs)) return unknown(null, "Invalid frame timestamp");
  if (state.lastAt !== null && nowMs < state.lastAt)
    return unknown(nowMs, "Frame clock restarted; checking again");
  if (!evidence.available)
    return unknown(
      nowMs,
      evidence.reason ?? "Camera unavailable; holding the simulated door",
    );
  if (
    ![evidence.score, evidence.area, evidence.motion].every(Number.isFinite) ||
    [evidence.score, evidence.area, evidence.motion].some(
      (value) => value < 0 || value > 1,
    )
  ) {
    return unknown(nowMs, "Invalid detection evidence");
  }
  // Do not count a backgrounded tab / blocked inference interval toward either timer.
  const stale =
    state.lastAt !== null && nowMs - state.lastAt > settings.staleMs;
  const previous = stale ? unknown(nowMs, "Frame gap; checking again") : state;
  const match =
    evidence.box !== null &&
    evidence.area > 0 &&
    evidence.area >= settings.minArea &&
    evidence.score >= settings.minScore;
  if (match) {
    const motionLatched =
      evidence.source === "object" ||
      previous.status === "present" ||
      previous.motionLatched ||
      (evidence.motion > 0 && evidence.motion >= settings.minMotion);
    if (!motionLatched) {
      return {
        ...previous,
        phase: "unknown",
        candidateSince: null,
        absenceSince: null,
        lastAt: nowMs,
        progress: 0,
        motionLatched: false,
        reason: "Coat color found; waiting for arrival movement",
      };
    }
    if (previous.status === "present") {
      return {
        status: "present",
        phase: "present",
        candidateSince: null,
        absenceSince: null,
        lastAt: nowMs,
        progress: 1,
        motionLatched: true,
        reason: "Dog remains in the zone",
      };
    }
    const candidateSince = previous.candidateSince ?? nowMs;
    const elapsed = nowMs - candidateSince;
    const confirmed = elapsed >= settings.arrivalMs;
    return {
      status: confirmed ? "present" : previous.status,
      phase: confirmed ? "present" : "arriving",
      candidateSince: confirmed ? null : candidateSince,
      absenceSince: null,
      lastAt: nowMs,
      progress:
        settings.arrivalMs === 0 ? 1 : clamp(elapsed / settings.arrivalMs),
      motionLatched: true,
      reason: confirmed
        ? "Dog presence confirmed"
        : "Checking a steady arrival",
    };
  }
  if (previous.status === "absent") {
    return {
      status: "absent",
      phase: "absent",
      candidateSince: null,
      absenceSince: null,
      lastAt: nowMs,
      progress: 1,
      motionLatched: false,
      reason: "Zone remains clear",
    };
  }
  const absenceSince = previous.absenceSince ?? nowMs;
  const elapsed = nowMs - absenceSince;
  const confirmed = elapsed >= settings.absenceMs;
  return {
    status: confirmed ? "absent" : previous.status,
    phase: confirmed ? "absent" : "leaving",
    candidateSince: null,
    absenceSince: confirmed ? null : absenceSince,
    lastAt: nowMs,
    progress:
      settings.absenceMs === 0 ? 1 : clamp(elapsed / settings.absenceMs),
    motionLatched: false,
    reason: confirmed
      ? "Zone clear after the absence grace period"
      : "Waiting through the absence grace period",
  };
}
