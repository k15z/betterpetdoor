import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPresenceState,
  updatePresence,
  extractColorEvidence,
  evidenceFromDetections,
  unavailableEvidence,
  DEFAULT_COAT_PROFILES,
  DEFAULT_PRESENCE_CONFIG,
} from "./engine";
import type {
  Box,
  CoatProfile,
  Evidence,
  PresenceConfig,
  PresenceState,
  ObjectDetection,
  Frame,
} from "./engine";
import { loadDogModel } from "./model";
export type DetectorMode = "object" | "color";
export type CameraState =
  | "stopped"
  | "starting"
  | "live"
  | "demo"
  | "paused"
  | "error";
export type Zone = { id: string; name: string; enabled: boolean; box: Box };
export const INITIAL_ZONES: Zone[] = [
  {
    id: "inside",
    name: "Inside approach",
    enabled: true,
    box: { x: 0.06, y: 0.15, width: 0.41, height: 0.72 },
  },
  {
    id: "outside",
    name: "Outside approach",
    enabled: true,
    box: { x: 0.53, y: 0.15, width: 0.41, height: 0.72 },
  },
];
export const INITIAL_CONFIG = { ...DEFAULT_PRESENCE_CONFIG, staleMs: 6000 };
export type MonitorSettings = {
  mode: DetectorMode;
  modelVariant: "accurate" | "lite";
  zones: Zone[];
  profiles: CoatProfile[];
  config: PresenceConfig;
  facing: "environment" | "user";
};
export const INITIAL_SETTINGS: MonitorSettings = {
  mode: "object",
  modelVariant: "accurate",
  zones: INITIAL_ZONES,
  profiles: DEFAULT_COAT_PROFILES,
  config: INITIAL_CONFIG,
  facing: "environment",
};
export function selectZoneEvidence(
  evidence: Evidence[],
  config: PresenceConfig,
): Evidence {
  const positive = evidence
    .filter(
      (e) =>
        e.available &&
        e.box &&
        e.score >= config.minScore &&
        e.area >= config.minArea,
    )
    .sort((a, b) => b.score - a.score)[0];
  if (positive) return positive;
  return (
    evidence.find((e) => !e.available) ??
    [...evidence].sort((a, b) => b.score * b.area - a.score * a.area)[0] ??
    unavailableEvidence("object", "Enable at least one approach zone.")
  );
}

export type ZoneObservation = { id: string; evidence: Evidence };
export type ZonePresenceStates = Record<string, PresenceState>;

/** Frame health is evaluated per enabled zone, including in object mode. */
export function extractZoneObservations(
  frame: Frame,
  previousFrame: Frame | null,
  settings: MonitorSettings,
  predictions: readonly ObjectDetection[] = [],
): ZoneObservation[] {
  return settings.zones.filter((zone) => zone.enabled).map((zone) => {
    const color = extractColorEvidence(frame, previousFrame, {
      roi: zone.box,
      profiles: settings.profiles,
      maxWidth: settings.mode === "object" ? 80 : 160,
    });
    const evidence = settings.mode === "color" ? color
      : color.available ? evidenceFromDetections(predictions, zone.box, 0.35, settings.config)
      : unavailableEvidence("object", `${zone.name}: view is dark or unavailable.`);
    return { id: zone.id, evidence };
  });
}

/**
 * Every zone owns its own arrival/motion/absence history. A motion latch can
 * never jump to a stationary object in a different zone. Absence is established
 * only when every enabled zone has independently confirmed clear observations.
 */
