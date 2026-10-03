# Phone camera mode

The dashboard can use a phone/browser camera to detect a dog locally, then send a
small authenticated detection event to the selected door. Images and video are
not uploaded by this feature. Test detection before arming a real door. The model
can miss dogs or mistake objects/reflections for dogs, especially through glass;
this is a convenience feature, not a physical safety sensor.

## Required operating conditions

- Use HTTPS (or localhost), allow camera access, and keep the camera page visible
  and the device awake. A backgrounded, suspended, disconnected or locked browser
  cannot reliably detect a dog. Start in test mode and explicitly arm each time.
- Run **one continuously running Better Pet Door server** with its SQLite volume.
  The included `fly.toml` still enables auto-stop with zero minimum machines. That
  default is **not sufficient for unattended timed closing**: a stored deadline
  cannot wake a stopped machine. Before relying on automatic closing, explicitly
  arrange an always-running deployment (disable Fly auto-stop and maintain at
  least one running machine, or equivalent on your host). This change does not
  modify or deploy infrastructure. Heartbeats while a page is open are not a
  substitute for that operating requirement.
- Keep the vendor's physical safety sensors functional. Automatic closing requires
  a fresh provider status request showing `online: true`, `moving: false`, a known
  open state, and `safe_to_close: true`. Missing connectivity or safety data, a
  moving door, obstruction, heat, offline state, unknown state or provider errors
  **hold the close**. The worker checks again every 15 seconds. The provider's
  snapshot and its sensors are still the source of truth; the app cannot certify
  their accuracy or physical freshness. Camera non-detection never means safe.
- Verify status in the UI and supervise initial tests. Unknown safety can mean
  the door stays open indefinitely. This feature is not a security or
  emergency-access guarantee. No live hardware test was performed for this change.

## Timer and manual controls

The default interval is five minutes, configurable from one to sixty minutes.
The server persists the deadline **before sending open**. Repeated detections do
not extend it. Detection will only send open for a door confirmed online,
stationary and closed; it never takes close ownership of a door already open.

Stop camera/disarm stops new automatic openings but **retains an existing close
schedule**. This means the server can still close a door after the camera page
has stopped, subject to the provider safety check. Use **Cancel automatic close**
to clear the deadline and disarm; inspect the door and control it manually.

The existing manual Open, Close, and vendor Open-and-close commands, through both
REST and MCP, disarm camera mode and clear the pending camera close before sending
the manual command. Manual Close obtains another provider status under the shared
door lock, so a stale safe UI snapshot cannot authorize a close. Offline, moving,
unknown, unsafe, or failed status reads hold that command and keep automation
disarmed; a door already confirmed closed needs no command. A manual command
timeout does not re-enable automation. Open
and Close are separate actions; the vendor's Open-and-close uses its own configured
interval and does not accept this feature's custom duration.

A successful provider response is not proof of physical movement. After a close
attempt, the server waits for provider confirmation that the door is closed. An
ambiguous close failure is not blindly retried, even after a restart: the UI asks
for a manual check. A crash between persisted intent and transmission can also
require manual intervention. Do not assume exactly-once delivery to the hardware.
After confirmed closure there is a 30-second camera-open cooldown.

## Ownership and recovery

Each armed browser uses its own random session ID. One session can own a door at
a time; send a heartbeat every 15 seconds to renew the 45-second lease. Expired
leases reject detections and must be explicitly armed again. A second browser
cannot silently take over a current owner. All users share the existing admin
permission, so this lease prevents accidental conflicting clients rather than
providing a separate security boundary.

Close deadlines, command intents, and the most recent 512 detection IDs persist
in SQLite. On restart, overdue deadlines are recovered and provider safety is
checked before any close. No close can run while the host/process is stopped.
All status, manual commands, camera events, and deletion are serialized per door
inside the one server process. Multiple active servers sharing a database are not
supported. Deleting a door removes its camera state and stops its managed close;
physically check the door before removing it.

## API

All camera routes use the existing admin session cookie or bearer authentication.
Send JSON bodies; unknown fields are rejected. Session/event IDs are 8–128 ASCII
letters, digits, hyphens or underscores; browser-generated UUIDs are suitable.
No camera frames or image data belong in these requests.

