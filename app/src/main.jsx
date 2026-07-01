import { createRoot } from 'react-dom/client'
// HashRouter (not BrowserRouter) so routing works when Electron loads the built
// app over file:// (path-based routing would 404 on reload under file://).
import { HashRouter, Routes, Route } from 'react-router-dom'
import Home from './Home.jsx'
import Forge from './Forge.jsx'
import GameScreen from './GameScreen.jsx'
import Lab from './Lab.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import './theme.css'

// Backstop for errors thrown outside React's render (event handlers, async),
// which a render error boundary can't catch — surface them instead of a black screen.
window.addEventListener('error', e => console.error('[window-error]', e.error || e.message))
window.addEventListener('unhandledrejection', e => console.error('[unhandled-rejection]', e.reason))

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/forge" element={<Forge />} />
        <Route path="/battle" element={<GameScreen wlan={false} />} />
        <Route path="/wlan" element={<GameScreen wlan={true} />} />
        <Route path="/lab" element={<Lab />} />
      </Routes>
    </HashRouter>
  </ErrorBoundary>
)
