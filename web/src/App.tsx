import { useEffect, useState } from 'react'
import { Center, Loader } from '@mantine/core'
import { api, APIError } from './api'
import { Dashboard } from './components/Dashboard'
import { Login } from './components/Login'

type AuthState = 'checking' | 'signed-out' | 'signed-in'

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('checking')

  useEffect(() => {
    api.session()
      .then(() => setAuthState('signed-in'))
      .catch((error: unknown) => {
        if (error instanceof APIError && error.status === 401) setAuthState('signed-out')
        else setAuthState('signed-out')
      })
  }, [])

  if (authState === 'checking') {
    return (
      <Center mih="100vh" className="page-surface">
        <Loader color="moss" />
      </Center>
    )
  }
  if (authState === 'signed-out') {
    return <Login onSignedIn={() => setAuthState('signed-in')} />
  }
  return <Dashboard onSignedOut={() => setAuthState('signed-out')} />
}
