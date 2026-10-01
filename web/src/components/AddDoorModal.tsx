import { FormEvent, useState } from 'react'
import {
  Alert, Button, Group, Modal, PasswordInput, Select, Stack, TextInput, Textarea,
} from '@mantine/core'
import { IconAlertCircle, IconCheck, IconQrcode } from '@tabler/icons-react'
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
    <Modal opened={opened} onClose={resetAndClose} title="Connect a pet door" size="lg" centered>
      <form onSubmit={submit}>
        <Stack gap="lg">
          {error && (
            <Alert icon={<IconAlertCircle size={18} />} color="red" variant="light">
              {error}
            </Alert>
          )}
          <Group grow align="start">
            <TextInput
              label="Door name"
              placeholder="Kitchen door"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
            />
            <Select
              label="Provider"
              data={[{ value: 'wayzn', label: 'Wayzn' }]}
              value="wayzn"
              allowDeselect={false}
            />
          </Group>

          <div className="setup-section">
            <QRScanner onScan={setQRPayload} />
            <Textarea
              mt="md"
              label="QR contents"
              description="Scan with the camera, or paste the code here."
              placeholder="Pairing code"
              value={qrPayload}
              onChange={(event) => setQRPayload(event.currentTarget.value)}
              leftSection={<IconQrcode size={17} />}
              minRows={2}
              autosize
              required
            />
            {qrPayload && (
              <Alert mt="sm" color="moss" variant="light" icon={<IconCheck size={17} />}>
                Pairing code captured.
              </Alert>
            )}
          </div>

          <div className="setup-section">
            <TextInput
              label="Wayzn email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
              required
            />
            <PasswordInput
              mt="md"
              label="Wayzn password"
              description="Used once to get a refresh token. It is never saved."
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              required
            />
          </div>

          <Group justify="flex-end">
            <Button variant="subtle" color="gray" onClick={resetAndClose}>Cancel</Button>
            <Button type="submit" loading={saving}>Connect door</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}
