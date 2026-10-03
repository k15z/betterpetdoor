import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Container,
  Group,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Slider,
  Stack,
  Switch,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconCamera,
  IconCameraOff,
  IconDoorEnter,
  IconDoorExit,
  IconPlayerPlay,
  IconShieldCheck,
  IconTarget,
  IconRefresh,
  IconAlertTriangle,
} from "@tabler/icons-react";
import {
  api,
  cameraApi,
  type CameraSession,
  type Door,
  type DoorStatus,
} from "../api";
import {
  useCameraMonitor,
  INITIAL_SETTINGS,
  INITIAL_CONFIG,
  INITIAL_ZONES,
  type MonitorSettings,
} from "./useCameraMonitor";
import { DEFAULT_COAT_PROFILES, sampleCoatProfile } from "./engine";
import type { PresenceConfig } from "./engine";
import "./camera.css";

function loadSettings(doorId: string): MonitorSettings {
  try {
    const raw = JSON.parse(
      localStorage.getItem(`pet-door-camera:${doorId}`) || "null",
    );
    if (!raw || raw.version !== 1) return INITIAL_SETTINGS;
    const data = raw.settings as MonitorSettings;
    if (
      !["object", "color"].includes(data.mode) ||
      !["environment", "user"].includes(data.facing)
    )
      return INITIAL_SETTINGS;
    if (
      data.zones?.length !== 2 ||
      !data.zones.every(
        (z) =>
          typeof z.enabled === "boolean" &&
          z.box &&
          [z.box.x, z.box.y, z.box.width, z.box.height].every(
            Number.isFinite,
          ) &&
          z.box.x >= 0 &&
          z.box.y >= 0 &&
          z.box.width >= 0.1 &&
          z.box.height >= 0.1 &&
          z.box.x + z.box.width <= 1.001 &&
          z.box.y + z.box.height <= 1.001,
      )
    )
      return INITIAL_SETTINGS;
    if (
      data.profiles?.length !== 2 ||
      !data.profiles.every((p) =>
        [
          p.hue,
          p.hueTolerance,
          p.saturationMin,
          p.saturationMax,
          p.valueMin,
          p.valueMax,
        ].every(Number.isFinite),
      )
    )
      return INITIAL_SETTINGS;
    const config = { ...INITIAL_CONFIG, ...data.config, staleMs: 6000 };
    if (
      Object.values(config).some(
        (v) => typeof v !== "number" || !Number.isFinite(v) || v < 0,
      )
    )
      return INITIAL_SETTINGS;
    return {
      ...data,
      modelVariant: data.modelVariant === "lite" ? "lite" : "accurate",
      config,
    };
  } catch {
    return INITIAL_SETTINGS;
  }
}