export function updateZonePresence(
  previous: ZonePresenceStates,
  observations: readonly ZoneObservation[],
  nowMs: number,
  config: PresenceConfig,
): { states: ZonePresenceStates; presence: PresenceState; evidence: Evidence } {
  const states: ZonePresenceStates = {};
  const entries = observations.map(({ id, evidence }) => {
    const presence = updatePresence(previous[id] ?? createPresenceState(), evidence, nowMs, config);
    states[id] = presence;
    return { id, evidence, presence };
  });
  const strongest = (items: typeof entries) => [...items].sort((a, b) =>
    b.evidence.score - a.evidence.score || b.presence.progress - a.presence.progress,
  )[0];
  const current = strongest(entries.filter(({ presence }) =>
    presence.status === "present" && presence.phase === "present",
  ));
  if (current) return { states, presence: current.presence, evidence: current.evidence };
  const arriving = strongest(entries.filter(({ presence }) => presence.phase === "arriving"));
  if (arriving) {
    return {
      states,
      presence: {
        ...arriving.presence,
        status: entries.some(({ presence }) => presence.status === "present") ? "present" : "unknown",
      },
      evidence: arriving.evidence,
    };
  }
  const uncertain = entries.find(({ presence, evidence }) =>
    !evidence.available || presence.phase === "unknown" || presence.status === "unknown",
  );
  if (uncertain || !entries.length) {
    const evidence = uncertain?.evidence ?? unavailableEvidence("object", "Enable at least one approach zone.");
    return {
      states,
      presence: {
        ...createPresenceState(), lastAt: nowMs,
        reason: uncertain?.presence.reason ?? evidence.reason ?? "Approach-zone presence is unknown",
      },
      evidence,
    };
  }
  const leaving = entries.filter(({ presence }) => presence.phase === "leaving")
    .sort((a, b) => a.presence.progress - b.presence.progress)[0];
  const selected = leaving ?? entries[0];
  return { states, presence: selected.presence, evidence: selected.evidence };
}

