import { useCallback, useEffect, useState } from 'react'
import {
  ActionIcon, AppShell, Button, Container, Group, Loader, Modal, SimpleGrid,
  Stack, Text, Title,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { IconLogout, IconPlus, IconRefresh } from '@tabler/icons-react'
import { api, type Door, type DoorStatus } from '../api'
import { AddDoorModal } from './AddDoorModal'
import { Brand } from './Brand'
import { DoorCard } from './DoorCard'

export function Dashboard({ onSignedOut }: { onSignedOut: () => void }) {
  const [doors, setDoors] = useState<Door[]>([])
  const [statuses, setStatuses] = useState<Record<string, DoorStatus>>({})
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [addOpened, addControls] = useDisclosure(false)
  const [removeDoor, setRemoveDoor] = useState<Door | null>(null)

  const refreshStatus = useCallback(async (door: Door) => {
    try {
      const status = await api.status(door.id)
      setStatuses((current) => ({ ...current, [door.id]: status }))
      setStatusErrors((current) => {
        const next = { ...current }
        delete next[door.id]
        return next
      })
    } catch (caught) {
      setStatusErrors((current) => ({
        ...current,
        [door.id]: caught instanceof Error ? caught.message : 'Status unavailable.',
      }))
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.doors()
      setDoors(result.doors)
      await Promise.all(result.doors.map(refreshStatus))
    } catch (caught) {
      notifications.show({
        title: 'Could not load doors',
        message: caught instanceof Error ? caught.message : 'Try again.',
        color: 'red',
      })
    } finally {
      setLoading(false)
    }
  }, [refreshStatus])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const timer = window.setInterval(() => doors.forEach((door) => void refreshStatus(door)), 30_000)
    return () => window.clearInterval(timer)
  }, [doors, refreshStatus])

  async function logout() {
    try { await api.logout() } finally { onSignedOut() }
  }

  async function confirmRemove() {
    if (!removeDoor) return
    try {
      await api.removeDoor(removeDoor.id)
      setDoors((current) => current.filter((door) => door.id !== removeDoor.id))
      notifications.show({ title: 'Door removed', message: removeDoor.name, color: 'gray' })
    } catch (caught) {
      notifications.show({
        title: 'Could not remove door',
        message: caught instanceof Error ? caught.message : 'Try again.',
        color: 'red',
      })
    } finally {
      setRemoveDoor(null)
    }
  }

  return (
    <AppShell header={{ height: 72 }} padding={0}>
      <AppShell.Header className="app-header">
        <Container size="xl" h="100%">
          <Group h="100%" justify="space-between">
            <Brand />
            <Group>
              <ActionIcon variant="subtle" color="gray" onClick={() => void load()} aria-label="Refresh all doors">
                <IconRefresh size={20} />
              </ActionIcon>
              <Button variant="light" leftSection={<IconPlus size={18} />} onClick={addControls.open}>Add door</Button>
              <ActionIcon variant="subtle" color="gray" onClick={() => void logout()} aria-label="Sign out">
                <IconLogout size={20} />
              </ActionIcon>
            </Group>
          </Group>
        </Container>
      </AppShell.Header>

      <AppShell.Main className="dashboard page-surface">
        <Container size="xl" py={{ base: 36, sm: 56 }}>
          <Group justify="space-between" align="end" mb="xl">
            <div>
              <Text className="eyebrow">Control room</Text>
              <Title order={1}>Pet doors</Title>
              <Text c="dimmed" mt={6}>A quiet little dashboard for every way in and out.</Text>
            </div>
            <Text size="sm" c="dimmed">{doors.length} {doors.length === 1 ? 'door' : 'doors'} connected</Text>
          </Group>

          {loading && doors.length === 0 ? (
            <Group justify="center" py={80}><Loader color="moss" /></Group>
          ) : doors.length === 0 ? (
            <Stack className="empty-state" align="center" gap="md">
              <div className="empty-door" aria-hidden="true"><span /></div>
              <Title order={2}>Connect your first door</Title>
              <Text c="dimmed" ta="center" maw={480}>
                Scan the “Add New User” code from Wayzn. Your credentials stay on this server.
              </Text>
              <Button leftSection={<IconPlus size={18} />} onClick={addControls.open}>Add a pet door</Button>
            </Stack>
          ) : (
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg">
              {doors.map((door) => (
                <DoorCard
                  key={door.id}
                  door={door}
                  status={statuses[door.id]}
                  statusError={statusErrors[door.id]}
                  onRefresh={() => refreshStatus(door)}
                  onRemove={() => setRemoveDoor(door)}
                />
              ))}
            </SimpleGrid>
          )}
        </Container>
      </AppShell.Main>

      <AddDoorModal
        opened={addOpened}
        onClose={addControls.close}
        onAdded={(door) => {
          setDoors((current) => [...current, door])
          void refreshStatus(door)
          notifications.show({ title: 'Door connected', message: door.name, color: 'moss' })
        }}
      />

      <Modal opened={removeDoor !== null} onClose={() => setRemoveDoor(null)} title="Remove pet door?" centered size="sm">
        <Text size="sm">This removes <strong>{removeDoor?.name}</strong> and its saved credentials from this server.</Text>
        <Group justify="flex-end" mt="xl">
          <Button variant="subtle" color="gray" onClick={() => setRemoveDoor(null)}>Cancel</Button>
          <Button color="red" onClick={() => void confirmRemove()}>Remove</Button>
        </Group>
      </Modal>
    </AppShell>
  )
}
