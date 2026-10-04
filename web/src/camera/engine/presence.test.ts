import { describe, expect, it } from "vitest";
import {
  createPresenceState,
  DEFAULT_PRESENCE_CONFIG,
  updatePresence,
} from "./presence";
import type { PresenceState } from "./presence";
import { createMockDoorState, updateMockDoor } from "./mockDoor";
import { unavailableEvidence } from "./types";
import type { Evidence } from "./types";

const object: Evidence = {
  available: true,
  source: "object",
  score: 0.9,
  area: 0.1,
  motion: 0,
  box: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 },
};
const moving: Evidence = { ...object, source: "color", motion: 0.2 };
const stationary: Evidence = { ...moving, motion: 0 };
const empty: Evidence = {
  available: true,
  source: "object",
  score: 0,
  area: 0,
  motion: 0,
  box: null,
};

function confirmedPresence(evidence = object): PresenceState {
  let state = createPresenceState();
  for (const at of [0, 400, 800, 1200])
    state = updatePresence(state, evidence, at);
  return state;
}

describe("temporal presence reducer", () => {
  it("uses conservative 1.2-second arrival, 5-second absence defaults", () => {
    expect(DEFAULT_PRESENCE_CONFIG.arrivalMs).toBe(1200);
    expect(DEFAULT_PRESENCE_CONFIG.absenceMs).toBe(5000);
    let state = updatePresence(createPresenceState(), object, 0);
    expect(state.phase).toBe("arriving");
    expect(state.status).toBe("unknown");
    state = updatePresence(state, object, 600);
    expect(state.progress).toBe(0.5);
    state = updatePresence(state, object, 1199);
    expect(state.status).toBe("unknown");
    state = updatePresence(state, object, 1200);
    expect(state.status).toBe("present");
  });

  it("requires movement for initial color arrival but never requires the dog to keep moving", () => {
    let state = createPresenceState();
    for (const at of [0, 1000, 2000, 3000])
      state = updatePresence(state, stationary, at);
    expect(state.status).toBe("unknown");
    expect(state.candidateSince).toBeNull();
    state = updatePresence(state, moving, 3500);
    for (const at of [3900, 4300, 4700, 5700, 6700])
      state = updatePresence(state, stationary, at);
    expect(state.status).toBe("present");
    expect(state.phase).toBe("present");
  });

  it("clears an interrupted initial motion latch", () => {
    let state = updatePresence(createPresenceState(), moving, 0);
    state = updatePresence(state, empty, 500);
    state = updatePresence(state, stationary, 1000);
    state = updatePresence(state, stationary, 1500);
    expect(state.status).toBe("unknown");
    expect(state.candidateSince).toBeNull();
    expect(state.motionLatched).toBe(false);
  });

  it("accepts object evidence without any motion", () => {
    expect(confirmedPresence(object).status).toBe("present");
  });

  it("does not establish presence from noise, low scores, or a missing box", () => {
    for (const evidence of [
      { ...object, area: 0.001 },
      { ...object, score: 0.4 },
      { ...object, box: null },
    ])
      expect(confirmedPresence(evidence).status).not.toBe("present");
  });

  it("keeps present through a short missed detection and cancels departure when the stationary dog reappears", () => {
    let state = confirmedPresence(moving);
    state = updatePresence(state, empty, 1500);
    state = updatePresence(state, empty, 2500);
    expect(state.status).toBe("present");
    expect(state.phase).toBe("leaving");
    state = updatePresence(state, stationary, 3000);
    expect(state.status).toBe("present");
    expect(state.absenceSince).toBeNull();
  });

  it("requires a full sequence of clear observations across the absence grace period", () => {
    let state = confirmedPresence();
    for (const at of [1500, 2500, 3500, 4500, 5500, 6499])
      state = updatePresence(state, empty, at);
    expect(state.status).toBe("present");
    state = updatePresence(state, empty, 6500);
    expect(state.status).toBe("absent");
    expect(state.phase).toBe("absent");
  });

  it("resets arrival and absence timers when inference stalls or the tab sleeps", () => {
    let state = updatePresence(createPresenceState(), object, 0);
    state = updatePresence(state, object, 1000);
    state = updatePresence(state, object, 20_000);
    expect(state.status).toBe("unknown");
    expect(state.candidateSince).toBe(20_000);
    let departing = updatePresence(confirmedPresence(), empty, 1500);
    departing = updatePresence(departing, empty, 20_000);
    expect(departing.status).toBe("unknown");
    expect(departing.absenceSince).toBe(20_000);
  });

  it("marks camera loss unknown and discards all temporal claims", () => {
    const state = updatePresence(
      confirmedPresence(),
      unavailableEvidence("object", "Camera lost"),
      1500,
    );
    expect(state).toMatchObject({
      status: "unknown",
      phase: "unknown",
      candidateSince: null,
      absenceSince: null,
      motionLatched: false,
    });
    expect(state.reason).toBe("Camera lost");
  });

  it("requires fresh arrival evidence after unavailable data", () => {
    let state = updatePresence(
      confirmedPresence(moving),
      unavailableEvidence("color"),
      1500,
    );
    state = updatePresence(state, stationary, 2000);
    expect(state.status).toBe("unknown");
    state = updatePresence(state, moving, 2500);
    state = updatePresence(state, stationary, 3500);
    expect(state.status).toBe("unknown");
    state = updatePresence(state, stationary, 3700);
    expect(state.status).toBe("present");
  });

  it("handles bad/rewound clocks and invalid evidence conservatively", () => {
    const present = confirmedPresence();
    expect(updatePresence(present, empty, 100).status).toBe("unknown");
    expect(updatePresence(present, empty, Number.NaN).status).toBe("unknown");
    for (const score of [Number.NaN, Number.POSITIVE_INFINITY, 2, -1]) {
      expect(updatePresence(present, { ...object, score }, 1500).status).toBe(
        "unknown",
      );
    }
  });

  it("permits configurable thresholds and timing without mutating arguments", () => {
    const initial = Object.freeze(createPresenceState());
    const evidence = Object.freeze({ ...object, score: 0.3, area: 0.01 });
    const state = updatePresence(initial, evidence, 0, {
      minScore: 0.2,
      minArea: 0.005,
      arrivalMs: 0,
    });
    expect(state.status).toBe("present");
    expect(initial.status).toBe("unknown");
  });

  it("does not turn a motion threshold of zero into fabricated motion", () => {
    expect(
      updatePresence(createPresenceState(), stationary, 0, {
        minMotion: 0,
        arrivalMs: 0,
      }).status,
    ).toBe("unknown");
  });

  it("does not count repeated timestamps as elapsed time", () => {
    let state = createPresenceState();
    for (let i = 0; i < 100; i++) state = updatePresence(state, object, 0);
    expect(state.status).toBe("unknown");
    expect(state.progress).toBe(0);
  });
});

