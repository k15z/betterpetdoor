// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { CameraSession, Door } from "../api";
import type { useCameraMonitor } from "./useCameraMonitor";
import { createPresenceState, unavailableEvidence } from "./engine";
import CameraMonitor from "./CameraMonitor";

const fakes = vi.hoisted(() => ({
  api: { status: vi.fn(), command: vi.fn() },
  cameraApi: {
    state: vi.fn(),
    arm: vi.fn(),
    disarm: vi.fn(),
    heartbeat: vi.fn(),
    detection: vi.fn(),
    cancelClose: vi.fn(),
  },
  monitor: null as unknown as ReturnType<typeof useCameraMonitor>,
  onPause: null as null | (() => void),
  server: null as unknown as CameraSession,
}));

vi.mock("../api", () => ({ api: fakes.api, cameraApi: fakes.cameraApi }));
vi.mock("./useCameraMonitor", async (original) => {
  const actual = await original<typeof import("./useCameraMonitor")>();
  return {
    ...actual,
    useCameraMonitor: (_settings: unknown, onPause: () => void) => {
      fakes.onPause = onPause;
      return fakes.monitor;
    },
  };
});

const door: Door = {
  id: "test-door",
  name: "Patio",
  provider: "fake",
  created_at: "2026-01-01T00:00:00Z",
};
const baseSession = (): CameraSession => ({
  door_id: door.id,
  armed: false,
  session_id: "",
  lease_expires_at: null,
  auto_close_seconds: 300,
  close_due_at: null,
  status: "disarmed",
  message: "",
  updated_at: "2026-01-01T00:00:00Z",
  cooldown_until: null,
});
const armedSession = (owner: string): CameraSession => ({
  ...baseSession(),
  armed: true,
  session_id: owner,
  status: "armed",
  updated_at: new Date(Date.now()).toISOString(),
  lease_expires_at: new Date(Date.now() + 45_000).toISOString(),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function page(testOnly = false) {
  return (
    <MantineProvider env="test">
      <CameraMonitor door={door} onBack={vi.fn()} testOnly={testOnly} />
    </MantineProvider>
  );
}

async function submitArm() {
  fireEvent.click(screen.getByRole("button", { name: "Arm selected door" }));
  await screen.findByRole("dialog");
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I checked the camera zones/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Arm Patio" }));
  await waitFor(() => expect(fakes.cameraApi.arm).toHaveBeenCalled());
  return fakes.cameraApi.arm.mock.calls.at(-1)![1] as string;
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.reject(new Error("Real network is forbidden in lifecycle tests")),
    ),
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        /* No layout in jsdom. */
      }
      unobserve() {
        /* No layout in jsdom. */
      }
      disconnect() {
        /* No layout in jsdom. */
      }
    },
  );
  fakes.server = baseSession();
  fakes.api.status.mockResolvedValue({
    state: "closed",
    online: true,
    open: false,
    moving: false,
    safe_to_close: true,
    checked_at: new Date().toISOString(),
  });
  fakes.api.command.mockResolvedValue({ ok: true });
  fakes.cameraApi.state.mockImplementation(async () => fakes.server);
  fakes.cameraApi.arm.mockImplementation(
    async (_door: string, owner: string) => {
      fakes.server = armedSession(owner);
      return fakes.server;
    },
  );
  fakes.cameraApi.disarm.mockImplementation(async () => {
    fakes.server = { ...fakes.server, armed: false, status: "disarmed" };
    return fakes.server;
  });
  fakes.cameraApi.heartbeat.mockImplementation(async () => fakes.server);
  fakes.cameraApi.detection.mockImplementation(async () => fakes.server);
  fakes.cameraApi.cancelClose.mockImplementation(async () => fakes.server);
  fakes.monitor = {
    state: "live",
    message: "Fake camera, no hardware",
    fresh: true,
    presence: {
      ...createPresenceState(),
      status: "present",
      phase: "present",
      progress: 1,
    },
    evidence: {
      available: true,
      source: "object",
      score: 0.9,
      area: 0.2,
      motion: 0,
      box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    },
    latency: 1,
    aspect: 4 / 3,
    modelState: "ready",
    demoTarget: "yellow",
    setDemoTarget: vi.fn(),
    attachVideo: vi.fn(),
    attachDemoCanvas: vi.fn(),
    start: vi.fn(),
    reset: vi.fn(),
    getFrame: vi.fn(() => null),
    stop: vi.fn(() => {
      fakes.monitor = {
        ...fakes.monitor,
        state: "stopped",
        fresh: false,
        presence: createPresenceState(),
        evidence: unavailableEvidence("object"),
      };
      fakes.onPause?.();
    }),
  };
});

