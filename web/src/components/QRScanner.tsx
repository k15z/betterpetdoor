import { useEffect, useRef, useState } from 'react'
import { Alert, AspectRatio, Button, Group, Stack } from '@mantine/core'
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
      {error && <Alert color="gray" variant="outline">{error}</Alert>}
      <Group justify="flex-end">
        {active ? (
          <Button variant="default" leftSection={<IconCameraOff size={16} />} onClick={stop}>Stop camera</Button>
        ) : (
          <Button variant="default" leftSection={<IconCamera size={16} />} onClick={start}>Scan QR</Button>
        )}
      </Group>
    </Stack>
  )
}
