import { FormEvent, useState } from 'react'
import { Alert, Button, Container, Paper, PasswordInput, Stack, Text, Title } from '@mantine/core'
import { IconAlertCircle, IconArrowRight } from '@tabler/icons-react'
import { api } from '../api'
import { Brand } from './Brand'

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      await api.login(password)
      onSignedIn()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not sign in.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-page page-surface">
      <Container size={440} className="login-shell">
        <Brand />
        <div className="login-copy">
          <Text className="eyebrow">Your doors. Your server.</Text>
          <Title order={1}>Welcome home.</Title>
          <Text c="dimmed" size="lg">
            Sign in to open, close, and check your pet doors.
          </Text>
        </div>
        <Paper component="form" onSubmit={submit} className="login-card" p="xl" radius="lg">
          <Stack>
            <input className="sr-only" name="username" value="admin" autoComplete="username" readOnly tabIndex={-1} />
            {error && (
              <Alert icon={<IconAlertCircle size={18} />} color="red" variant="light">
                {error}
              </Alert>
            )}
            <PasswordInput
              label="Admin password"
              placeholder="Enter your password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              autoFocus
              autoComplete="current-password"
              size="md"
              required
            />
            <Button type="submit" size="md" loading={loading} rightSection={<IconArrowRight size={18} />}>
              Enter dashboard
            </Button>
          </Stack>
        </Paper>
        <Text size="xs" c="dimmed" ta="center">
          Self-hosted. No cloud account required.
        </Text>
      </Container>
      <div className="threshold-art" aria-hidden="true"><span /></div>
    </main>
  )
}
