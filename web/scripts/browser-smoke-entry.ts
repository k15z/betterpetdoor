import { loadDogModel } from "../src/camera/model";
import { evidenceFromDetections } from "../src/camera/engine";
const fixtures = [
  ["dog-standing-leaves.jpg", true],
  ["dog-sitting-indoor.jpg", true],
  ["dog-standing-tucker.jpg", true],
  ["dog-sitting-person.jpg", true],
  ["negative-brown-sofa.jpg", false],
  ["negative-orange-cat.jpg", false],
] as const;
const button = document.querySelector("button")!,
  output = document.querySelector("pre")!;
button.addEventListener("click", async () => {
  button.disabled = true;
  output.textContent = "Loading same-origin accurate model…";
  try {
    const model = await loadDogModel("accurate");
    const results = [];
    for (const [file, expectedDog] of fixtures) {
      const img = new Image();
      img.src = `/qa/media/${file}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = 320;
      c.height = Math.round((320 * img.height) / img.width);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      const start = performance.now();
      const predictions = await model.detect(c, 20, 0.15);
      const ms = performance.now() - start;
      const evidence = evidenceFromDetections(
        predictions.map((p) => ({
          label: p.class,
          score: p.score,
          box: {
            x: p.bbox[0] / c.width,
            y: p.bbox[1] / c.height,
            width: p.bbox[2] / c.width,
            height: p.bbox[3] / c.height,
          },
        })),
      );
      const detected =
        !!evidence.box && evidence.score >= 0.62 && evidence.area >= 0.025;
      results.push({
        file,
        expectedDog,
        detected,
        pass: detected === expectedDog,
        ms,
        score: evidence.score,
        predictions,
      });
      output.textContent = JSON.stringify({ running: true, results }, null, 2);
    }
    output.textContent = JSON.stringify(
      {
        complete: true,
        passed: results.filter((r) => r.pass).length,
        total: results.length,
        userAgent: navigator.userAgent,
        results,
      },
      null,
      2,
    );
  } catch (error) {
    output.textContent = `FAILED: ${error instanceof Error ? error.stack : error}`;
  }
  button.disabled = false;
});
