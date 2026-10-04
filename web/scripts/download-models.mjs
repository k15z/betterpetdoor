import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const manifest = JSON.parse(
  await readFile(new URL("./model-assets.json", import.meta.url), "utf8"),
);
const requested = process.argv[2] || "all";
if (!["all", "accurate", "lite"].includes(requested))
  throw Error("Usage: npm run model:download -- [all|accurate|lite]");
for (const model of manifest.models.filter(
  (m) => requested === "all" || m.id === requested,
)) {
  const target = fileURLToPath(
    new URL(`../public/models/${model.directory}`, import.meta.url),
  );
  const temp = `${target}.download`;
  await mkdir(temp, { recursive: true });
  try {
    for (const asset of model.files) {
      const url = new URL(asset.path, model.source);
      console.log(`${model.id}: ${asset.path}`);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok)
        throw Error(`Model download failed: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (
        bytes.byteLength !== asset.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== asset.sha256
      )
        throw Error(`Model integrity check failed: ${asset.path}`);
      await writeFile(path.join(temp, asset.path), bytes);
    }
    // Fully validate before replacing any existing model.
    await rm(target, { recursive: true, force: true });
    await rename(temp, target);
    console.log(
      `${model.id} model ready. Same-origin inference needs no external service.`,
    );
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}