export function useCameraMonitor(
  settings: MonitorSettings,
  onPause: () => void,
) {
  const [state, setState] = useState<CameraState>("stopped"),
    [message, setMessage] = useState(
      "Start in preview mode. No commands are sent until you explicitly arm this camera.",
    );
  const [presence, setPresence] = useState(createPresenceState),
    [evidence, setEvidence] = useState<Evidence>(
      unavailableEvidence("object", "Camera stopped"),
    );
  const [latency, setLatency] = useState(0),
    [aspect, setAspect] = useState(4 / 3),
    [modelState, setModelState] = useState<
      "idle" | "loading" | "ready" | "error"
    >("idle");
  const [demoTarget, setDemoTarget] = useState<"yellow" | "brown" | "empty">(
    "yellow",
  );
  const videoRef = useRef<HTMLVideoElement>(null),
    demoCanvasRef = useRef<HTMLCanvasElement>(null),
    canvasRef = useRef<HTMLCanvasElement | null>(null);
  const settingsRef = useRef(settings),
    onPauseRef = useRef(onPause),
    demoRef = useRef(demoTarget),
    presenceRef = useRef(presence),
    zonePresenceRef = useRef<ZonePresenceStates>({}),
    observationVersion = useRef(0),
    streamRef = useRef<MediaStream | null>(null);
  const stateRef = useRef<CameraState>("stopped"),
    generation = useRef(0),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    previousFrame = useRef<ImageData | null>(null);
  const lastFrameAt = useRef(0),
    videoTime = useRef(-1),
    model = useRef<Awaited<ReturnType<typeof loadDogModel>> | null>(null),
    demoStart = useRef(0);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    onPauseRef.current = onPause;
  }, [onPause]);
  useEffect(() => {
    demoRef.current = demoTarget;
    demoStart.current = performance.now();
  }, [demoTarget]);
  const changeState = useCallback((value: CameraState) => {
    stateRef.current = value;
    setState(value);
  }, []);
  const observe = useCallback((value: Evidence) => {
    if (!value.available) zonePresenceRef.current = {};
    const next = updatePresence(
      presenceRef.current,
      value,
      performance.now(),
      settingsRef.current.config,
    );
    presenceRef.current = next;
    setPresence(next);
    setEvidence(value);
  }, []);
  const release = useCallback(() => {
    generation.current++;
    observationVersion.current++;
    zonePresenceRef.current = {};
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.onmute = null;
      t.stop();
    });
    if (videoRef.current) videoRef.current.srcObject = null;
    previousFrame.current = null;
    videoTime.current = -1;
  }, []);
  const stop = useCallback(
    (
      reason = "Camera stopped. Auto mode is disarmed.",
      next: CameraState = "stopped",
    ) => {
      release();
      changeState(next);
      setMessage(reason);
      observe(unavailableEvidence(settingsRef.current.mode, reason));
      onPauseRef.current();
    },
    [changeState, observe, release],
  );
  const reset = useCallback(() => {
    observationVersion.current++;
    zonePresenceRef.current = {};
    previousFrame.current = null;
    observe(
      unavailableEvidence(
        settingsRef.current.mode,
        "Settings changed. Confirming presence again.",
      ),
    );
    onPauseRef.current();
  }, [observe]);
  useEffect(() => {
    const hidden = () => {
      if (
        document.hidden &&
        ["live", "demo", "starting"].includes(stateRef.current)
      )
        stop(
          "Page backgrounded. Resume explicitly. Auto mode is disarmed.",
          "paused",
        );
    };
    const pagehide = () =>
      stop("Page closed. Auto mode is disarmed.", "paused");
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", pagehide);
    const watchdog = setInterval(() => {
      if (
        stateRef.current === "live" &&
        performance.now() - lastFrameAt.current >
          settingsRef.current.config.staleMs
      )
        stop(
          "No fresh camera frames. Detection stopped and auto mode disarmed.",
          "error",
        );
    }, 1000);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", pagehide);
      clearInterval(watchdog);
      release();
      onPauseRef.current();
    };
  }, [release, stop]);
  const start = useCallback(
    async (demo = false) => {
      release();
      onPauseRef.current();
      observe(unavailableEvidence(settingsRef.current.mode, "Starting camera"));
      const token = generation.current;
      const run = async () => {
        if (token !== generation.current || document.hidden) return;
        const began = performance.now(),
          prefs = settingsRef.current,
          observationToken = observationVersion.current;
        try {
          let frame: ImageData,
            predictions: ObjectDetection[] | null = null;
          if (demo) {
            const canvas = demoCanvasRef.current;
            if (!canvas) {
              timer.current = setTimeout(() => void run(), 100);
              return;
            }
            canvas.width = 640;
            canvas.height = 480;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = "#17221e";
            ctx.fillRect(0, 0, 640, 480);
            ctx.strokeStyle = "#34443c";
            ctx.lineWidth = 1;
            for (let x = 0; x < 640; x += 40) {
              ctx.beginPath();
              ctx.moveTo(x, 0);
              ctx.lineTo(x, 480);
              ctx.stroke();
            }
            for (let y = 0; y < 480; y += 40) {
              ctx.beginPath();
              ctx.moveTo(0, y);
              ctx.lineTo(640, y);
              ctx.stroke();
            }
            const seconds = (began - demoStart.current) / 1000,
              box = {
                x: seconds < 2 ? 0.05 + seconds * 0.04 : 0.13,
                y: 0.32,
                width: 0.26,
                height: 0.44,
              };
            if (demoRef.current !== "empty") {
              ctx.fillStyle =
                demoRef.current === "yellow" ? "#d6ad62" : "#986238";
              ctx.fillRect(
                box.x * 640,
                box.y * 480,
                box.width * 640,
                box.height * 480,
              );
              ctx.fillStyle = "#17221e";
              ctx.font = "bold 16px system-ui";
              ctx.fillText("TEST TARGET", box.x * 640 + 13, box.y * 480 + 32);
              ctx.font = "13px system-ui";
              ctx.fillText(
                seconds < 2 ? "Moving" : "Stationary",
                box.x * 640 + 13,
                box.y * 480 + 55,
              );
            }
            frame = ctx.getImageData(0, 0, 640, 480);
            predictions =
              demoRef.current === "empty"
                ? []
                : [{ label: "dog", score: 0.93, box }];
          } else {
            const video = videoRef.current;
            if (
              !video ||
              video.readyState < 2 ||
              !video.videoWidth ||
              video.currentTime === videoTime.current
            ) {
              timer.current = setTimeout(() => void run(), 150);
              return;
            }
            videoTime.current = video.currentTime;
            const canvas =
              canvasRef.current ??
              (canvasRef.current = document.createElement("canvas"));
            canvas.width = 320;
            canvas.height = Math.round(
              (320 * video.videoHeight) / video.videoWidth,
            );
            const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
            if (prefs.mode === "object") {
              const healthy = extractColorEvidence(frame, null, {
                roi: { x: 0, y: 0, width: 1, height: 1 },
                profiles: prefs.profiles,
                maxWidth: 80,
              });
              if (!healthy.available) {
                observe(
                  unavailableEvidence(
                    "object",
                    "Camera view is dark or covered.",
                  ),
                );
                lastFrameAt.current = performance.now();
                timer.current = setTimeout(() => void run(), 350);
                return;
              }
              if (!model.current) throw Error("Dog model is not ready");
              predictions = (await model.current.detect(canvas, 20, 0.15)).map(
                (p) => ({
                  label: p.class,
                  score: p.score,
                  box: {
                    x: p.bbox[0] / canvas.width,
                    y: p.bbox[1] / canvas.height,
                    width: p.bbox[2] / canvas.width,
                    height: p.bbox[3] / canvas.height,
                  },
                }),
              );
            }
          }
          if (token !== generation.current || document.hidden) return;
          if (observationToken !== observationVersion.current) {
            timer.current = setTimeout(() => void run(), 0);
            return;
          }
          const values = extractZoneObservations(frame, previousFrame.current, prefs, predictions ?? []);
          previousFrame.current = frame;
          lastFrameAt.current = performance.now();
          setLatency(Math.round(lastFrameAt.current - began));
          const combined = updateZonePresence(zonePresenceRef.current, values, lastFrameAt.current, prefs.config);
          zonePresenceRef.current = combined.states;
          presenceRef.current = combined.presence;
          setPresence(combined.presence);
          setEvidence(combined.evidence);
        } catch (error) {
          if (token === generation.current)
            stop(
              `Detection failed: ${error instanceof Error ? error.message : "unknown error"}. Auto mode disarmed.`,
              "error",
            );
          return;
        }
        if (token === generation.current)
          timer.current = setTimeout(
            () => void run(),
            Math.max(100, 350 - (performance.now() - began)),
          );
      };
      if (demo) {
        changeState("demo");
        setAspect(4 / 3);
        demoStart.current = performance.now();
        setMessage(
          "Synthetic demo. No physical door commands or model accuracy claims.",
        );
        void run();
        return;
      }
      changeState("starting");
      setMessage("Allow camera access in your browser.");
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
          throw Error("Camera access requires HTTPS or localhost.");
        const media = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: settingsRef.current.facing },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 15, max: 20 },
          },
        });
        if (token !== generation.current) {
          media.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = media;
        const track = media.getVideoTracks()[0];
        track.onended = () =>
          stop("Camera disconnected. Auto mode disarmed.", "error");
        track.onmute = () =>
          stop("Camera stream interrupted. Auto mode disarmed.", "error");
        const video = videoRef.current!;
        video.srcObject = media;
        await video.play();
        if (token !== generation.current) return;
        setAspect(video.videoWidth / video.videoHeight || 4 / 3);
        if (settingsRef.current.mode === "object") {
          setModelState("loading");
          setMessage(
            "Loading same-origin dog model. Frames stay on this phone.",
          );
          try {
            const loaded = await loadDogModel(settingsRef.current.modelVariant);
            if (token !== generation.current) return;
            model.current = loaded;
            setModelState("ready");
          } catch {
            if (token !== generation.current) return;
            setModelState("error");
            throw Error(
              "Local model unavailable. Run npm run model:download during setup, or use Color + motion.",
            );
          }
        }
        if (token !== generation.current) return;
        const actual = track.getSettings().facingMode;
        changeState("live");
        lastFrameAt.current = performance.now();
        setMessage(
          actual && actual !== settingsRef.current.facing
            ? "Requested camera unavailable; browser chose another. Check the view and zones before arming."
            : "Preview active. Check both zones, then arm this camera to enable opening.",
        );
        void run();
      } catch (error) {
        if (token === generation.current) {
          const e = error as Error;
          stop(
            e.name === "NotAllowedError"
              ? "Camera permission denied. Allow access in your browser, then try again."
              : e.message,
            "error",
          );
        }
      }
    },
    [changeState, observe, release, stop],
  );
  const getFrame = useCallback(() => {
    const c =
      stateRef.current === "demo" ? demoCanvasRef.current : canvasRef.current;
    return c?.width
      ? (c
          .getContext("2d", { willReadFrequently: true })
          ?.getImageData(0, 0, c.width, c.height) ?? null)
      : null;
  }, []);
  const fresh = state === "live" && evidence.available;
  const attachVideo = useCallback((node: HTMLVideoElement | null) => { videoRef.current = node }, []);
  const attachDemoCanvas = useCallback((node: HTMLCanvasElement | null) => { demoCanvasRef.current = node }, []);
  return {
    state,
    message,
    presence,
    evidence,
    latency,
    aspect,
    modelState,
    demoTarget,
    setDemoTarget,
    attachVideo,
    attachDemoCanvas,
    start,
    stop,
    reset,
    getFrame,
    fresh,
  };
}
