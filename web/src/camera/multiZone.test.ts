import { describe, expect, it } from "vitest";
import {
  extractZoneObservations,
  INITIAL_SETTINGS,
  INITIAL_CONFIG,
  selectZoneEvidence,
  updateZonePresence,
} from "./useCameraMonitor";
import type { MonitorSettings, ZonePresenceStates, ZoneObservation } from "./useCameraMonitor";
import type { Evidence, Frame, ObjectDetection } from "./engine";
import { unavailableEvidence } from "./engine";

const inside = { x: 0, y: 0, width: 0.5, height: 1 };
const outside = { x: 0.5, y: 0, width: 0.5, height: 1 };
const settings: MonitorSettings = {
  ...INITIAL_SETTINGS,
  zones: [
    { id: "inside", name: "Inside", enabled: true, box: inside },
    { id: "outside", name: "Outside", enabled: true, box: outside },
  ],
};
const box = { x: 0.1, y: 0.2, width: 0.2, height: 0.4 };
const positive: Evidence = { available: true, source: "object", score: 0.9, area: 0.1, motion: 0, box };
const empty: Evidence = { ...positive, score: 0, area: 0, box: null };
const moving: Evidence = { ...positive, source: "color", motion: 0.2 };
const stationary: Evidence = { ...moving, score: 1, motion: 0, box: { ...box, x: 0.6 } };
const dark = unavailableEvidence("object", "Outside is dark");

