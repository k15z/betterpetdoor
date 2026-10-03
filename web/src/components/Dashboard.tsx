import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  AppShell,
  Button,
  Container,
  Group,
  Modal,
  Stack,
  Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconLogout, IconPlus, IconRefresh } from "@tabler/icons-react";
import { api, type Door, type DoorStatus } from "../api";
import { AddDoorModal } from "./AddDoorModal";
import { DoorCard } from "./DoorCard";
const CameraMonitor = lazy(() => import("../camera/CameraMonitor"));
const cameraDoorFromPath = () => {
  const match = /^\/doors\/([^/]+)\/camera$/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
};

export function Dashboard({ onSignedOut }: { onSignedOut: () => void }) {
  const [cameraDoorId, setCameraDoorId] = useState<string | null>(
    cameraDoorFromPath,
  );
  useEffect(() => {
    const pop = () => setCameraDoorId(cameraDoorFromPath());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const openCamera = (id: string | null) => {
    window.history.pushState(
      {},
      "",
      id ? `/doors/${encodeURIComponent(id)}/camera` : "/",
    );
    setCameraDoorId(id);
  };
  const [doors, setDoors] = useState<Door[]>([]);
  const [statuses, setStatuses] = useState<Record<string, DoorStatus>>({});
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [addOpened, addControls] = useDisclosure(false);
  const [removeDoor, setRemoveDoor] = useState<Door | null>(null);

  const refreshStatus = useCallback(async (door: Door) => {
    try {
      const status = await api.status(door.id);
      setStatuses((current) => ({ ...current, [door.id]: status }));
      setStatusErrors((current) => {
        const next = { ...current };
        delete next[door.id];
        return next;
      });
    } catch (caught) {
      setStatusErrors((current) => ({
        ...current,
        [door.id]:
          caught instanceof Error ? caught.message : "Status unavailable.",
      }));
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.doors();
      setDoors(result.doors);
      await Promise.all(result.doors.map(refreshStatus));
    } catch (caught) {
      notifications.show({
        title: "Could not load doors",
        message: caught instanceof Error ? caught.message : "Try again.",
        color: "gray",
      });
    } finally {
      setLoading(false);
    }
  }, [refreshStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(
      () => doors.forEach((door) => void refreshStatus(door)),
      30_000,
    );
    return () => window.clearInterval(timer);
  }, [doors, refreshStatus]);

  async function logout() {
    try {
      await api.logout();
    } finally {
      onSignedOut();
    }
  }

  async function confirmRemove() {
    if (!removeDoor) return;
    try {
      await api.removeDoor(removeDoor.id);
      setDoors((current) =>
        current.filter((door) => door.id !== removeDoor.id),
      );
      notifications.show({
        message: `${removeDoor.name} removed.`,
        color: "gray",
      });
    } catch (caught) {
      notifications.show({
        title: "Could not remove door",
        message: caught instanceof Error ? caught.message : "Try again.",
        color: "gray",
      });
    } finally {
      setRemoveDoor(null);
    }
  }

  const cameraDoor = doors.find((door) => door.id === cameraDoorId);
  if (cameraDoor)
    return (
      <Suspense fallback={<Text p="xl">Loading camera mode…</Text>}>
        <CameraMonitor
          key={cameraDoor.id}
          door={cameraDoor}
          onBack={() => openCamera(null)}
        />
      </Suspense>
    );

  return (
    <AppShell header={{ height: 64 }} padding={0}>
      <AppShell.Header className="app-header">
        <Container size={920} h="100%">
          <Group h="100%" justify="space-between">
            <Text fw={650}>Pet doors</Text>
            <Group gap="xs">
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={() => void load()}
                aria-label="Refresh"
              >
                <IconRefresh size={18} />
              </ActionIcon>
              <Button
                variant="default"
                leftSection={<IconPlus size={16} />}
                onClick={addControls.open}
              >
                Add
              </Button>
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={() => void logout()}
                aria-label="Sign out"
              >
                <IconLogout size={18} />
              </ActionIcon>
            </Group>
          </Group>
        </Container>
      </AppShell.Header>

      <AppShell.Main className="dashboard page-surface">
        <Container size={920} py={{ base: 24, sm: 40 }}>
          {loading && doors.length === 0 ? (
            <Group justify="center" py={80}>
              <Text c="dimmed" size="sm">
                Loading
              </Text>
            </Group>
          ) : doors.length === 0 ? (
            <Stack className="empty-state" align="center" gap="md">
              <Text c="dimmed">No doors</Text>
              <Button
                variant="default"
                leftSection={<IconPlus size={16} />}
                onClick={addControls.open}
              >
                Add door
              </Button>
            </Stack>
          ) : (
            <Stack gap="sm">
              {doors.map((door) => (
                <DoorCard
                  key={door.id}
                  door={door}
                  status={statuses[door.id]}
                  statusError={statusErrors[door.id]}
                  onRefresh={() => refreshStatus(door)}
                  onRemove={() => setRemoveDoor(door)}
                  onCamera={() => openCamera(door.id)}
                />
              ))}
            </Stack>
          )}
        </Container>
      </AppShell.Main>

      <AddDoorModal
        opened={addOpened}
        onClose={addControls.close}
        onAdded={(door) => {
          setDoors((current) => [...current, door]);
          void refreshStatus(door);
          notifications.show({
            message: `${door.name} connected.`,
            color: "gray",
          });
        }}
      />

      <Modal
        opened={removeDoor !== null}
        onClose={() => setRemoveDoor(null)}
        title="Remove door?"
        centered
        size="sm"
        transitionProps={{ duration: 0 }}
      >
        <Text size="sm">
          Remove <strong>{removeDoor?.name}</strong> and its credentials?
        </Text>
        <Group justify="flex-end" mt="xl">
          <Button variant="default" onClick={() => setRemoveDoor(null)}>
            Cancel
          </Button>
          <Button onClick={() => void confirmRemove()}>Remove</Button>
        </Group>
      </Modal>
    </AppShell>
  );
}