| Method | Route suffix under `/api/doors/{id}` | Body |
| --- | --- | --- |
| GET | `/camera` | none |
| POST | `/camera/arm` | `{"session_id":"browser-uuid","auto_close_seconds":300}` |
| POST | `/camera/heartbeat` | `{"session_id":"browser-uuid"}` |
| POST | `/camera/detections` | `{"session_id":"browser-uuid","event_id":"event-uuid"}` |
| POST | `/camera/disarm` | `{"session_id":"browser-uuid"}` |
| POST | `/camera/cancel-close` | `{}` |

Responses include `armed`, `session_id`, `auto_close_seconds`, `close_due_at`,
`lease_expires_at`, `cooldown_until`, `status`, `message`, `door_id`, `updated_at`.
Timestamp fields are UTC RFC3339 or null. Poll this state to display the deadline
and held/unconfirmed warnings. A 409 indicates an expired or conflicting camera
owner. A 502 means a provider operation could not be confirmed; inspect current
camera state rather than automatically resending a hardware command.

The API emits only normalized state and diagnostic messages; credentials and
camera images are not included. Status reads from older deployments may have
inferred `online: true` when `Connected` was missing; this version correctly
returns `online: null` and does not automate on that uncertainty.

## Local setup and frontend model assets

Use Node.js 24 and Go 1.26. In `web/`:

```sh
npm ci
npm run model:download       # both accurate (68 MB) and Lite (19 MB) variants
npm test
npm run lint
npm run build
```

`npm run model:download -- accurate` or `-- lite` downloads only that variant.
The official TensorFlow.js files are checked against committed SHA-256 hashes in
`web/scripts/model-assets.json`. Model binaries are excluded from git and the
source archive. Download them before a local frontend build. The Docker build downloads and
verifies both models automatically, then copies them into static output. No runtime CDN is used. No API key,
paid inference, image upload, analytics, or third-party model service is added.
TensorFlow.js and COCO-SSD are Apache-2.0; see the package license and upstream
[COCO-SSD documentation](https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd).

The dashboard door options menu includes Camera mode. Camera/model bundles are
lazy loaded, leaving normal door controls independent. The camera screen uses
existing session-cookie authentication, with no browser-stored admin bearer key.
Preview and demo never arm a physical door. Arming requires a live usable camera,
a named selected door, and explicit acknowledgement. Front/rear selection stops
the prior stream; start a fresh preview, check zones, and recalibrate coat colors.
Two independently configured approach zones cover inside and outside views;
either may establish presence. They do not infer travel direction or verify safety.

MobileNet v2 is the recommended model here because it caught 3 of 4 retriever
photos at app-size in a small smoke test, versus 2 of 4 for Lite. Both rejected
2 negative photos (sofa and orange cat), and both missed a cropped retriever.
Neither is validated for unattended door control. Model choice, camera angle,
lighting, reflections through glass, partial dogs, and image preprocessing matter.
These are six hand-selected still images, not a representative accuracy benchmark.
See `web/test-media/MODEL_COMPARISON.md`, raw JSON, and licensed fixture attribution.

`npm run test:media` runs actual CPU model inference on originals and 320-wide
versions and intentionally exits nonzero when known fixture misses occur. This
report is separate from deterministic unit-test success. Its measured CPU timing
is not a phone/WebGL benchmark. A real Android test with both dogs, daylight,
nighttime, reflections, and long powered operation is still required.

For a temporary production-CSP browser smoke test after building, run
`node scripts/build-browser-smoke.mjs` in `web/` and open the locally served
`/qa/model-smoke.html`. It uses the actual browser Canvas + model + dog-only gate
on six licensed photos; it never contacts a door endpoint. Rebuild normally before
any eventual deployment to remove the QA page. No deployment is included here.

Color + motion is an optional lightweight fallback. Calibrate each coat using a
7×7 median sample from the preview. It requires arrival motion, then permits a
stationary matching blob to retain presence. Large coherent matching regions can
still be clothing/furniture/reflections. Changing settings disarms auto mode.
Local preferences are stored per door only in the current browser. Activity logs
are memory-only. Screen Wake Lock is best effort; Android's powered stay-awake
setting may help, but cannot defeat browser suspension or guarantee continued
inference. Camera interruption, frozen frames, a hidden page, stop, or route exit
invalidate new opening observations and disarm ownership. Existing scheduled
closes are independent and retain the explicit semantics described above.
