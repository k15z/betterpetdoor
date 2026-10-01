import { FormEvent, useState } from 'react'
import {
  Alert, Button, Group, Modal, PasswordInput, Stack, TextInput, Textarea,
} from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'
import { api, type Door } from '../api'
import { QRScanner } from './QRScanner'

export function AddDoorModal({
  opened,
  onClose,
  onAdded,
}: {
  opened: boolean
  onClose: () => void
  onAdded: (door: Door) => void
}) {
  const [name, setName] = useState('')
  const [qrPayload, setQRPayload] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  function resetAndClose() {
    setName('')
    setQRPayload('')
    setEmail('')
    setPassword('')
    setError('')
    onClose()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setSaving(true)
    try {
      const door = await api.addDoor({
        name,
        provider: 'wayzn',
        qr_payload: qrPayload,
        email,
        password,
      })
      onAdded(door)
      resetAndClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add this door.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal opened={opened} onClose={resetAndClose} title="Connect a pet door" size="lg" centered transitionProps={{ duration: 0 }}>
      <form onSubmit={submit}>
        <Stack gap="lg">
          {error && (
            <Alert icon={<IconAlertCircle size={17} />} color="gray" variant="outline">
              {error}
            </Alert>
          )}
          <TextInput
            label="Name"
            placeholder="Kitchen"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            required
          />

          <Stack gap="xs">
            <QRScanner onScan={setQRPayload} />
            <Textarea
              label="Pairing code"
              description="Scan or paste the Wayzn Add New User code."
              placeholder="Pairing code"
              value={qrPayload}
              onChange={(event) => setQRPayload(event.currentTarget.value)}
              minRows={2}
              autosize
              required
            />
          </Stack>

          <Stack gap="md">
            <TextInput
              label="Email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
              required
            />
            <PasswordInput
              label="Password"
              description="Used once and not saved."
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              required
            />
          </Stack>

          <Group justify="flex-end">
            <Button variant="default" onClick={resetAndClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Connecting' : 'Connect'}</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}