afterEach(() => {
  cleanup();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("CameraMonitor real React lifecycle with fake services", () => {
  it.each(["cancel", "stop"] as const)(
    "disarms a late arm response after pending-arm %s",
    async (action) => {
      const pending = deferred<CameraSession>();
      fakes.cameraApi.arm.mockReturnValueOnce(pending.promise);
      render(page());
      const owner = await submitArm();
      if (action === "cancel") {
        fireEvent.keyDown(screen.getByRole("dialog"), {
          key: "Escape",
          code: "Escape",
        });
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Stop camera" }));
      }
      await act(async () => {
        pending.resolve(armedSession(owner));
        await pending.promise;
      });
      await waitFor(() =>
        expect(fakes.cameraApi.disarm).toHaveBeenCalledWith(door.id, owner),
      );
      expect(fakes.cameraApi.detection).not.toHaveBeenCalled();
      expect(screen.queryByText("AUTO ARMED")).toBeNull();
    },
  );

  it("ignores an older arm response after a fresh explicit arm session", async () => {
    const first = deferred<CameraSession>(),
      second = deferred<CameraSession>();
    fakes.cameraApi.arm
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(page());
    const firstOwner = await submitArm();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const secondOwner = await submitArm();
    expect(secondOwner).not.toBe(firstOwner);
    await act(async () => {
      first.resolve(armedSession(firstOwner));
      await first.promise;
    });
    expect(fakes.cameraApi.disarm).toHaveBeenCalledWith(door.id, firstOwner);
    expect(fakes.cameraApi.detection).not.toHaveBeenCalled();
    fakes.server = armedSession(secondOwner);
    await act(async () => {
      second.resolve(fakes.server);
      await second.promise;
    });
    await waitFor(() =>
      expect(fakes.cameraApi.detection).toHaveBeenCalledTimes(1),
    );
    expect(fakes.cameraApi.detection.mock.calls[0][1]).toBe(secondOwner);
    expect(
      fakes.cameraApi.arm.mock.calls.every((call) => call[2] === 300),
    ).toBe(true);
  });

  it("keeps a present demo and test-only manual controls away from all live command APIs", async () => {
    fakes.monitor = { ...fakes.monitor, state: "demo", fresh: false };
    render(page(true));
    const arm = screen.getByRole("button", {
      name: "Arm selected door",
    }) as HTMLButtonElement;
    expect(arm.disabled).toBe(true);
    fireEvent.click(arm);
    fireEvent.click(screen.getByRole("button", { name: "Mock open" }));
    await screen.findByText("MOCK OPEN");
    fireEvent.click(screen.getByRole("button", { name: "Mock close" }));
    await screen.findByText("MOCK CLOSED");
    expect(fakes.cameraApi.arm).not.toHaveBeenCalled();
    expect(fakes.cameraApi.detection).not.toHaveBeenCalled();
    expect(fakes.api.command).not.toHaveBeenCalled();
    expect(fakes.cameraApi.state).not.toHaveBeenCalled();
  });

  it("does not send departure-grace presence, then sends only once for a fresh present visit", async () => {
    fakes.monitor = {
      ...fakes.monitor,
      presence: { ...fakes.monitor.presence, phase: "leaving" },
    };
    const view = render(page());
    await submitArm();
    await screen.findByText("AUTO ARMED");
    expect(fakes.cameraApi.detection).not.toHaveBeenCalled();
    fakes.monitor = {
      ...fakes.monitor,
      presence: { ...fakes.monitor.presence, phase: "present" },
    };
    view.rerender(page());
    await waitFor(() =>
      expect(fakes.cameraApi.detection).toHaveBeenCalledTimes(1),
    );
    fakes.monitor = {
      ...fakes.monitor,
      evidence: { ...fakes.monitor.evidence },
    };
    view.rerender(page());
    await act(async () => {
      await Promise.resolve();
    });
    expect(fakes.cameraApi.detection).toHaveBeenCalledTimes(1);
  });

  it("blocks arming a foreign session and suppresses repeated manual clicks while pending", async () => {
    fakes.server = armedSession("different-camera-owner");
    const pending = deferred<{ ok: true }>();
    fakes.api.command.mockReturnValueOnce(pending.promise);
    render(page());
    await screen.findByText("OTHER CAMERA ARMED");
    expect(
      (
        screen.getByRole("button", {
          name: "Arm selected door",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(fakes.cameraApi.arm).not.toHaveBeenCalled();
    const open = screen.getByRole("button", {
      name: "Open door",
    }) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    fireEvent.click(open);
    expect(fakes.api.command).toHaveBeenCalledTimes(1);
    expect(fakes.api.command).toHaveBeenCalledWith(door.id, "open");
    await act(async () => {
      pending.resolve({ ok: true });
      await pending.promise;
    });
    expect(fakes.cameraApi.detection).not.toHaveBeenCalled();
  });
});
