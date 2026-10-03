/** Reproducible real-photo model smoke test. No camera, server API, or hardware. */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import jpeg from 'jpeg-js';
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu';
import * as coco from '@tensorflow-models/coco-ssd';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseArg = process.argv.find(arg => arg.startsWith('--base='));
const base = baseArg ? baseArg.slice('--base='.length) : 'lite_mobilenet_v2';
if (!['lite_mobilenet_v2', 'mobilenet_v2'].includes(base)) throw Error('Allowed bases: lite_mobilenet_v2, mobilenet_v2');
const isV2 = base === 'mobilenet_v2';
const modelDir = path.join(root, 'public/models', isV2 ? 'coco-ssd-v2' : 'coco-ssd');
const resultFilename = isV2 ? 'model-smoke-results-v2.json' : 'model-smoke-results.json';
const reportFilename = isV2 ? 'MODEL_SMOKE_REPORT_V2.md' : 'MODEL_SMOKE_REPORT.md';
const manifest = JSON.parse(await fs.readFile(path.join(modelDir, 'model.json'), 'utf8'));
const allowedModelFiles = new Set(['model.json', ...manifest.weightsManifest.flatMap(group => group.paths)]);
const fixtureDir = path.join(root, 'test-media');
const sources = JSON.parse(await fs.readFile(path.join(fixtureDir, 'sources.json'), 'utf8'));
const settings = { minScore: 0.62, minArea: 0.025, roi: { x: 0, y: 0, width: 1, height: 1 }, modelOutputMinScore: 0.15, maxNumBoxes: 20 };
// Import production evidence/reducer code without modifying project source files.
const engineBuild = await build({ entryPoints: [path.join(root, 'src/camera/engine/index.ts')], bundle: true, format: 'esm', platform: 'node', write: false });
const engine = await import(`data:text/javascript;base64,${Buffer.from(engineBuild.outputFiles[0].text).toString('base64')}`);
const server = http.createServer(async (req, res) => {
  const filename = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1);
  if (!allowedModelFiles.has(filename)) { res.writeHead(404); res.end(); return; }
  try { const bytes = await fs.readFile(path.join(modelDir, filename)); res.setHeader('Content-Type', filename.endsWith('.json') ? 'application/json' : 'application/octet-stream'); res.end(bytes); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const modelUrl = `http://127.0.0.1:${server.address().port}/model.json`;
let model;
const results = [];
try {
  await tf.setBackend('cpu'); await tf.ready();
  const beforeLoad = performance.now();
  model = await coco.load({ base, modelUrl });
  const modelLoadMs = performance.now() - beforeLoad;
  console.log(`Loaded real COCO-SSD ${base} model on Node CPU in ${modelLoadMs.toFixed(1)} ms`);
  for (const source of sources) {
    const bytes = await fs.readFile(path.join(fixtureDir, source.file));
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false });
    const original = tf.tensor3d(decoded.data, [decoded.height, decoded.width, 3], 'int32');
    for (const variant of ['original', 'width320']) {
      const width = variant === 'original' ? decoded.width : 320;
      const height = variant === 'original' ? decoded.height : Math.round(320 * decoded.height / decoded.width);
      const input = variant === 'original' ? original : tf.tidy(() => tf.cast(tf.round(tf.image.resizeBilinear(original, [height, width], false, true)), 'int32'));
      const start = performance.now();
      const predictions = await model.detect(input, settings.maxNumBoxes, settings.modelOutputMinScore);
      const inferenceMs = performance.now() - start;
      const adapted = predictions.map(p => ({ label: p.class, score: p.score, box: { x: p.bbox[0]/width, y: p.bbox[1]/height, width:p.bbox[2]/width, height:p.bbox[3]/height } }));
      const evidence = engine.evidenceFromDetections(adapted, settings.roi);
      const predictedDog = evidence.available && evidence.box !== null && evidence.score >= settings.minScore && evidence.area >= settings.minArea;
      const item = { file: source.file, variant, originalDimensions: [decoded.width,decoded.height], inputDimensions:[width,height], expectDog:source.expectDog, predictedDog, pass:predictedDog === source.expectDog, inferenceMs, dogScore:evidence.score, dogArea:evidence.area, normalizedDogBox:evidence.box, predictions: predictions.map(p => ({ class:p.class, score:p.score, bbox:p.bbox })), sourcePage:source.sourcePage, sha256:createHash('sha256').update(bytes).digest('hex') };
      results.push(item); console.log(JSON.stringify(item));
      if (variant !== 'original') input.dispose();
    }
    original.dispose();
  }
  const report = { generatedAt:new Date().toISOString(), runtime:process.version, platform:process.platform, architecture:process.arch, backend:tf.getBackend(), model:`COCO-SSD ${base}`, cocoSsdVersion:'2.2.3', tfjsVersion:'4.22.0', modelJsonSha256:createHash('sha256').update(await fs.readFile(path.join(modelDir,'model.json'))).digest('hex'), modelLoadMs, settings, preprocessing:{ original:'JPEG decoded to RGB int32 Tensor3D', width320:'TFJS bilinear resize to width 320 preserving aspect ratio, halfPixelCenters=true, rounded int32. Mirrors app dimensions but is not guaranteed bit-identical to browser Canvas drawImage.' }, limits:['Six hand-selected photographs; smoke test only, no statistically meaningful accuracy estimate.', 'CPU timings are Node/container measurements and do not estimate phone browser performance.', 'No live camera, dog door hardware, browser rendering, video, occlusion sequence, or night conditions tested.', 'Full-frame ROI; thresholds minScore .62 and minArea .025 use the production evidence adapter.'], summary:{cases:results.length, passed:results.filter(x=>x.pass).length, failed:results.filter(x=>!x.pass).length}, results };
  await fs.writeFile(path.join(fixtureDir,resultFilename),JSON.stringify(report,null,2)+'\n');
  const lines = [`# Real-photo COCO-SSD ${base} smoke test`,'',`Run: ${report.generatedAt}`,`Runtime: Node ${report.runtime}, ${report.platform}/${report.architecture}, TFJS CPU; COCO-SSD 2.2.3 / TFJS 4.22.0.`, '', `Result: ${report.summary.passed}/${report.summary.cases} cases passed; 6 photographs × 2 preprocessing sizes.`, '', 'Default gate: exact dog category, confidence ≥ 0.62, ROI area ≥ 0.025, full-frame ROI. Uses the actual installed model and production evidence adapter.', '', '| Photo | Input | Expected dog | Dog score | Dog ROI area | Gate | Result |', '|---|---:|---|---:|---:|---|---|'];
  for (const r of results) lines.push(`| ${r.file} | ${r.inputDimensions.join('×')} | ${r.expectDog?'yes':'no'} | ${r.normalizedDogBox ? r.dogScore.toFixed(4) : 'none ≥ 0.15'} | ${r.dogArea.toFixed(4)} | ${r.predictedDog?'dog':'no dog'} | ${r.pass?'PASS':'FAIL'} |`);
  lines.push('', `Pixel and normalized boxes, other model classes, source links, hashes, and raw measured scores are in ${resultFilename}. Attribution and original source licenses are in ATTRIBUTION.md and sources.json.`, '', '## Interpretation and limits', '', ...report.limits.map(x=>'- '+x), '- The 320-wide pass uses TFJS bilinear resizing with the app’s dimensions, not browser Canvas; browser pixel-level equivalence is unverified.', '- A zero dogScore in the raw JSON is the production adapter’s empty-evidence value, not a measured zero dog-class probability. No emitted dog prediction survived the model’s 0.15 output cutoff/NMS.', '', '## Observed misses', '', ...results.filter(r => !r.pass).map(r => `- ${r.file} (${r.variant}): expected dog=${r.expectDog}, emitted ${r.predictions.map(p => `${p.class} ${p.score.toFixed(4)}`).join(', ') || 'nothing'}.`), '', results.some(r => !r.pass) ? 'Inspect raw classes and scores for failures. Lowering the confidence gate cannot recover cases with no emitted dog prediction. Do not broaden the accepted class list to other animals. Collect camera-angle/lighting samples before any real-world use.' : 'No misses in this small unchanged fixture set. This does not establish real-world accuracy or safety.', '', '## Reproduction', '', `Run npm install, ensure ${path.relative(root,modelDir)} contains model.json and every referenced weight shard, then node scripts/media-smoke.mjs --base=${base}. The script starts and closes its own loopback-only HTTP server for local model loading. No public deployment or inference service is used.`, '');
  await fs.writeFile(path.join(fixtureDir,reportFilename),lines.join('\n'));
  console.log('SUMMARY',JSON.stringify(report.summary));
  process.exitCode = report.summary.failed ? 1 : 0;
} finally { model?.dispose(); await new Promise(resolve=>server.close(resolve)); }
