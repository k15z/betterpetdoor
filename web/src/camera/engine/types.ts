/** All boxes are normalized to the full camera frame, with a top-left origin. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ROI = Box;
export type DetectionSource = "color" | "object";

/** Canvas ImageData is assignable; the engine itself does not depend on the DOM. */
export interface Frame {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export interface CoatProfile {
  id: string;
  name: string;
  /** Hue is in degrees. Saturation and value are in the range 0–1. */
  hue: number;
  hueTolerance: number;
  saturationMin: number;
  saturationMax: number;
  valueMin: number;
  valueMax: number;
}

/** Color score is a blob-coherence heuristic, not a dog-classification probability. */
export interface Evidence {
  available: boolean;
  source: DetectionSource;
  score: number;
  /** Fraction of ROI occupied by the selected blob or clipped object box. */
  area: number;
  /** Fraction of selected color-blob pixels that changed since the previous frame. */
  motion: number;
  box: Box | null;
  reason?: string;
}

export interface ObjectDetection {
  label: string;
  score: number;
  box: Box;
}

export const FULL_FRAME_ROI: ROI = { x: 0, y: 0, width: 1, height: 1 };

export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

/** Invalid/empty selections remain invalid rather than silently expanding the ROI. */
export function normalizeBox(box: Box): Box | null {
  if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite))
    return null;
  if (box.width <= 0 || box.height <= 0) return null;
  const x = clamp(box.x);
  const y = clamp(box.y);
  const right = clamp(box.x + box.width);
  const bottom = clamp(box.y + box.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function intersectBoxes(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
}

export function unavailableEvidence(
  source: DetectionSource,
  reason = "Camera unavailable",
): Evidence {
  return {
    available: false,
    source,
    score: 0,
    area: 0,
    motion: 0,
    box: null,
    reason,
  };
}
