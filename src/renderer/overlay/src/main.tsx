import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../shared/styles.css'
import '../../shared/markdown.css'
import './overlay.css'
import { Overlay } from './Overlay'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Overlay />
  </StrictMode>
)
