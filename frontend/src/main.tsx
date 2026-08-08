import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// Some Android browsers keep their bottom controls permanently over the
// layout viewport. `visualViewport.height` is the portion that is actually
// visible above those controls, including when they never collapse.
function syncViewportHeight() {
  const viewport = window.visualViewport;
  document.documentElement.style.setProperty(
    '--filebox-viewport-height',
    `${viewport?.height ?? window.innerHeight}px`,
  );
}

syncViewportHeight();
window.addEventListener('resize', syncViewportHeight);
window.visualViewport?.addEventListener('resize', syncViewportHeight);
window.visualViewport?.addEventListener('scroll', syncViewportHeight);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