function image(darkHalf: "inside" | "outside" | "both" | null = null): Frame {
  const width = 40, height = 40, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const black = darkHalf === "both" || (darkHalf === "inside" && x < 20)
      || (darkHalf === "outside" && x >= 20);
    data.set(black ? [0, 0, 0, 255] : [50, 90, 150, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

function repeat(observations: ZoneObservation[], times = [0, 400, 800, 1200]) {
  let states: ZonePresenceStates = {};
  let result = updateZonePresence(states, observations, times[0], INITIAL_CONFIG);
  for (const at of times) {
    result = updateZonePresence(states, observations, at, INITIAL_CONFIG);
    states = result.states;
  }
  return result;
}

describe("per-zone frame evidence", () => {
  it("checks dark object-mode zones independently even when the other half is lit", () => {
    const values = extractZoneObservations(image("outside"), null, settings, []);
    expect(values.find((value) => value.id === "inside")?.evidence.available).toBe(true);
    expect(values.find((value) => value.id === "outside")?.evidence.available).toBe(false);
    expect(repeat(values, [0, 1000, 2000, 3000, 4000, 5000]).presence.status).toBe("unknown");
  });

  it("does not trust model predictions within a covered zone", () => {
    const prediction: ObjectDetection = { label: "dog", score: 0.95, box: { ...box, x: 0.6 } };
    const values = extractZoneObservations(image("outside"), null, settings, [prediction]);
    expect(values.find((value) => value.id === "outside")?.evidence.available).toBe(false);
    expect(repeat(values).presence.status).not.toBe("present");
  });

  it("recognizes a dog in either healthy zone without requiring both zones to see one", () => {
    for (const dogBox of [box, { ...box, x: 0.6 }]) {
      const values = extractZoneObservations(image(), null, settings, [{ label: "dog", score: 0.9, box: dogBox }]);
      expect(repeat(values).presence).toMatchObject({ status: "present", phase: "present" });
    }
  });

  it("allows healthy positive evidence while the other approach is dark", () => {
    const values = extractZoneObservations(image("outside"), null, settings, [{ label: "dog", score: 0.9, box }]);
    expect(repeat(values).presence.status).toBe("present");
  });

  it("does not let a distant high-score dog mask a qualifying nearer dog in the same zone", () => {
    const values = extractZoneObservations(image(), null, settings, [
      { label: "dog", score: 0.99, box: { x: 0.1, y: 0.1, width: 0.01, height: 0.01 } },
      { label: "dog", score: 0.75, box },
    ]);
    const result = repeat(values);
    expect(result.presence.status).toBe("present");
    expect(result.evidence.score).toBe(0.75);
  });

  it("excludes disabled zones and returns unknown when all zones are disabled", () => {
    const one = { ...settings, zones: settings.zones.map((zone) => ({ ...zone, enabled: zone.id === "inside" })) };
    const values = extractZoneObservations(image("outside"), null, one);
    expect(values.map((value) => value.id)).toEqual(["inside"]);
    expect(repeat(values, [0, 1000, 2000, 3000, 4000, 5000]).presence.status).toBe("absent");
    const disabled = { ...settings, zones: settings.zones.map((zone) => ({ ...zone, enabled: false })) };
    const none = extractZoneObservations(image(), null, disabled, [{ label: "dog", score: 0.99, box }]);
    expect(none).toEqual([]);
    expect(repeat(none).presence.status).toBe("unknown");
    expect(repeat(none).evidence.available).toBe(false);
  });

  it("handles fully dark color and object views as unknown", () => {
    for (const mode of ["object", "color"] as const) {
      const values = extractZoneObservations(image("both"), null, { ...settings, mode });
      expect(values.every((value) => !value.evidence.available)).toBe(true);
      expect(repeat(values).presence.status).toBe("unknown");
    }
  });
});

describe("independent multi-zone temporal history", () => {
  it("does not let a high-scoring stationary background mask a moving candidate in another zone", () => {
    const result = repeat([{ id: "inside", evidence: moving }, { id: "outside", evidence: stationary }]);
    expect(result.presence).toMatchObject({ status: "present", phase: "present" });
    expect(result.evidence.box).toEqual(box);
    expect(result.states.outside.status).toBe("unknown");
  });

  it("never transfers an initial motion latch to another zone's stationary blob", () => {
    let result = updateZonePresence({}, [{ id: "inside", evidence: moving }, { id: "outside", evidence: empty }], 0, INITIAL_CONFIG);
    for (const at of [400, 800, 1200, 1600, 2000]) {
      result = updateZonePresence(result.states, [{ id: "inside", evidence: empty }, { id: "outside", evidence: stationary }], at, INITIAL_CONFIG);
      expect(result.presence.status).not.toBe("present");
    }
    expect(result.states.outside.motionLatched).toBe(false);
  });

  it("retains a stationary dog in its own zone after its arrival motion", () => {
    let result = updateZonePresence({}, [{ id: "inside", evidence: moving }, { id: "outside", evidence: empty }], 0, INITIAL_CONFIG);
    for (const at of [400, 800, 1200, 2200, 3200]) {
      result = updateZonePresence(result.states, [{ id: "inside", evidence: { ...moving, motion: 0 } }, { id: "outside", evidence: empty }], at, INITIAL_CONFIG);
    }
    expect(result.presence).toMatchObject({ status: "present", phase: "present" });
  });

  it("does not reset a visit while any enabled zone remains dark or unknown", () => {
    const result = repeat([{ id: "inside", evidence: empty }, { id: "outside", evidence: dark }], [0, 1000, 2000, 3000, 4000, 5000, 6000]);
    expect(result.presence.status).toBe("unknown");
    expect(result.states.inside.status).toBe("absent");
  });

  it("requires every enabled zone to complete absence grace and never reports departure as fresh presence", () => {
    let result = repeat([{ id: "inside", evidence: positive }, { id: "outside", evidence: empty }]);
    for (const at of [1500, 2500, 3500, 4500, 5500, 6499]) {
      result = updateZonePresence(result.states, [{ id: "inside", evidence: empty }, { id: "outside", evidence: empty }], at, INITIAL_CONFIG);
      expect(result.presence.phase).not.toBe("present");
      expect(result.presence.status).not.toBe("absent");
    }
    result = updateZonePresence(result.states, [{ id: "inside", evidence: empty }, { id: "outside", evidence: empty }], 6500, INITIAL_CONFIG);
    expect(result.presence).toMatchObject({ status: "absent", phase: "absent" });
  });

  it("drops disabled-zone history so re-enabling cannot revive an old motion latch", () => {
    const first = repeat([{ id: "inside", evidence: moving }, { id: "outside", evidence: empty }]);
    const disabled = updateZonePresence(first.states, [{ id: "outside", evidence: empty }], 1600, INITIAL_CONFIG);
    expect(disabled.states.inside).toBeUndefined();
    const enabled = updateZonePresence(disabled.states, [{ id: "inside", evidence: { ...moving, motion: 0 } }, { id: "outside", evidence: empty }], 2000, INITIAL_CONFIG);
    expect(enabled.states.inside.motionLatched).toBe(false);
    expect(enabled.presence.status).not.toBe("present");
  });

  it("restarts each zone's timers after data loss or stale gaps", () => {
    const first = repeat([{ id: "inside", evidence: moving }, { id: "outside", evidence: positive }]);
    const after = updateZonePresence(first.states, [{ id: "inside", evidence: { ...moving, motion: 0 } }, { id: "outside", evidence: empty }], 20000, INITIAL_CONFIG);
    expect(after.presence.status).toBe("unknown");
    expect(after.states.inside.motionLatched).toBe(false);
    expect(after.states.outside.absenceSince).toBe(20000);
  });

  it("does not mutate input observations or fallback evidence arrays", () => {
    const evidence = Object.freeze([Object.freeze({ ...empty }), Object.freeze({ ...empty, score: 0.2 })]);
    expect(() => selectZoneEvidence(evidence as unknown as Evidence[], INITIAL_CONFIG)).not.toThrow();
    const previous = Object.freeze({});
    const observations = Object.freeze([{ id: "inside", evidence: positive }]);
    expect(() => updateZonePresence(previous, observations, 0, INITIAL_CONFIG)).not.toThrow();
  });
});
