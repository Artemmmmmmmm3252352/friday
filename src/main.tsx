import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './index.css'
import FridayApp from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FridayApp />
  </StrictMode>,
)
