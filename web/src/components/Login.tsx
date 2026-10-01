import { FormEvent, useState } from 'react'
import { Alert, Button, Container, PasswordInput, Stack, Title } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'
import { api } from '../api'

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
      <Container size={380} className="login-shell">
        <form onSubmit={submit} className="login-form">
          <Stack>
            <Title order={1}>Pet doors</Title>
            <input className="sr-only" name="username" value="admin" autoComplete="username" readOnly tabIndex={-1} />
            {error && (
              <Alert icon={<IconAlertCircle size={17} />} color="gray" variant="outline">
                {error}
              </Alert>
            )}
            <PasswordInput
              label="Password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              autoFocus
              autoComplete="current-password"
              size="md"
              required
            />
            <Button type="submit" size="md" disabled={loading}>
              {loading ? 'Signing in' : 'Sign in'}
            </Button>
          </Stack>
        </form>
      </Container>
    </main>
  )
}
