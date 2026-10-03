# COCO-SSD Lite vs MobileNet v2: same-photo smoke test

## Decision

Expose both modes. Prefer MobileNet v2 as the recommended/default recognizer for this prototype because it recovers one clear standing-golden failure at app-sized input; provide Lite as the explicit smaller/faster alternative. Label the tradeoff, do not call either reliable or safe for unattended real door control. This tiny sample is insufficient to establish which is best on the target phone or actual doorway.

## What changed

- Lite: 8/12 total inference runs pass; at 320-wide input, 4/6 photos pass (2/4 dog positives, 2/2 non-dog negatives).
- MobileNet v2: 9/12 total runs pass; at 320-wide input, 5/6 photos pass (3/4 dog positives, 2/2 non-dog negatives).
- Both models still miss the cropped golden retriever next to a person; each labels it bear.
- V2 fixes the standing retriever against leaves at both sizes but regresses Tucker at original 800×600 (bear 0.8194). Tucker is correctly dog 0.9205 when resized to 320×240. This demonstrates preprocessing sensitivity.

## App-sized measured results

| Fixture | Lite result | V2 result |
|---|---|---|
| dog-standing-leaves.jpg | sheep 0.6955; FAIL | dog 0.9274; PASS |
| dog-sitting-indoor.jpg | dog 0.9711; PASS | dog 0.9181; PASS |
| dog-standing-tucker.jpg | dog 0.9380; PASS | dog 0.9205; PASS |
| dog-sitting-person.jpg | bear 0.8944; FAIL | bear 0.5909; FAIL |
| negative-brown-sofa.jpg | couch 0.9106; PASS | couch 0.8972; PASS |
| negative-orange-cat.jpg | cat 0.9110; PASS | cat 0.9835; PASS |

Gate: exact dog, confidence ≥0.62, box area ≥0.025 of full-frame ROI. Model emits candidates ≥0.15. All scores and boxes are preserved in each raw JSON report.

## Cost

- Lite: 18,561,843 bytes (18.56 MB / 17.70 MiB), 5 weight shards plus model.json.
- V2: 67,771,262 bytes (67.77 MB / 64.63 MiB), 17 weight shards plus model.json; 3.65× the download size.
- At 320-wide input, median measured Node CPU inference: Lite 1.596 s; V2 2.739 s (1.72×). These are not phone/WebGL performance claims.

## Source and reproduction

- Official V2 URL was resolved from the installed @tensorflow-models/coco-ssd 2.2.3 ObjectDetection constructor after reading its dist/index.js BASE_PATH/getPrefix implementation: https://storage.googleapis.com/tfjs-models/savedmodel/ssd_mobilenet_v2/model.json
- Official source: https://github.com/tensorflow/tfjs-models/blob/master/coco-ssd/src/index.ts
- npm package declares Apache-2.0: https://github.com/tensorflow/tfjs-models/blob/master/coco-ssd/package.json
- V2 download manifest and SHA-256 hashes: model-v2-download.json. Assets saved separately to public/models/coco-ssd-v2.
- Download: node scripts/download-model-v2.mjs
- Lite test: node scripts/media-smoke.mjs --base=lite_mobilenet_v2
- V2 test: node scripts/media-smoke.mjs --base=mobilenet_v2
- Each test starts its own loopback-only HTTP server, loads the actual local model, uses the production evidence adapter, saves variant-specific reports, and exits 1 if a fixture expectation fails. No remote inference service is used.
- Original Lite results were preserved. All fixture hashes match across both runs.

## Limits

- Six selected photos, each reused at two sizes; not twelve independent examples.
- No phone/WebGL, camera, night conditions, real-time latency, hardware, or safety validation.
- 320-wide resizing uses TFJS bilinear and is not guaranteed pixel-identical to Canvas drawImage.
- Node CPU timings are single inferences in one shared container; not a controlled sustained benchmark.
