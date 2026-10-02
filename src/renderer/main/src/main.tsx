import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../shared/styles.css'
import { App } from './App'
import { initStore } from './store'

initStore()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
