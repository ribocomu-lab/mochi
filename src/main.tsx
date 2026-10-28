import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import MochiApp from './MochiApp'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MochiApp />
  </StrictMode>,
)
