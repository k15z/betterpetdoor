export type Door = {
  id: string
  name: string
  provider: string
  created_at: string
}

export type DoorStatus = {
  state: string
  online: boolean | null
  open: boolean | null
  moving: boolean
  safe_to_close: boolean | null
  checked_at: string
}

type APIErrorBody = { error?: string }

export class APIError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const body = (await response.json()) as APIErrorBody
      if (body.error) message = body.error
    } catch {
      // Keep the status-based message for non-JSON errors.
    }
    throw new APIError(response.status, message)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const api = {
  session: () => request<{ authenticated: true }>('/api/session'),
  login: (password: string) =>
    request<{ authenticated: true }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  doors: () => request<{ doors: Door[] }>('/api/doors'),
  status: (id: string) => request<DoorStatus>(`/api/doors/${id}/status`),
  addDoor: (input: {
    name: string
    provider: 'wayzn'
    qr_payload: string
    email: string
    password: string
  }) =>
    request<Door>('/api/doors', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  command: (id: string, command: 'open' | 'close' | 'open-and-close') =>
    request<{ ok: true; command: string }>(`/api/doors/${id}/commands/${command}`, {
      method: 'POST',
    }),
  removeDoor: (id: string) => request<void>(`/api/doors/${id}`, { method: 'DELETE' }),
}
