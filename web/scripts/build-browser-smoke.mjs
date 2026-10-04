// Adds a temporary, strictly no-hardware QA page to an existing production build.
// npm run build removes it; never deploy a build with this harness.
import { build } from "esbuild";
import { mkdir, writeFile, cp } from "node:fs/promises";
await mkdir("dist/qa", { recursive: true });
await build({
  entryPoints: ["scripts/browser-smoke-entry.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: "dist/qa/model-smoke.js",
  minify: true,
});
await cp("test-media", "dist/qa/media", { recursive: true });
await writeFile(
  "dist/qa/model-smoke.html",
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Local dog model smoke test</title></head><body><h1>Local dog model smoke test</h1><p>Production browser pipeline, same-origin assets. No door API or hardware.</p><button>Run six real photos</button><pre aria-live="polite">Ready</pre><script type="module" src="/qa/model-smoke.js"></script></body></html>',
);
console.log(
  "Temporary QA page ready at /qa/model-smoke.html. Do not deploy this build.",
);
