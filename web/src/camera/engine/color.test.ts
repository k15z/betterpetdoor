import { describe, expect, it } from "vitest";
import {
  DEFAULT_COAT_PROFILES,
  downsampleFrame,
  extractColorEvidence,
  matchesCoat,
  rgbToHsv,
  sampleCoatProfile,
} from "./color";
import type { Frame } from "./types";

function frame(width = 40, height = 40, rgb = [50, 90, 150]): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...rgb, 255], i * 4);
  return { width, height, data };
}

function paint(
  input: Frame,
  x: number,
  y: number,
  width: number,
  height: number,
  rgb = [180, 110, 40],
): Frame {
  const data = Uint8ClampedArray.from(input.data);
  for (let py = y; py < y + height; py++) {
    for (let px = x; px < x + width; px++)
      data.set([...rgb, 255], (py * input.width + px) * 4);
  }
  return { ...input, data };
}

describe("color evidence", () => {
  it("finds a connected brown blob and motion inside its box", () => {
    const before = frame();
    const current = paint(before, 10, 10, 10, 10);
    const evidence = extractColorEvidence(current, before);
    expect(evidence).toMatchObject({
      available: true,
      area: 100 / 1600,
      motion: 1,
      score: 1,
    });
    expect(evidence.box).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.25,
      height: 0.25,
    });
  });

  it("keeps a stationary color blob as positive visual evidence without inventing motion", () => {
    const still = paint(frame(), 10, 10, 10, 10);
    expect(extractColorEvidence(still, still)).toMatchObject({
      available: true,
      area: 100 / 1600,
      motion: 0,
    });
    expect(extractColorEvidence(still)).toMatchObject({
      available: true,
      motion: 0,
    });
  });

  it("does not count unrelated motion outside the selected blob", () => {
    const before = paint(frame(), 10, 10, 10, 10);
    const current = paint(before, 25, 25, 10, 10, [0, 180, 200]);
    expect(extractColorEvidence(current, before).motion).toBe(0);
  });

  it("uses the largest connected component, never a scattered matching-pixel total", () => {
    let noise = frame();
    for (let y = 0; y < 40; y += 2)
      for (let x = 0; x < 40; x += 2) noise = paint(noise, x, y, 1, 1);
    const evidence = extractColorEvidence(noise, frame());
    expect(evidence.area).toBe(1 / 1600);
    const withBlob = paint(noise, 10, 10, 8, 8);
    expect(extractColorEvidence(withBlob).area).toBeLessThan(0.06);
  });

  it("excludes blobs and motion outside the ROI and normalizes area to the ROI", () => {
    const before = frame();
    const outside = paint(before, 0, 0, 10, 10);
    const roi = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
    expect(extractColorEvidence(outside, before, { roi })).toMatchObject({
      area: 0,
      motion: 0,
      box: null,
    });
    const inside = paint(outside, 20, 20, 10, 10);
    expect(extractColorEvidence(inside, before, { roi })).toMatchObject({
      area: 0.25,
      motion: 1,
    });
  });

  it("treats black, transparent, and malformed frames as unavailable", () => {
    expect(extractColorEvidence(frame(40, 40, [0, 0, 0])).available).toBe(
      false,
    );
    expect(extractColorEvidence(frame(40, 40, [8, 8, 8])).available).toBe(
      false,
    );
    expect(
      extractColorEvidence({
        width: 40,
        height: 40,
        data: new Uint8Array(6400),
      }).available,
    ).toBe(false);
    expect(
      extractColorEvidence({ width: 20, height: 20, data: [] }).available,
    ).toBe(false);
  });

  it("does not interpret camera recovery from black as coat arrival motion", () => {
    const current = paint(frame(), 10, 10, 10, 10);
    expect(extractColorEvidence(current, frame(40, 40, [0, 0, 0])).motion).toBe(
      0,
    );
  });

  it("evaluates darkness in the selected ROI, not a brighter area elsewhere", () => {
    const current = paint(frame(), 20, 20, 20, 20, [0, 0, 0]);
    expect(
      extractColorEvidence(current, null, {
        roi: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
      }).available,
    ).toBe(false);
  });

  it("rejects invalid zones and an empty set of profiles", () => {
    expect(
      extractColorEvidence(frame(), null, {
        roi: { x: 2, y: 0, width: 1, height: 1 },
      }).available,
    ).toBe(false);
    expect(
      extractColorEvidence(frame(), null, { profiles: [] }).available,
    ).toBe(false);
  });

  it("supports two presets and handles circular hue distance", () => {
    expect(DEFAULT_COAT_PROFILES.map((profile) => profile.id)).toEqual([
      "brown",
      "gold",
    ]);
    expect(matchesCoat(rgbToHsv(140, 75, 25), DEFAULT_COAT_PROFILES[0])).toBe(
      true,
    );
    expect(matchesCoat(rgbToHsv(230, 170, 65), DEFAULT_COAT_PROFILES[1])).toBe(
      true,
    );
    expect(
      matchesCoat(
        { h: 359, s: 0.8, v: 0.5 },
        { ...DEFAULT_COAT_PROFILES[0], hue: 2, hueTolerance: 5 },
      ),
    ).toBe(true);
  });

  it("uses a 7×7 median calibration neighborhood resistant to one noisy pixel", () => {
    const coat = paint(
      frame(15, 15, [170, 100, 35]),
      7,
      7,
      1,
      1,
      [0, 255, 255],
    );
    const sampled = sampleCoatProfile(coat, 0.5, 0.5, DEFAULT_COAT_PROFILES[0]);
    expect(sampled?.hue).toBeCloseTo(rgbToHsv(170, 100, 35).h);
    expect(sampled?.id).toBe("brown");
    expect(sampled && matchesCoat(rgbToHsv(170, 100, 35), sampled)).toBe(true);
  });

  it("rejects black/gray calibration samples and handles edge taps", () => {
    expect(
      sampleCoatProfile(
        frame(10, 10, [0, 0, 0]),
        0.5,
        0.5,
        DEFAULT_COAT_PROFILES[0],
      ),
    ).toBeNull();
    expect(
      sampleCoatProfile(
        frame(10, 10, [100, 100, 100]),
        0.5,
        0.5,
        DEFAULT_COAT_PROFILES[0],
      ),
    ).toBeNull();
    expect(
      sampleCoatProfile(
        frame(10, 10, [170, 100, 35]),
        1,
        1,
        DEFAULT_COAT_PROFILES[0],
      ),
    ).not.toBeNull();
    expect(
      sampleCoatProfile(frame(), -0.1, 0.5, DEFAULT_COAT_PROFILES[0]),
    ).toBeNull();
  });

  it("bounds processing work on portrait and landscape frames and preserves RGBA", () => {
    const portrait = downsampleFrame(frame(100, 400), 100)!;
    expect([portrait.width, portrait.height]).toEqual([25, 100]);
    expect(Array.from(portrait.data).slice(0, 4)).toEqual([50, 90, 150, 255]);
    const landscape = downsampleFrame(frame(400, 100), 100)!;
    expect([landscape.width, landscape.height]).toEqual([100, 25]);
  });
});
