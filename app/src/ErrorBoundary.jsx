import { Component } from 'react'

// Surfaces render-time crashes on screen instead of a black void (Electron's
// window has no visible console). Shows the message + component stack so we can
// see exactly what failed in the battle UI.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    this.setState({ info })
    // Also print to the renderer console (forwarded to the terminal by electron.cjs).
    console.error('[render-crash]', error, info?.componentStack)
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children
    return (
      <div style={{
        position: 'fixed', inset: 0, overflow: 'auto', padding: 24,
        background: '#0a0a10', color: '#d4cabb',
        fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, lineHeight: 1.5,
      }}>
        <div style={{ color: '#c03030', fontSize: 16, marginBottom: 12 }}>
          ⚠ The battle UI crashed while rendering
        </div>
        <div style={{ color: '#e8c45a', marginBottom: 8 }}>{String(error?.message || error)}</div>
        <pre style={{ whiteSpace: 'pre-wrap', color: '#7a7060', marginBottom: 16 }}>
          {error?.stack}
        </pre>
        {info?.componentStack && (
          <>
            <div style={{ color: '#8a7030', marginBottom: 4 }}>Component stack:</div>
            <pre style={{ whiteSpace: 'pre-wrap', color: '#7a7060' }}>{info.componentStack}</pre>
          </>
        )}
        <button onClick={() => location.reload()} style={{
          marginTop: 16, padding: '6px 14px', background: 'rgba(212,168,67,0.18)',
          border: '1px solid #d4a843', color: '#d4a843', borderRadius: 5, cursor: 'pointer',
        }}>Reload</button>
      </div>
    )
  }
}
