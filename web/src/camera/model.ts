import type { ObjectDetection } from "@tensorflow-models/coco-ssd";
export type ModelVariant = "accurate" | "lite";
const loaded = new Map<ModelVariant, ObjectDetection>();
const pending = new Map<ModelVariant, Promise<ObjectDetection>>();
/** Same-origin model assets only. Camera pixels never leave the browser. */
export async function loadDogModel(
  variant: ModelVariant = "accurate",
): Promise<ObjectDetection> {
  const existing = loaded.get(variant);
  if (existing) return existing;
  const inflight = pending.get(variant);
  if (inflight) return inflight;
  const task = (async () => {
    const tf = await import("@tensorflow/tfjs-core");
    await import("@tensorflow/tfjs-backend-cpu");
    await import("@tensorflow/tfjs-backend-webgl");
    try {
      if (!(await tf.setBackend("webgl"))) await tf.setBackend("cpu");
    } catch {
      await tf.setBackend("cpu");
    }
    await tf.ready();
    const coco = await import("@tensorflow-models/coco-ssd");
    const model = await coco.load({
      base: variant === "accurate" ? "mobilenet_v2" : "lite_mobilenet_v2",
      modelUrl:
        variant === "accurate"
          ? "/models/coco-ssd-v2/model.json"
          : "/models/coco-ssd/model.json",
    });
    loaded.set(variant, model);
    return model;
  })();
  pending.set(variant, task);
  try {
    return await task;
  } finally {
    pending.delete(variant);
  }
}
