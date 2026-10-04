import { describe, expect, it } from "vitest";
import { evidenceFromDetections } from "./object";
import type { ObjectDetection } from "./types";

const dog: ObjectDetection = {
  label: "dog",
  score: 0.85,
  box: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
};

describe("object evidence adapter", () => {
  it("passes dog confidence through with no motion requirement", () => {
    const evidence = evidenceFromDetections([dog]);
    expect(evidence).toMatchObject({
      available: true,
      source: "object",
      score: 0.85,
      motion: 0,
    });
    expect(evidence.box?.width).toBeCloseTo(dog.box.width);
    expect(evidence.box?.height).toBeCloseTo(dog.box.height);
    expect(evidence.area).toBeCloseTo(0.16);
  });

  it("leaves thresholding to the state machine down to the model floor of 0.15", () => {
    expect(evidenceFromDetections([{ ...dog, score: 0.2 }]).score).toBe(0.2);
    expect(evidenceFromDetections([{ ...dog, score: 0.15 }]).score).toBe(0.15);
    expect(evidenceFromDetections([{ ...dog, score: 0.149 }]).score).toBe(0);
  });

  it("ignores people and cats, invalid boxes, and invalid scores", () => {
    expect(
      evidenceFromDetections([
        { ...dog, label: "person" },
        { ...dog, label: "cat" },
        { ...dog, box: { ...dog.box, width: -1 } },
        { ...dog, score: Number.NaN },
      ]),
    ).toMatchObject({ available: true, score: 0, box: null });
  });

  it("rejects detections outside the ROI and boxes that barely overlap it", () => {
    const roi = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
    expect(evidenceFromDetections([dog], roi).box).toBeNull();
    const inside = {
      ...dog,
      box: { x: 0.55, y: 0.55, width: 0.3, height: 0.3 },
    };
    expect(evidenceFromDetections([inside], roi).area).toBeCloseTo(0.36);
    expect(evidenceFromDetections([dog], roi, 0.05).score).toBe(0.85);
  });

  it("selects the strongest qualified dog and treats an empty list as valid clear evidence", () => {
    expect(evidenceFromDetections([{ ...dog, score: 0.3 }, dog]).score).toBe(
      0.85,
    );
    expect(evidenceFromDetections([])).toMatchObject({
      available: true,
      score: 0,
      area: 0,
      box: null,
    });
  });

  it("prefers a threshold-qualified near dog over a higher-scoring tiny distant dog", () => {
    const tiny = { ...dog, score: 0.99, box: { x: 0.1, y: 0.1, width: 0.01, height: 0.01 } };
    const near = { ...dog, score: 0.75 };
    const roi = { x: 0, y: 0, width: 1, height: 1 };
    for (const detections of [[tiny, near], [near, tiny]]) {
      const evidence = evidenceFromDetections(detections, roi, 0.35, { minArea: 0.025, minScore: 0.62 });
      expect(evidence.score).toBe(0.75);
      expect(evidence.area).toBeCloseTo(0.16);
    }
    expect(evidenceFromDetections([tiny, near]).score).toBe(0.99);
  });

  it("still reports below-threshold evidence when no dog qualifies", () => {
    const evidence = evidenceFromDetections([{ ...dog, score: 0.2 }], undefined, 0.35, { minArea: 0.025, minScore: 0.62 });
    expect(evidence).toMatchObject({ available: true, score: 0.2 });
  });

  it("treats invalid ROI as unavailable, not absence", () => {
    expect(
      evidenceFromDetections([dog], { x: 0, y: 0, width: 0, height: 1 })
        .available,
    ).toBe(false);
  });
});
