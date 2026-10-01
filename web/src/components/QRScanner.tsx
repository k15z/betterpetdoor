import { useEffect, useRef, useState } from 'react'
import { Alert, AspectRatio, Button, Group, Stack, Text } from '@mantine/core'
import { IconCamera, IconCameraOff } from '@tabler/icons-react'
import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser'

export function QRScanner({ onScan }: { onScan: (value: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const mountedRef = useRef(true)
  const [active, setActive] = useState(false)
  const [error, setError] = useState('')

  async function start() {
    setError('')
    setActive(true)
    try {
      const reader = new BrowserQRCodeReader()
      const controls = await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } } },
        videoRef.current!,
        (result, _error, scannerControls) => {
        if (result) {
          scannerControls.stop()
          setActive(false)
          onScan(result.getText())
        }
      },
      )
      if (!mountedRef.current) {
        controls.stop()
        return
      }
      controlsRef.current = controls
    } catch {
      setActive(false)
      setError('Camera access failed. Check browser permission, or paste the QR contents below.')
    }
  }

  function stop() {
    controlsRef.current?.stop()
    controlsRef.current = null
    setActive(false)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controlsRef.current?.stop()
    }
  }, [])

  return (
    <Stack gap="sm">
      {active && (
        <AspectRatio ratio={4 / 3} className="scanner-frame">
          <video ref={videoRef} muted playsInline />
        </AspectRatio>
      )}
      {error && <Alert color="orange" variant="light">{error}</Alert>}
      <Group justify="space-between">
        <div>
          <Text fw={650} size="sm">Wayzn “Add New User” QR</Text>
          <Text size="xs" c="dimmed">The code is sent only to your own server.</Text>
        </div>
        {active ? (
          <Button variant="light" color="gray" leftSection={<IconCameraOff size={17} />} onClick={stop}>Stop</Button>
        ) : (
          <Button variant="light" leftSection={<IconCamera size={17} />} onClick={start}>Scan</Button>
        )}
      </Group>
    </Stack>
  )
}
