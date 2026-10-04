import {
  clamp,
  FULL_FRAME_ROI,
  normalizeBox,
  unavailableEvidence,
} from "./types";
import type { CoatProfile, Evidence, Frame, ROI } from "./types";

export const DEFAULT_COAT_PROFILES: CoatProfile[] = [
  {
    id: "brown",
    name: "Brown coat",
    hue: 25,
    hueTolerance: 22,
    saturationMin: 0.28,
    saturationMax: 1,
    valueMin: 0.1,
    valueMax: 0.74,
  },
  {
    id: "gold",
    name: "Golden coat",
    hue: 39,
    hueTolerance: 24,
    saturationMin: 0.23,
    saturationMax: 1,
    valueMin: 0.28,
    valueMax: 1,
  },
];

export interface HSV {
  h: number;
  s: number;
  v: number;
}

export function rgbToHsv(r: number, g: number, b: number): HSV {
  r = clamp(r / 255);
  g = clamp(g / 255);
  b = clamp(b / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function matchesCoat(hsv: HSV, profile: CoatProfile): boolean {
  const hue = ((profile.hue % 360) + 360) % 360;
  const distance = Math.abs(hsv.h - hue);
  return (
    Math.min(distance, 360 - distance) <= profile.hueTolerance &&
    hsv.s >= profile.saturationMin &&
    hsv.s <= profile.saturationMax &&
    hsv.v >= profile.valueMin &&
    hsv.v <= profile.valueMax
  );
}

function validFrame(frame: Frame | null | undefined): frame is Frame {
  return (
    !!frame &&
    Number.isInteger(frame.width) &&
    Number.isInteger(frame.height) &&
    frame.width > 0 &&
    frame.height > 0 &&
    !!frame.data &&
    frame.width * frame.height <= 40_000_000 &&
    frame.data.length >= frame.width * frame.height * 4
  );
}

/** Nearest-neighbor sampling, bounded in both dimensions to keep phone work small. */
export function downsampleFrame(frame: Frame, maxWidth = 160): Frame | null {
  if (!validFrame(frame)) return null;
  const limit = Number.isFinite(maxWidth)
    ? Math.round(clamp(maxWidth, 16, 640))
    : 160;
  const scale = Math.min(1, limit / Math.max(frame.width, frame.height));
  const width = Math.max(1, Math.round(frame.width * scale));
  const height = Math.max(1, Math.round(frame.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(
      frame.height - 1,
      Math.floor(((y + 0.5) * frame.height) / height),
    );
    for (let x = 0; x < width; x++) {
      const sx = Math.min(
        frame.width - 1,
        Math.floor(((x + 0.5) * frame.width) / width),
      );
      const from = (sy * frame.width + sx) * 4,
        to = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) data[to + c] = frame.data[from + c];
    }
  }
  return { width, height, data };
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

/** Samples a 7×7 source-pixel patch around a normalized canvas tap. */
export function sampleCoatProfile(
  frame: Frame,
  x: number,
  y: number,
  baseProfile: CoatProfile,
  tolerance = 20,
): CoatProfile | null {
  if (!validFrame(frame) || !Number.isFinite(x) || !Number.isFinite(y))
    return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  const cx = Math.min(frame.width - 1, Math.floor(x * frame.width));
  const cy = Math.min(frame.height - 1, Math.floor(y * frame.height));
  const rs: number[] = [],
    gs: number[] = [],
    bs: number[] = [];
  for (
    let sy = Math.max(0, cy - 3);
    sy <= Math.min(frame.height - 1, cy + 3);
    sy++
  ) {
    for (
      let sx = Math.max(0, cx - 3);
      sx <= Math.min(frame.width - 1, cx + 3);
      sx++
    ) {
      const offset = (sy * frame.width + sx) * 4;
      if (frame.data[offset + 3] < 128) continue;
      rs.push(frame.data[offset]);
      gs.push(frame.data[offset + 1]);
      bs.push(frame.data[offset + 2]);
    }
  }
  if (!rs.length) return null;
  const hsv = rgbToHsv(median(rs), median(gs), median(bs));
  // Unlit/gray samples cannot establish a useful coat hue.
  if (hsv.v < 0.075 || hsv.s < 0.1) return null;
  return {
    ...baseProfile,
    hue: hsv.h,
    hueTolerance: Number.isFinite(tolerance) ? clamp(tolerance, 5, 90) : 20,
    saturationMin: Math.max(0.12, hsv.s - 0.28),
    saturationMax: Math.min(1, hsv.s + 0.3),
    valueMin: Math.max(0.075, hsv.v - 0.3),
    valueMax: Math.min(1, hsv.v + 0.3),
  };
}

export interface ColorEvidenceOptions {
  roi?: ROI;
  profiles?: readonly CoatProfile[];
  maxWidth?: number;
  /** Per-channel change (0–255) that qualifies a blob pixel as moving. */
  motionPixelThreshold?: number;
}

/**
 * Color is deliberately a heuristic. Only a single 4-connected blob counts;
 * many scattered coat-colored pixels cannot accumulate into a dog candidate.
 * Motion is measured within that blob, never elsewhere in the scene.
 */
export function extractColorEvidence(
  frame: Frame,
  previousFrame: Frame | null = null,
  options: ColorEvidenceOptions = {},
): Evidence {
  const roi = normalizeBox(options.roi ?? FULL_FRAME_ROI);
  if (!roi)
    return unavailableEvidence("color", "Select a valid detection zone");
  const profiles = options.profiles ?? DEFAULT_COAT_PROFILES;
  if (!profiles.length)
    return unavailableEvidence("color", "Choose a coat profile");
  const current = downsampleFrame(frame, options.maxWidth);
  if (!current) return unavailableEvidence("color", "No usable camera frame");
  let previous = previousFrame
    ? downsampleFrame(previousFrame, options.maxWidth)
    : null;
  if (previous?.width !== current.width || previous?.height !== current.height)
    previous = null;
  const { width, height, data } = current;
  const x0 = Math.max(0, Math.ceil(roi.x * width - 0.5));
  const y0 = Math.max(0, Math.ceil(roi.y * height - 0.5));
  const x1 = Math.min(width, Math.ceil((roi.x + roi.width) * width - 0.5));
  const y1 = Math.min(height, Math.ceil((roi.y + roi.height) * height - 0.5));
  const roiPixels = (x1 - x0) * (y1 - y0);
  if (roiPixels < 4)
    return unavailableEvidence("color", "Detection zone is too small");
  const mask = new Uint8Array(width * height);
  let litPixels = 0,
    previousLitPixels = 0,
    usablePixels = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const index = y * width + x,
        offset = index * 4;
      if (data[offset + 3] < 128) continue;
      usablePixels++;
      const r = data[offset],
        g = data[offset + 1],
        b = data[offset + 2];
      if (Math.max(r, g, b) > 18) litPixels++;
      if (
        previous &&
        previous.data[offset + 3] >= 128 &&
        Math.max(
          previous.data[offset],
          previous.data[offset + 1],
          previous.data[offset + 2],
        ) > 18
      )
        previousLitPixels++;
      const hsv = rgbToHsv(r, g, b);
      if (profiles.some((profile) => matchesCoat(hsv, profile)))
        mask[index] = 1;
    }
  }
  if (usablePixels < roiPixels * 0.8 || litPixels < roiPixels * 0.02) {
    return unavailableEvidence("color", "Camera view is black or unavailable");
  }
  // A camera resuming from a black frame is not motion evidence.
  if (previousLitPixels < roiPixels * 0.02) previous = null;
  const queue = new Int32Array(width * height);
  let largestCount = 0,
    largestMoving = 0;
  let largestBounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null = null;
  const motionThreshold = Number.isFinite(options.motionPixelThreshold)
    ? clamp(options.motionPixelThreshold!, 1, 255)
    : 30;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const start = y * width + x;
      if (!mask[start]) continue;
      let head = 0,
        tail = 1,
        moving = 0;
      queue[0] = start;
      mask[start] = 0;
      let minX = x,
        maxX = x,
        minY = y,
        maxY = y;
      while (head < tail) {
        const index = queue[head++],
          px = index % width,
          py = Math.floor(index / width);
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
        const offset = index * 4;
        if (
          previous &&
          Math.max(
            Math.abs(data[offset] - previous.data[offset]),
            Math.abs(data[offset + 1] - previous.data[offset + 1]),
            Math.abs(data[offset + 2] - previous.data[offset + 2]),
          ) >= motionThreshold
        )
          moving++;
        // Strict four-neighbor connectivity avoids checkerboard noise merging.
        if (px > x0 && mask[index - 1]) {
          mask[index - 1] = 0;
          queue[tail++] = index - 1;
        }
        if (px + 1 < x1 && mask[index + 1]) {
          mask[index + 1] = 0;
          queue[tail++] = index + 1;
        }
        if (py > y0 && mask[index - width]) {
          mask[index - width] = 0;
          queue[tail++] = index - width;
        }
        if (py + 1 < y1 && mask[index + width]) {
          mask[index + width] = 0;
          queue[tail++] = index + width;
        }
      }
      if (tail > largestCount) {
        largestCount = tail;
        largestMoving = moving;
        largestBounds = { minX, minY, maxX, maxY };
      }
    }
  }
  if (!largestBounds)
    return {
      available: true,
      source: "color",
      score: 0,
      area: 0,
      motion: 0,
      box: null,
      reason: "No matching coat blob in the zone",
    };
  const blobWidth = largestBounds.maxX - largestBounds.minX + 1;
  const blobHeight = largestBounds.maxY - largestBounds.minY + 1;
  const compactness = largestCount / (blobWidth * blobHeight);
  return {
    available: true,
    source: "color",
    score: clamp(0.45 + compactness * 0.55),
    area: largestCount / roiPixels,
    motion: previous ? largestMoving / largestCount : 0,
    box: {
      x: largestBounds.minX / width,
      y: largestBounds.minY / height,
      width: blobWidth / width,
      height: blobHeight / height,
    },
    reason: previous
      ? "Coherent coat-color blob"
      : "Waiting for motion comparison",
  };
}

/** Short alias for callers that use the color heuristic only. */
export const extractEvidence = extractColorEvidence;
