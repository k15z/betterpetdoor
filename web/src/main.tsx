import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createTheme, MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import './styles.css'
import App from './App'

const theme = createTheme({
  primaryColor: 'moss',
  colors: {
    moss: [
      '#eff8ed', '#dcebd8', '#b9d6b2', '#91bf87', '#70aa66',
      '#5c9d51', '#4d9144', '#3d7b35', '#336b2d', '#275d23',
    ],
  },
  fontFamily: '"Avenir Next", Avenir, "Segoe UI", sans-serif',
  headings: { fontFamily: '"Avenir Next", Avenir, "Segoe UI", sans-serif' },
  defaultRadius: 'md',
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <Notifications position="top-right" />
      <App />
    </MantineProvider>
  </StrictMode>,
)
