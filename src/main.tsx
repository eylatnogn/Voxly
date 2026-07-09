import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useVoxlyStore } from './store'
import './styles.css'

// Debug/E2E handle: lets tests and support sessions inspect or seed state.
;(window as unknown as Record<string, unknown>).__voxlyStore = useVoxlyStore

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