describe("strictly simulated door adapter", () => {
  it("emits a mock-open only after confirmed presence and deduplicates repeated observations", () => {
    let door = createMockDoorState();
    door = updateMockDoor(
      door,
      updatePresence(createPresenceState(), object, 0),
    );
    expect(door.position).toBe("closed");
    door = updateMockDoor(door, confirmedPresence());
    expect(door).toEqual({
      position: "open",
      lastCommand: "mock-open",
      commandCount: 1,
    });
    expect(updateMockDoor(door, confirmedPresence())).toEqual({
      position: "open",
      lastCommand: null,
      commandCount: 1,
    });
  });

  it("holds the last simulated door position on camera loss, including a long loss", () => {
    let door = updateMockDoor(createMockDoorState(), confirmedPresence());
    let presence = updatePresence(
      confirmedPresence(),
      unavailableEvidence("object"),
      1500,
    );
    for (const at of [2000, 10_000, 60_000, 600_000]) {
      presence = updatePresence(presence, unavailableEvidence("object"), at);
      door = updateMockDoor(door, presence);
      expect(door).toEqual({
        position: "open",
        lastCommand: null,
        commandCount: 1,
      });
    }
  });

  it("never closes on a frame gap and only closes after fresh stable absence", () => {
    let presence = confirmedPresence();
    let door = updateMockDoor(createMockDoorState(), presence);
    presence = updatePresence(presence, empty, 20_000);
    door = updateMockDoor(door, presence);
    expect(door.position).toBe("open");
    for (const at of [21_000, 22_000, 23_000, 24_000]) {
      presence = updatePresence(presence, empty, at);
      door = updateMockDoor(door, presence);
      expect(door.position).toBe("open");
    }
    presence = updatePresence(presence, empty, 25_000);
    door = updateMockDoor(door, presence);
    expect(door).toEqual({
      position: "closed",
      lastCommand: "mock-close",
      commandCount: 2,
    });
  });

  it("keeps either initial simulated position on unknown evidence", () => {
    expect(
      updateMockDoor(createMockDoorState("open"), createPresenceState())
        .position,
    ).toBe("open");
    expect(
      updateMockDoor(createMockDoorState("closed"), createPresenceState())
        .position,
    ).toBe("closed");
  });

  it("does not close during ambiguous or arriving evidence even if the last stable status was absent", () => {
    const uncertain: PresenceState = {
      ...createPresenceState(),
      status: "absent",
      phase: "unknown",
    };
    expect(
      updateMockDoor(createMockDoorState("open"), uncertain).position,
    ).toBe("open");
    expect(
      updateMockDoor(createMockDoorState("open"), {
        ...uncertain,
        phase: "arriving",
      }).position,
    ).toBe("open");
  });
});
