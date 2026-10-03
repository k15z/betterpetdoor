# Camera-mode verification

This is a local development handoff. Nothing was pushed, deployed, or connected
to live door hardware. Existing Fly auto-stop settings were left unchanged.

## Deterministic checks

- Go unit/integration tests, internal-package race tests, and `go vet` passed.
- TypeScript and Vite production build passed.
- ESLint passed.
- 62 frontend tests passed, including 6 React/Mantine lifecycle tests.
  Camera engine tests cover coherent color blobs, median calibration, dark frames,
  configured regions, independent inside/outside motion latches, stationary dogs,
  temporal arrival/absence filtering, interrupted frames, and nearby-versus-tiny
  dog selection. UI lifecycle tests use mocked camera and door services.
- Backend tests cover authenticated APIs, duplicate events and multiple cameras,
  durable intent/restart handling, provider ambiguity, manual overrides, and
  fresh known-safe automatic and manual close gates.
- Production Go handler tests verify same-origin CSP, camera permission policy,
  JSON/JS/WASM/model-shard MIME types, and missing asset 404 behavior.
- Model files are downloaded from official TensorFlow hosting and checked against
  committed SHA-256/size manifests. The source archive excludes model binaries.

## Actual model inference, separate from unit-test success

Six licensed photos were run through the installed COCO-SSD model and the
production dog-only evidence adapter. Four photos contain golden retrievers;
two negatives contain a sofa and an orange cat. Each was tested at its supplied
resolution and at 320-pixel width, preserving aspect ratio.

At app-size input:

| Model | Dogs found | Negatives correctly rejected | Known misses |
| --- | --- | --- | --- |
| MobileNet v2 | 3 / 4 | 2 / 2 | Cropped retriever beside person |
| Lite MobileNet v2 | 2 / 4 | 2 / 2 | Pale standing retriever; cropped retriever |

Including originals, v2 passed 9/12 cases and Lite 8/12. V2 misclassified one
original-resolution standing photo that it recognized after resizing. These
results show preprocessing sensitivity and known limitations, not an accuracy
benchmark. Confidence-threshold reduction cannot recover a wrong-class result.
No non-dog animal labels are accepted as dogs.

`npm run test:media` intentionally exits 1 for the known photo-test misses. Raw
classes, boxes, measured scores, source licenses, model provenance, and reports
are in `web/test-media/`. It is Node CPU inference with TFJS bilinear resizing;
it is not bit-identical to browser Canvas resizing and not a phone-speed test.

## Not verified

- Cloud-browser visual/mobile QA was blocked when opening the local test server
  (`net::ERR_BLOCKED_BY_CLIENT`). No alternate route bypassed that restriction.
- The prepared browser/Canvas smoke harness was not executed. Go handler/CSP
  tests do not establish that every browser/GPU runs the model successfully.
- No real Android camera, front/rear device behavior, wake-lock behavior,
  through-glass/night detection, long-running heat/battery use, or live video
  sequence was tested.
- No real Wayzn door was opened, closed, armed, or reconfigured.
- Docker execution was unavailable here; the Dockerfile's checksum-pinned model
  download/build sequence was updated, but a container image was not built.

Before unattended use, test the actual phone and both dogs in representative
lighting, verify independent physical safety sensing, and arrange one continuously
running server with persistent SQLite. Stopping/locking the phone stops new
camera-triggered openings; an already scheduled close remains active until
explicitly canceled and always depends on a fresh provider safety check.
