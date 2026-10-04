# Real-photo COCO-SSD smoke test

Run: 2026-10-03T20:55:26.006Z
Runtime: Node v24.19.0, linux/x64, TFJS CPU; COCO-SSD 2.2.3 / TFJS 4.22.0.

Result: 8/12 cases passed; 6 photographs × 2 preprocessing sizes.

Default gate: exact dog category, confidence ≥ 0.62, ROI area ≥ 0.025, full-frame ROI. Uses the actual installed model and production evidence adapter.

| Photo | Input | Expected dog | Dog score | Dog ROI area | Gate | Result |
|---|---:|---|---:|---:|---|---|
| dog-standing-leaves.jpg | 960×640 | yes | none ≥ 0.15 | 0.0000 | no dog | FAIL |
| dog-standing-leaves.jpg | 320×213 | yes | none ≥ 0.15 | 0.0000 | no dog | FAIL |
| dog-sitting-indoor.jpg | 960×1280 | yes | 0.9608 | 0.4197 | dog | PASS |
| dog-sitting-indoor.jpg | 320×427 | yes | 0.9711 | 0.4185 | dog | PASS |
| dog-standing-tucker.jpg | 800×600 | yes | 0.9578 | 0.4742 | dog | PASS |
| dog-standing-tucker.jpg | 320×240 | yes | 0.9380 | 0.4795 | dog | PASS |
| dog-sitting-person.jpg | 960×640 | yes | none ≥ 0.15 | 0.0000 | no dog | FAIL |
| dog-sitting-person.jpg | 320×213 | yes | none ≥ 0.15 | 0.0000 | no dog | FAIL |
| negative-brown-sofa.jpg | 960×720 | no | none ≥ 0.15 | 0.0000 | no dog | PASS |
| negative-brown-sofa.jpg | 320×240 | no | none ≥ 0.15 | 0.0000 | no dog | PASS |
| negative-orange-cat.jpg | 960×638 | no | none ≥ 0.15 | 0.0000 | no dog | PASS |
| negative-orange-cat.jpg | 320×213 | no | none ≥ 0.15 | 0.0000 | no dog | PASS |

Pixel and normalized boxes, other model classes, source links, hashes, and raw measured scores are in model-smoke-results.json. Attribution and original source licenses are in ATTRIBUTION.md and sources.json.

## Interpretation and limits

- Six hand-selected photographs; smoke test only, no statistically meaningful accuracy estimate.
- CPU timings are Node/container measurements and do not estimate phone browser performance.
- No live camera, dog door hardware, browser rendering, video, occlusion sequence, or night conditions tested.
- Full-frame ROI; thresholds minScore .62 and minArea .025 use the production evidence adapter.
- The 320-wide pass uses TFJS bilinear resizing with the app’s dimensions, not browser Canvas; browser pixel-level equivalence is unverified.
- A zero dogScore in the raw JSON is the production adapter’s empty-evidence value, not a measured zero dog-class probability. No emitted dog prediction survived the model’s 0.15 output cutoff/NMS.

## Observed misses

- dog-standing-leaves.jpg (original): expected dog=true, emitted sheep 0.4459.
- dog-standing-leaves.jpg (width320): expected dog=true, emitted sheep 0.6955.
- dog-sitting-person.jpg (original): expected dog=true, emitted bear 0.9209, person 0.7313.
- dog-sitting-person.jpg (width320): expected dog=true, emitted bear 0.8944, person 0.5597.

The misses are wrong-class predictions, so lowering the 0.62 UI confidence gate alone cannot recover these examples. Do not broaden the accepted class list to bear or sheep. Consider testing a higher-accuracy detector on this same unchanged fixture set and camera-angle/lighting samples before any real-world use.

## Reproduction

Run npm install, ensure public/models/coco-ssd contains model.json and all five weight shards, then node scripts/media-smoke.mjs. The script starts and closes its own loopback-only HTTP server for local model loading. No public deployment or inference service is used.
