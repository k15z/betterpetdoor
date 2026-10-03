import { expect, it } from "vitest";
import {
  createMockDoorState,
  createPresenceState,
  extractColorEvidence,
  updateMockDoor,
  updatePresence,
} from "./index";
import type { Frame } from "./index";

function image(dog: boolean, black = false): Frame {
  const width = 40,
    height = 40;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const rgb = black
        ? [0, 0, 0]
        : dog && x >= 10 && x < 25 && y >= 10 && y < 25
          ? [180, 110, 40]
          : [50, 90, 150];
      data.set([...rgb, 255], (y * width + x) * 4);
    }
  return { width, height, data };
}

it("opens for a moving arrival, holds a stationary dog and black camera, then closes only after clear recovery", () => {
  let presence = createPresenceState();
  let door = createMockDoorState();
  let previous = image(false);
  const step = (current: Frame, at: number) => {
    presence = updatePresence(
      presence,
      extractColorEvidence(current, previous),
      at,
    );
    door = updateMockDoor(door, presence);
    previous = current;
  };
  step(image(true), 0);
  expect(door.position).toBe("closed");
  for (const at of [400, 800, 1200, 2200, 3200]) step(image(true), at);
  expect(presence.status).toBe("present");
  expect(door.position).toBe("open");
  for (const at of [4200, 5200, 6200, 7200, 8200, 9200, 10200])
    step(image(false, true), at);
  expect(presence.status).toBe("unknown");
  expect(door.position).toBe("open");
  for (const at of [11200, 12200, 13200, 14200, 15200]) step(image(false), at);
  expect(door.position).toBe("open");
  step(image(false), 16200);
  expect(presence.status).toBe("absent");
  expect(door).toEqual({
    position: "closed",
    lastCommand: "mock-close",
    commandCount: 2,
  });
});
