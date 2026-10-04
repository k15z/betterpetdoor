import { useState } from "react";
import { ActionIcon, Button, Card, Group, Menu, Text } from "@mantine/core";
import {
  IconArrowsVertical,
  IconDots,
  IconRefresh,
  IconTrash,
  IconCamera,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api, type Door, type DoorStatus } from "../api";

const stateLabels: Record<string, string> = {
  open: "Open",
  closed: "Closed",
  opening: "Opening",
  closing: "Closing",
  obstructed: "Obstructed",
  offline: "Offline",
  disengaged: "Disengaged",
  paused: "Paused",
  heat_detected: "Heat detected",
  locked: "Locked",
  unknown: "Unknown",
};

export function DoorCard({
  door,
  status,
  statusError,
  onRefresh,
  onRemove,
  onCamera,
}: {
  door: Door;
  status?: DoorStatus;
  statusError?: string;
  onRefresh: () => Promise<void>;
  onRemove: () => void;
  onCamera: () => void;
}) {
  const [working, setWorking] = useState<string | null>(null);

  async function command(value: "open" | "close" | "open-and-close") {
    setWorking(value);
    try {
      await api.command(door.id, value);
      notifications.show({
        message: `${door.name}: ${value.replaceAll("-", " ")} sent.`,
        color: "gray",
      });
      window.setTimeout(() => void onRefresh(), 1200);
    } catch (caught) {
      notifications.show({
        title: "Command failed",
        message:
          caught instanceof Error
            ? caught.message
            : "The door did not respond.",
        color: "gray",
      });
    } finally {
      setWorking(null);
    }
  }

  const state = status?.state ?? (statusError ? "offline" : "unknown");

  return (
    <Card className={`door-card state-${state}`} padding={0}>
      <span className="state-rail" aria-hidden="true" />
      <Group
        className="door-card-content"
        justify="space-between"
        gap="lg"
        wrap="wrap"
      >
        <div className="door-summary">
          <Text fw={650}>{door.name}</Text>
          <Text className="door-state">{stateLabels[state] ?? state}</Text>
          {statusError && (
            <Text className="door-error" size="xs">
              {statusError}
            </Text>
          )}
        </div>

        <Group className="door-controls" gap="xs" wrap="nowrap">
          <Button
            variant={state === "closed" ? "filled" : "default"}
            disabled={working !== null}
            onClick={() => void command("open")}
          >
            {working === "open" ? "Opening" : "Open"}
          </Button>
          <Button
            variant={state === "open" ? "filled" : "default"}
            disabled={working !== null || status?.safe_to_close === false}
            onClick={() => void command("close")}
          >
            {working === "close" ? "Closing" : "Close"}
          </Button>
          <Menu
            position="bottom-end"
            shadow="sm"
            transitionProps={{ duration: 0 }}
          >
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={`${door.name} options`}
              >
                <IconDots size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconCamera size={16} />}
                onClick={onCamera}
              >
                Camera mode
              </Menu.Item>
              <Menu.Item
                disabled={working !== null}
                leftSection={<IconArrowsVertical size={15} />}
                onClick={() => void command("open-and-close")}
              >
                Open and close
              </Menu.Item>
              <Menu.Item
                leftSection={<IconRefresh size={16} />}
                onClick={() => void onRefresh()}
              >
                Refresh status
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                leftSection={<IconTrash size={15} />}
                onClick={onRemove}
              >
                Remove
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
    </Card>
  );
}
