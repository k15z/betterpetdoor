import type { PresenceState } from "./presence";

export type MockDoorCommand = "mock-open" | "mock-close";
export interface MockDoorState {
  position: "open" | "closed";
  /** Command emitted by this update only. Null means no action. */
  lastCommand: MockDoorCommand | null;
  commandCount: number;
}

export function createMockDoorState(
  position: "open" | "closed" = "closed",
): MockDoorState {
  return { position, lastCommand: null, commandCount: 0 };
}

/** Simulation only: no network, Bluetooth, GPIO, credentials, or hardware hooks. */
export function updateMockDoor(
  state: MockDoorState,
  presence: PresenceState,
): MockDoorState {
  const desired =
    presence.status === "present"
      ? "open"
      : presence.status === "absent" && presence.phase === "absent"
        ? "closed"
        : state.position;
  if (desired === state.position) return { ...state, lastCommand: null };
  return {
    position: desired,
    lastCommand: desired === "open" ? "mock-open" : "mock-close",
    commandCount: state.commandCount + 1,
  };
}
