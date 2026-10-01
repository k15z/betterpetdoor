import { useState } from 'react'
import {
  ActionIcon, Badge, Button, Card, Group, Menu, Stack, Text, Tooltip,
} from '@mantine/core'
import {
  IconArrowsVertical, IconChevronDown, IconDoor, IconDots, IconLockOpen,
  IconRefresh, IconTrash,
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { api, type Door, type DoorStatus } from '../api'

const stateLabels: Record<string, string> = {
  open: 'Open', closed: 'Closed', opening: 'Opening', closing: 'Closing',
  obstructed: 'Obstructed', offline: 'Offline', disengaged: 'Disengaged',
  paused: 'Paused', heat_detected: 'Heat detected', locked: 'Locked', unknown: 'Unknown',
}

function badgeColor(state?: string) {
  if (state === 'open') return 'moss'
  if (state === 'closed') return 'dark'
  if (state === 'opening' || state === 'closing') return 'blue'
  if (state === 'obstructed' || state === 'heat_detected') return 'red'
  return 'gray'
}

export function DoorCard({
  door,
  status,
  statusError,
  onRefresh,
  onRemove,
}: {
  door: Door
  status?: DoorStatus
  statusError?: string
  onRefresh: () => Promise<void>
  onRemove: () => void
}) {
  const [working, setWorking] = useState<string | null>(null)

  async function command(value: 'open' | 'close' | 'open-and-close') {
    setWorking(value)
    try {
      await api.command(door.id, value)
      notifications.show({ title: `${door.name}: command sent`, message: value.replaceAll('-', ' '), color: 'moss' })
      window.setTimeout(() => void onRefresh(), 1200)
    } catch (caught) {
      notifications.show({
        title: 'Command failed',
        message: caught instanceof Error ? caught.message : 'The door did not respond.',
        color: 'red',
      })
    } finally {
      setWorking(null)
    }
  }

  const state = status?.state ?? (statusError ? 'offline' : 'unknown')

  return (
    <Card className="door-card" radius="lg" padding="xl">
      <Group justify="space-between" align="flex-start">
        <Group gap="md" wrap="nowrap">
          <div className={`door-glyph state-${state}`}><IconDoor size={27} stroke={1.7} /></div>
          <div>
            <Text fw={700} size="lg">{door.name}</Text>
            <Group gap="xs" mt={4}>
              <Badge color={badgeColor(state)} variant="light" size="sm">
                {stateLabels[state] ?? state}
              </Badge>
              <Text size="xs" c="dimmed">Wayzn</Text>
            </Group>
          </div>
        </Group>
        <Menu position="bottom-end" shadow="md">
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" aria-label="Door options"><IconDots size={20} /></ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconRefresh size={16} />} onClick={() => void onRefresh()}>Refresh status</Menu.Item>
            <Menu.Divider />
            <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={onRemove}>Remove door</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      <div className="door-visual" aria-hidden="true">
        <div className={`door-panel ${state === 'open' ? 'is-open' : ''}`}>
          <span className="door-window" />
        </div>
        <span className="door-floor" />
      </div>

      <Stack gap="sm">
        {statusError && <Text size="sm" c="red">{statusError}</Text>}
        <Group grow>
          <Button
            variant="filled"
            leftSection={<IconLockOpen size={18} />}
            loading={working === 'open'}
            disabled={working !== null}
            onClick={() => void command('open')}
          >
            Open
          </Button>
          <Button
            variant="light"
            color="dark"
            leftSection={<IconChevronDown size={18} />}
            loading={working === 'close'}
            disabled={working !== null || status?.safe_to_close === false}
            onClick={() => void command('close')}
          >
            Close
          </Button>
        </Group>
        <Tooltip label="Open, wait for the configured interval, then close">
          <Button
            variant="subtle"
            color="gray"
            leftSection={<IconArrowsVertical size={17} />}
            loading={working === 'open-and-close'}
            disabled={working !== null}
            onClick={() => void command('open-and-close')}
          >
            Open and close
          </Button>
        </Tooltip>
      </Stack>
    </Card>
  )
}
