import {
  clamp,
  FULL_FRAME_ROI,
  intersectBoxes,
  normalizeBox,
  unavailableEvidence,
} from "./types";
import type { Evidence, ObjectDetection, ROI } from "./types";

export interface ObjectEvidenceThresholds {
  minArea?: number;
  minScore?: number;
}

/** Adapt model predictions without hiding the UI's configurable score threshold. */
export function evidenceFromDetections(
  detections: readonly ObjectDetection[],
  roi: ROI = FULL_FRAME_ROI,
  minRoiOverlap = 0.35,
  thresholds: ObjectEvidenceThresholds = {},
): Evidence {
  const zone = normalizeBox(roi);
  if (!zone)
    return unavailableEvidence("object", "Select a valid detection zone");
  const minimumOverlap = Number.isFinite(minRoiOverlap)
    ? clamp(minRoiOverlap)
    : 0.35;
  const qualifies = (score: number, area: number) => score >= (thresholds.minScore ?? 0)
    && area >= (thresholds.minArea ?? 0);
  let best: Evidence = {
    available: true,
    source: "object",
    score: 0,
    area: 0,
    motion: 0,
    box: null,
    reason: "No dog detected in the zone",
  };
  for (const detection of detections) {
    if (
      detection.label.toLowerCase() !== "dog" ||
      !Number.isFinite(detection.score) ||
      detection.score < 0.15
    )
      continue;
    const box = normalizeBox(detection.box);
    if (!box) continue;
    const overlap = intersectBoxes(box, zone);
    if (!overlap) continue;
    const intersectionArea = overlap.width * overlap.height;
    if (intersectionArea / (box.width * box.height) < minimumOverlap) continue;
    const score = clamp(detection.score);
    const area = clamp(intersectionArea / (zone.width * zone.height));
    const candidateQualifies = qualifies(score, area);
    const bestQualifies = best.box !== null && qualifies(best.score, best.area);
    if ((candidateQualifies && !bestQualifies)
      || (candidateQualifies === bestQualifies && (score > best.score || (score === best.score && area > best.area)))) {
      best = {
        available: true,
        source: "object",
        score,
        area,
        motion: 0,
        box,
        reason: "Dog detected in the zone",
      };
    }
  }
  return best;
}