type Activity = { id: number; time: string; message: string };
export default function CameraMonitor({
  door,
  onBack,
  testOnly = false,
}: {
  door: Door;
  onBack: () => void;
  testOnly?: boolean;
}) {
  const [settings, setSettings] = useState<MonitorSettings>(() =>
    loadSettings(door.id),
  );
  const [session, setSession] = useState<CameraSession | null>(null),
    [doorStatus, setDoorStatus] = useState<DoorStatus | null>(null);
  const [error, setError] = useState(""),
    [working, setWorking] = useState<string | null>(null),
    [armModal, setArmModal] = useState(false),
    [ack, setAck] = useState(false);
  const [delay, setDelay] = useState<number>(5),
    [zoneIndex, setZoneIndex] = useState(0),
    [sampleId, setSampleId] = useState<string | null>(null);
  const [events, setEvents] = useState<Activity[]>([]),
    [wake, setWake] = useState(false),
    [simulatedOpen, setSimulatedOpen] = useState(false);
  const [ownerId, setOwnerId] = useState("");
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const owner = useRef(""),
    sessionRef = useRef<CameraSession | null>(null),
    sentVisit = useRef(false),
    eventId = useRef<string | null>(null),
    eventCounter = useRef(0),
    wakeLock = useRef<WakeLockSentinel | null>(null);
  const mounted = useRef(true);
  const requestEpoch = useRef(0);
  const wakePending = useRef(false);
  const log = useCallback((message: string) => {
    setEvents((prev) =>
      [
        {
          id: ++eventCounter.current,
          time: new Date().toLocaleTimeString(),
          message,
        },
        ...prev,
      ].slice(0, 100),
    );
  }, []);
  const saveSession = useCallback((value: CameraSession) => {
    if (
      sessionRef.current &&
      Date.parse(value.updated_at) < Date.parse(sessionRef.current.updated_at)
    )
      return;
    sessionRef.current = value;
    if (mounted.current) setSession(value);
  }, []);
  const disarm = useCallback(() => {
    const epoch = ++requestEpoch.current;
    if (mounted.current) setArmModal(false);
    const current = sessionRef.current;
    const requestedOwner = owner.current;
    owner.current = "";
    if (mounted.current) {
      setOwnerId("");
      setWorking((previous) => (previous === "arm" ? null : previous));
    }
    if (current?.armed && current.session_id === requestedOwner && !testOnly) {
      sessionRef.current = { ...current, armed: false };
      if (mounted.current) setSession(sessionRef.current);
      void cameraApi
        .disarm(door.id, requestedOwner)
        .then((value) => {
          if (requestEpoch.current === epoch) saveSession(value);
        })
        .catch(() => {
          if (mounted.current && epoch === requestEpoch.current)
            setError(
              "Could not confirm disarming. The server lease expires after 45 seconds without a heartbeat. Existing delayed close remains scheduled.",
            );
        });
    }
    if (wakeLock.current) {
      void wakeLock.current.release();
      wakeLock.current = null;
      setWake(false);
    }
  }, [door.id, saveSession, testOnly]);
  const { attachVideo, attachDemoCanvas, ...monitor } = useCameraMonitor(
    settings,
    disarm,
  );
  const armed = !!session?.armed && session.session_id === ownerId;
  const foreign = !!session?.armed && session.session_id !== ownerId;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        `pet-door-camera:${door.id}`,
        JSON.stringify({ version: 1, settings }),
      );
    } catch {
      /* Storage optional. */
    }
  }, [door.id, settings]);
  const refresh = useCallback(async () => {
    if (testOnly) return;
    const epoch = requestEpoch.current;
    const [cameraResult, doorResult] = await Promise.allSettled([
      cameraApi.state(door.id),
      api.status(door.id),
    ]);
    if (!mounted.current || epoch !== requestEpoch.current) return;
    if (cameraResult.status === "fulfilled") saveSession(cameraResult.value);
    if (doorResult.status === "fulfilled") setDoorStatus(doorResult.value);
    else setDoorStatus(null);
    if (cameraResult.status === "rejected")
      setError(
        cameraResult.reason instanceof Error
          ? cameraResult.reason.message
          : "Camera state unavailable",
      );
  }, [door.id, saveSession, testOnly]);
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), 3000);
    return () => {
      clearTimeout(initial);
      clearInterval(t);
    };
  }, [refresh]);
  useEffect(() => {
    if (!armed) return;
    const tick = () => {
      if (!monitor.fresh || monitor.state !== "live") {
        disarm();
        return;
      }
      const epoch = requestEpoch.current;
      const requestedOwner = owner.current;
      void cameraApi
        .heartbeat(door.id, requestedOwner)
        .then((value) => {
          if (
            epoch === requestEpoch.current &&
            requestedOwner === owner.current
          )
            saveSession(value);
        })
        .catch(() => {
          if (
            epoch !== requestEpoch.current ||
            requestedOwner !== owner.current ||
            !mounted.current
          )
            return;
          disarm();
          setError(
            "Camera heartbeat failed. Automatic opening disarmed; an existing delayed close remains scheduled.",
          );
        });
    };
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, [armed, disarm, door.id, monitor.fresh, monitor.state, saveSession]);
  useEffect(() => {
    if (monitor.presence.status === "absent") {
      sentVisit.current = false;
      eventId.current = null;
    }
    if (
      !armed ||
      !monitor.fresh ||
      monitor.state !== "live" ||
      monitor.presence.status !== "present" ||
      monitor.presence.phase !== "present" ||
      !monitor.evidence.box ||
      monitor.evidence.score < settings.config.minScore ||
      monitor.evidence.area < settings.config.minArea ||
      sentVisit.current ||
      testOnly
    )
      return;
    sentVisit.current = true;
    const id = eventId.current ?? crypto.randomUUID();
    eventId.current = id;
    const epoch = requestEpoch.current;
    const requestedOwner = owner.current;
    void cameraApi
      .detection(door.id, requestedOwner, id)
      .then((value) => {
        if (
          epoch !== requestEpoch.current ||
          requestedOwner !== owner.current ||
          !mounted.current
        )
          return;
        saveSession(value);
        log(value.message || value.status);
        void refresh();
      })
      .catch((caught) => {
        if (
          epoch !== requestEpoch.current ||
          requestedOwner !== owner.current ||
          !mounted.current
        )
          return;
        disarm();
        setError(
          caught instanceof Error ? caught.message : "Detection event failed.",
        );
        log(
          "Detection request failed. Auto mode disarmed; inspect door state before retrying.",
        );
      });
  }, [
    armed,
    disarm,
    door.id,
    log,
    monitor.fresh,
    monitor.presence.status,
    monitor.presence.phase,
    monitor.evidence,
    settings.config.minArea,
    settings.config.minScore,
    monitor.state,
    refresh,
    saveSession,
    testOnly,
  ]);
  useEffect(() => {
    if (!armed || (monitor.fresh && monitor.state === "live")) return;
    const t = setTimeout(disarm, 0);
    return () => clearTimeout(t);
  }, [armed, monitor.fresh, monitor.state, disarm]);
  const updateSettings = (next: MonitorSettings) => {
    monitor.reset();
    setSettings(next);
    setSampleId(null);
  };
  const updateConfig = (key: keyof PresenceConfig, value: number) =>
    updateSettings({
      ...settings,
      config: { ...settings.config, [key]: value },
    });
  const changeCamera = (value: string | null) => {
    monitor.stop(
      "Camera direction changed. Check the new view and recalibrate before arming.",
    );
    setSettings({
      ...settings,
      facing: value === "user" ? "user" : "environment",
      profiles: DEFAULT_COAT_PROFILES,
    });
    setSampleId(null);
  };
  const manual = async (command: "open" | "close") => {
    if (working) return;
    setWorking(command);
    setError("");
    disarm();
    if (testOnly) {
      setSimulatedOpen(command === "open");
      log(`MOCK ${command.toUpperCase()} · no hardware connected`);
      setWorking(null);
      return;
    }
    try {
      await api.command(door.id, command);
      log(
        `Manual ${command} sent. Pending camera close canceled and auto mode disarmed.`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Door command failed.",
      );
    } finally {
      await refresh();
      setWorking(null);
    }
  };
  const arm = async () => {
    if (
      working ||
      !monitor.fresh ||
      monitor.state !== "live" ||
      !ack ||
      testOnly
    )
      return;
    setWorking("arm");
    setError("");
    const epoch = ++requestEpoch.current;
    const requestedOwner = crypto.randomUUID();
    owner.current = requestedOwner;
    setOwnerId(requestedOwner);
    try {
      const value = await cameraApi.arm(
        door.id,
        requestedOwner,
        Math.round(delay * 60),
      );
      if (epoch !== requestEpoch.current || !mounted.current) {
        void cameraApi.disarm(door.id, requestedOwner).catch(() => {});
        return;
      }
      sentVisit.current = false;
      eventId.current = null;
      saveSession(value);
      setArmModal(false);
      log(
        `Camera armed for ${door.name}, close ${delay} minutes after opening.`,
      );
    } catch (caught) {
      if (epoch === requestEpoch.current && mounted.current)
        setError(
          caught instanceof Error ? caught.message : "Could not arm camera.",
        );
    } finally {
      if (epoch === requestEpoch.current && mounted.current) setWorking(null);
    }
  };
  const cancelClose = async () => {
    disarm();
    setWorking("cancel");
    try {
      saveSession(await cameraApi.cancelClose(door.id));
      log("Delayed close canceled. Camera disarmed.");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not cancel close.",
      );
    } finally {
      setWorking(null);
    }
  };
  const sample = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!sampleId) return;
    const frame = monitor.getFrame(),
      rect = event.currentTarget.getBoundingClientRect(),
      profile = settings.profiles.find((p) => p.id === sampleId);
    if (!frame || !profile) return;
    const next = sampleCoatProfile(
      frame,
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
      profile,
    );
    if (!next) {
      setError("Sample is too dark. Choose a well-lit patch of coat.");
      return;
    }
    updateSettings({
      ...settings,
      profiles: settings.profiles.map((p) => (p.id === sampleId ? next : p)),
    });
    log(`${profile.name} coat calibrated on this phone.`);
  };
  const toggleWake = async () => {
    if (wakePending.current) return;
    wakePending.current = true;
    const epoch = requestEpoch.current;
    try {
      if (wake) {
        await wakeLock.current?.release();
        if (mounted.current) setWake(false);
        return;
      }
      if (!("wakeLock" in navigator))
        throw Error(
          "Wake lock is not supported. Use your phone’s stay-awake setting.",
        );
      const lock = await navigator.wakeLock.request("screen");
      if (epoch !== requestEpoch.current || !mounted.current) {
        await lock.release();
        return;
      }
      wakeLock.current = lock;
      setWake(true);
      lock.addEventListener("release", () => {
        if (wakeLock.current === lock) {
          wakeLock.current = null;
          if (mounted.current) setWake(false);
        }
      });
    } catch (caught) {
      if (epoch === requestEpoch.current && mounted.current)
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not keep screen awake.",
        );
    } finally {
      wakePending.current = false;
    }
  };
  const running = monitor.state === "live" || monitor.state === "demo",
    zone = settings.zones[zoneIndex],
    box = monitor.evidence.box;
  const statusAge = doorStatus
    ? clockNow - Date.parse(doorStatus.checked_at)
    : Infinity;
  const freshDoorStatus =
    Number.isFinite(statusAge) && statusAge >= -5000 && statusAge < 8000;
  const safeClose =
    testOnly ||
    (!!doorStatus &&
      freshDoorStatus &&
      doorStatus.online === true &&
      doorStatus.open === true &&
      !doorStatus.moving &&
      doorStatus.safe_to_close === true);
  const safeOpen =
    testOnly ||
    (!!doorStatus &&
      freshDoorStatus &&
      doorStatus.online === true &&
      !doorStatus.moving);
  const updateZone = (key: keyof typeof zone.box, value: number) => {
    const next = { ...zone.box, [key]: value };
    next.x = Math.min(next.x, 1 - next.width);
    next.y = Math.min(next.y, 1 - next.height);
    updateSettings({
      ...settings,
      zones: settings.zones.map((z, i) =>
        i === zoneIndex ? { ...z, box: next } : z,
      ),
    });
  };
  return (
    <div className="camera-page">
      <Container size={1100} py="md">
        <Group justify="space-between" mb="lg">
          <Group gap="sm">
            <ActionIcon
              variant="default"
              size="lg"
              onClick={() => {
                monitor.stop();
                onBack();
              }}
              aria-label="Back to doors"
            >
              <IconArrowLeft size={19} />
            </ActionIcon>
            <div>
              <Text size="xs" c="dimmed">
                CAMERA MODE
              </Text>
              <Title order={1} size="h3">
                {door.name}
              </Title>
            </div>
          </Group>
          <Badge color={armed ? "green" : "gray"} variant="light">
            {testOnly
              ? "TEST ONLY"
              : armed
                ? "AUTO ARMED"
                : foreign
                  ? "OTHER CAMERA ARMED"
                  : "PREVIEW ONLY"}
          </Badge>
        </Group>
        {error && (
          <Alert
            color="orange"
            icon={<IconAlertTriangle size={18} />}
            withCloseButton
            onClose={() => setError("")}
            mb="md"
          >
            {error}
          </Alert>
        )}
        <div className="camera-layout">
          <div>
            <Paper withBorder className="camera-view-card">
              <Group justify="space-between" p="sm">
                <Text size="xs" fw={600}>
                  {monitor.state === "demo"
                    ? "SYNTHETIC DEMO"
                    : monitor.state.toUpperCase()}
                </Text>
                <Text size="xs" c="dimmed">
                  {settings.mode === "object"
                    ? "On-device dog recognition"
                    : "Color + motion heuristic"}
                </Text>
              </Group>
              <div
                className={`camera-view ${sampleId ? "sampling" : ""}`}
                style={{ aspectRatio: monitor.aspect }}
                onClick={sample}
              >
                <video
                  ref={attachVideo}
                  autoPlay
                  playsInline
                  muted
                  className={
                    monitor.state === "live" || monitor.state === "starting"
                      ? ""
                      : "camera-hidden"
                  }
                  aria-label="Live door camera"
                />
                <canvas
                  ref={attachDemoCanvas}
                  className={monitor.state === "demo" ? "" : "camera-hidden"}
                  aria-label="Synthetic camera test targets"
                />
                {!running && monitor.state !== "starting" && (
                  <div className="camera-placeholder">
                    <IconCamera size={43} stroke={1.2} />
                    <Title order={2} size="h3">
                      Watch the doorway
                    </Title>
                    <Text size="sm" c="dimmed">
                      Frames stay on this phone.
                    </Text>
                    <Button
                      leftSection={<IconCamera size={17} />}
                      onClick={() => void monitor.start()}
                    >
                      Start camera
                    </Button>
                    <Button
                      variant="subtle"
                      leftSection={<IconPlayerPlay size={16} />}
                      onClick={() => void monitor.start(true)}
                    >
                      Try safe demo
                    </Button>
                  </div>
                )}
                {monitor.state === "starting" && (
                  <div className="camera-placeholder">
                    <Text>
                      {monitor.modelState === "loading"
                        ? "Loading local dog model…"
                        : "Starting camera…"}
                    </Text>
                    <Button variant="white" onClick={() => monitor.stop()}>
                      Cancel
                    </Button>
                  </div>
                )}
                {running &&
                  settings.zones
                    .filter((z) => z.enabled)
                    .map((z, i) => (
                      <div
                        key={z.id}
                        className={`camera-zone zone-${i}`}
                        style={{
                          left: `${z.box.x * 100}%`,
                          top: `${z.box.y * 100}%`,
                          width: `${z.box.width * 100}%`,
                          height: `${z.box.height * 100}%`,
                        }}
                      >
                        <span>{z.name}</span>
                      </div>
                    ))}
                {running && box && (
                  <div
                    className="camera-detection"
                    style={{
                      left: `${box.x * 100}%`,
                      top: `${box.y * 100}%`,
                      width: `${box.width * 100}%`,
                      height: `${box.height * 100}%`,
                    }}
                  >
                    <span>
                      {monitor.state === "demo"
                        ? "Test target"
                        : settings.mode === "object"
                          ? "Dog"
                          : "Color blob"}{" "}
                      {Math.round(monitor.evidence.score * 100)}%
                    </span>
                  </div>
                )}
                {sampleId && (
                  <div className="camera-sample-tip">
                    Tap a patch of{" "}
                    {settings.profiles
                      .find((p) => p.id === sampleId)
                      ?.name.toLowerCase()}{" "}
                    coat.{" "}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSampleId(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
              <Group justify="space-between" p="md">
                <div>
                  <Text fw={650}>
                    {monitor.presence.status === "present"
                      ? "Dog present"
                      : monitor.presence.status === "absent"
                        ? "No dog detected"
                        : "Presence unknown"}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {monitor.presence.reason.replace("simulated door", "door")}
                  </Text>
                </div>
                <Text size="xs" c="dimmed">
                  {running ? `${monitor.latency} ms / frame` : "Camera off"}
                </Text>
              </Group>
            </Paper>
            <Group justify="space-between" mt="sm" gap="xs" wrap="wrap">
              <Select
                aria-label="Camera direction"
                value={settings.facing}
                onChange={changeCamera}
                data={[
                  { value: "environment", label: "Rear camera" },
                  { value: "user", label: "Front camera" },
                ]}
                w={150}
              />
              <Group gap="xs">
                {running || monitor.state === "starting" ? (
                  <Button
                    variant="default"
                    leftSection={<IconCameraOff size={16} />}
                    onClick={() => monitor.stop()}
                  >
                    Stop camera
                  </Button>
                ) : (
                  <Button
                    leftSection={<IconCamera size={16} />}
                    onClick={() => void monitor.start()}
                  >
                    Start camera
                  </Button>
                )}
                <Button
                  variant="default"
                  onClick={() => void monitor.start(true)}
                >
                  Demo
                </Button>
              </Group>
            </Group>
            <Text size="xs" c="dimmed" mt="sm">
              {monitor.message}
            </Text>
            {monitor.state === "demo" && (
              <Paper withBorder p="sm" mt="sm">
                <Text size="xs" mb="xs">
                  Synthetic scenarios cannot operate the physical door.
                </Text>
                <SegmentedControl
                  fullWidth
                  value={monitor.demoTarget}
                  onChange={(v) =>
                    monitor.setDemoTarget(v as "yellow" | "brown" | "empty")
                  }
                  data={[
                    { value: "yellow", label: "Yellow dog" },
                    { value: "brown", label: "Brown dog" },
                    { value: "empty", label: "Empty" },
                  ]}
                />
                <Button
                  variant="subtle"
                  size="xs"
                  mt="xs"
                  onClick={() =>
                    monitor.stop(
                      "Simulated camera loss. No close was scheduled.",
                      "error",
                    )
                  }
                >
                  Test camera loss
                </Button>
              </Paper>
            )}
            {running && (
              <Checkbox
                mt="sm"
                checked={wake}
                onChange={() => void toggleWake()}
                label="Keep screen awake (when supported)"
                size="sm"
              />
            )}
            <Paper withBorder p="md" mt="lg">
              <Group justify="space-between" mb="sm">
                <Text fw={650}>Manual door controls</Text>
                <Badge variant="light" color="gray">
                  {testOnly
                    ? simulatedOpen
                      ? "MOCK OPEN"
                      : "MOCK CLOSED"
                    : (doorStatus?.state ?? "STATUS UNKNOWN")}
                </Badge>
              </Group>
              <div className="camera-manual">
                <Button
                  size="lg"
                  leftSection={<IconDoorEnter size={25} />}
                  disabled={!!working || !safeOpen}
                  loading={working === "open"}
                  onClick={() => void manual("open")}
                >
                  {testOnly ? "Mock open" : "Open door"}
                </Button>
                <Button
                  size="lg"
                  variant="default"
                  leftSection={<IconDoorExit size={25} />}
                  disabled={!!working || !safeClose}
                  loading={working === "close"}
                  onClick={() => void manual("close")}
                >
                  {testOnly ? "Mock close" : "Close door"}
                </Button>
              </div>
              <Text size="xs" c="dimmed" mt="sm">
                Manual actions disarm auto mode and cancel its pending close.
                Close requires fresh, known-safe door status. Camera preview and
                arming are separate.
              </Text>
            </Paper>
            <Alert
              variant="light"
              color="gray"
              icon={<IconShieldCheck size={18} />}
              mt="md"
            >
              A camera cannot prove the doorway is clear. Closing always needs a
              fresh hardware safety check. Reflections, glass, darkness, and
              pale coats can cause misses or false detections.
            </Alert>
          </div>
          <Stack gap="md">
            <Paper withBorder p="md">
              <Group justify="space-between" mb="sm">
                <Title order={2} size="h5">
                  Automatic opening
                </Title>
                <Badge color={armed ? "green" : "gray"}>
                  {armed ? "Armed" : "Disarmed"}
                </Badge>
              </Group>
              <Text size="sm" c="dimmed">
                A confirmed dog in either approach zone opens{" "}
                <strong>{door.name}</strong>. Schedule one close after the delay
                below; repeated detections do not extend it.
              </Text>
              <NumberInput
                mt="md"
                label="Close after opening"
                suffix=" minutes"
                value={delay}
                onChange={(v) => setDelay(typeof v === "number" ? v : 5)}
                min={1}
                max={60}
                step={1}
                disabled={armed || !!working}
              />
              <Button
                fullWidth
                mt="md"
                variant={armed ? "default" : "filled"}
                disabled={
                  !!working ||
                  testOnly ||
                  foreign ||
                  (!armed &&
                    (!monitor.fresh ||
                      monitor.state !== "live" ||
                      !settings.zones.some((z) => z.enabled)))
                }
                onClick={() => {
                  if (armed) {
                    disarm();
                    log(
                      "Camera disarmed. Existing delayed close remains scheduled.",
                    );
                  } else {
                    setAck(false);
                    setArmModal(true);
                  }
                }}
              >
                {armed ? "Disarm camera" : "Arm selected door"}
              </Button>
              {foreign && (
                <Text size="xs" c="orange" mt="xs">
                  Another camera owns this door. Disarm it there or wait for its
                  lease to expire.
                </Text>
              )}
              {session?.close_due_at && (
                <Alert color="orange" mt="md">
                  <Text size="sm" fw={600}>
                    Close scheduled:{" "}
                    {new Date(session.close_due_at).toLocaleTimeString()}
                  </Text>
                  <Text size="xs">
                    It remains scheduled if the phone stops, locks, disconnects,
                    or auto mode is disarmed. Hardware safety may hold it open.
                  </Text>
                  <Button
                    mt="sm"
                    variant="outline"
                    color="orange"
                    loading={working === "cancel"}
                    disabled={!!working && working !== "cancel"}
                    onClick={() => void cancelClose()}
                  >
                    Cancel scheduled close
                  </Button>
                </Alert>
              )}
              {session?.message && (
                <Text size="xs" c="dimmed" mt="sm">
                  {session.message}
                </Text>
              )}
              <Text size="xs" c="dimmed" mt="sm">
                The server must remain running for the timer to fire. Current
                Fly auto-stop settings require a deployment change before
                reliable unattended use.
              </Text>
            </Paper>
            <Paper withBorder p="md">
              <Tabs defaultValue="detection">
                <Tabs.List grow>
                  <Tabs.Tab value="detection">Detection</Tabs.Tab>
                  <Tabs.Tab value="zones">Zones</Tabs.Tab>
                  <Tabs.Tab value="activity">Activity</Tabs.Tab>
                </Tabs.List>
                <Tabs.Panel value="detection" pt="md">
                  <Stack gap="md">
                    <Select
                      label="Detector"
                      value={settings.mode}
                      onChange={(v) => {
                        monitor.stop(
                          "Detector changed. Start preview and re-arm explicitly.",
                        );
                        updateSettings({
                          ...settings,
                          mode: v === "color" ? "color" : "object",
                        });
                      }}
                      data={[
                        {
                          value: "object",
                          label: "Dog recognition (COCO-SSD)",
                        },
                        { value: "color", label: "Color + motion (heuristic)" },
                      ]}
                    />
                    {settings.mode === "object" ? (
                      <>
                        <Select
                          label="Recognition model"
                          value={settings.modelVariant}
                          onChange={(v) => {
                            monitor.stop(
                              "Recognition model changed. Restart preview before arming.",
                            );
                            updateSettings({
                              ...settings,
                              modelVariant: v === "lite" ? "lite" : "accurate",
                            });
                          }}
                          data={[
                            {
                              value: "accurate",
                              label:
                                "MobileNet v2 · stronger detection (68 MB)",
                            },
                            {
                              value: "lite",
                              label: "MobileNet Lite · smaller/faster (19 MB)",
                            },
                          ]}
                        />
                        <Alert color="orange" variant="light">
                          In a small photo test, MobileNet v2 found 3 of 4
                          retrievers; Lite found 2 of 4. Both rejected a sofa
                          and cat. Both missed a cropped dog. Test your actual
                          dogs and lighting before any real use.
                        </Alert>
                        <Text size="xs" c="dimmed">
                          Local model, no paid API. Generic dogs only, not your
                          dogs’ identity. Still dogs continue to be checked.
                          Model: {monitor.modelState}.
                        </Text>
                        <SettingRange
                          label="Dog confidence"
                          value={settings.config.minScore}
                          min={0.2}
                          max={0.95}
                          step={0.01}
                          valueLabel={`${Math.round(settings.config.minScore * 100)}%`}
                          onChange={(v) => updateConfig("minScore", v)}
                        />
                      </>
                    ) : (
                      <>
                        <Text size="xs" c="dimmed">
                          A large coat-colored blob must move to establish
                          arrival. Once present it can stay still. Similar
                          furniture and warm clothing can trigger it.
                        </Text>
                        {settings.profiles.map((p) => (
                          <Group key={p.id} justify="space-between">
                            <Text size="sm">{p.name}</Text>
                            <Button
                              size="xs"
                              variant="default"
                              disabled={!running}
                              leftSection={<IconTarget size={14} />}
                              onClick={() =>
                                setSampleId(sampleId === p.id ? null : p.id)
                              }
                            >
                              {sampleId === p.id ? "Cancel" : "Sample coat"}
                            </Button>
                          </Group>
                        ))}
                        <SettingRange
                          label="Color tolerance"
                          value={settings.profiles[0].hueTolerance}
                          min={5}
                          max={50}
                          valueLabel={`±${settings.profiles[0].hueTolerance}°`}
                          onChange={(v) =>
                            updateSettings({
                              ...settings,
                              profiles: settings.profiles.map((p) => ({
                                ...p,
                                hueTolerance: v,
                              })),
                            })
                          }
                        />
                        <SettingRange
                          label="Arrival motion"
                          value={settings.config.minMotion}
                          min={0.01}
                          max={0.4}
                          step={0.01}
                          valueLabel={`${Math.round(settings.config.minMotion * 100)}%`}
                          onChange={(v) => updateConfig("minMotion", v)}
                        />
                      </>
                    )}
                    <SettingRange
                      label="Minimum zone coverage"
                      value={settings.config.minArea}
                      min={0.005}
                      max={0.3}
                      step={0.005}
                      valueLabel={`${Math.round(settings.config.minArea * 100)}%`}
                      onChange={(v) => updateConfig("minArea", v)}
                    />
                    <SettingRange
                      label="Confirm arrival"
                      value={settings.config.arrivalMs}
                      min={500}
                      max={4000}
                      step={100}
                      valueLabel={`${(settings.config.arrivalMs / 1000).toFixed(1)} s`}
                      onChange={(v) => updateConfig("arrivalMs", v)}
                    />
                    <SettingRange
                      label="Reset visit after absence"
                      value={settings.config.absenceMs}
                      min={2000}
                      max={15000}
                      step={500}
                      valueLabel={`${settings.config.absenceMs / 1000} s`}
                      onChange={(v) => updateConfig("absenceMs", v)}
                    />
                    <Text size="xs" c="dimmed">
                      Settings changes disarm automatic opening. Settings stay
                      only in this browser; frames are never uploaded.
                    </Text>
                  </Stack>
                </Tabs.Panel>
                <Tabs.Panel value="zones" pt="md">
                  <Stack gap="md">
                    <Text size="xs" c="dimmed">
                      Either enabled approach zone can trigger this door. These
                      are not safety zones or direction tracking. Aim through
                      glass carefully and test reflections at night.
                    </Text>
                    <SegmentedControl
                      value={String(zoneIndex)}
                      onChange={(v) => setZoneIndex(Number(v))}
                      data={[
                        { value: "0", label: "Inside" },
                        { value: "1", label: "Outside" },
                      ]}
                    />
                    <Switch
                      label={`Enable ${zone.name.toLowerCase()}`}
                      checked={zone.enabled}
                      onChange={(e) =>
                        updateSettings({
                          ...settings,
                          zones: settings.zones.map((z, i) =>
                            i === zoneIndex
                              ? { ...z, enabled: e.currentTarget.checked }
                              : z,
                          ),
                        })
                      }
                    />
                    {(["width", "height", "x", "y"] as const).map((key) => (
                      <SettingRange
                        key={key}
                        label={
                          {
                            width: "Width",
                            height: "Height",
                            x: "Horizontal position",
                            y: "Vertical position",
                          }[key]
                        }
                        value={zone.box[key]}
                        min={key === "width" || key === "height" ? 0.1 : 0}
                        max={
                          key === "x"
                            ? 1 - zone.box.width
                            : key === "y"
                              ? 1 - zone.box.height
                              : 1
                        }
                        step={0.01}
                        valueLabel={`${Math.round(zone.box[key] * 100)}%`}
                        onChange={(v) => updateZone(key, v)}
                      />
                    ))}
                    <Button
                      variant="default"
                      leftSection={<IconRefresh size={15} />}
                      onClick={() =>
                        updateSettings({ ...settings, zones: INITIAL_ZONES })
                      }
                    >
                      Reset both zones
                    </Button>
                  </Stack>
                </Tabs.Panel>
                <Tabs.Panel value="activity" pt="md">
                  <Text size="xs" c="dimmed">
                    This page only. No camera frames are saved.
                  </Text>
                  {events.length ? (
                    <div className="camera-events">
                      {events.map((e) => (
                        <div key={e.id}>
                          <Text size="xs" c="dimmed">
                            {e.time}
                          </Text>
                          <Text size="sm">{e.message}</Text>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Text c="dimmed" size="sm" py="xl">
                      No events yet.
                    </Text>
                  )}
                </Tabs.Panel>
              </Tabs>
            </Paper>
          </Stack>
        </div>
        <Modal
          opened={armModal}
          onClose={disarm}
          title={`Arm camera for ${door.name}?`}
          centered
        >
          <Stack>
            <Text size="sm">
              This enables real automatic opening of this selected door on
              confirmed dog detections. A server-side close is scheduled {delay}{" "}
              minutes after each camera-triggered opening. The model can be
              wrong.
            </Text>
            <Text size="sm">
              Stopping the camera or disarming does not cancel an already
              scheduled close. Use Cancel scheduled close or a manual door
              action to cancel it.
            </Text>
            <Checkbox
              checked={ack}
              onChange={(e) => setAck(e.currentTarget.checked)}
              label="I checked the camera zones and door safety sensor, and want automatic opening for this door."
            />
            <Button
              disabled={!ack || !monitor.fresh}
              loading={working === "arm"}
              onClick={() => void arm()}
            >
              Arm {door.name}
            </Button>
          </Stack>
        </Modal>
      </Container>
    </div>
  );
}
function SettingRange({
  label,
  value,
  min,
  max,
  step = 1,
  valueLabel,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  valueLabel: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <Group justify="space-between" mb={8}>
        <Text size="sm">{label}</Text>
        <Text size="xs" c="dimmed">
          {valueLabel}
        </Text>
      </Group>
      <Slider
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={onChange}
      />
    </div>
  );
}
