import { useEffect, useMemo, useState } from 'react'
import Board from './Board.jsx'
import LogPanel from './LogPanel.jsx'
import { buildGs } from '../engine/adapter.js'
import { loadArt } from '../engine/artLoader.js'
import { STOP_GROUPS, loadStops, saveStops, stopKeys } from '../stops.js'

const T = { gold: '#d4a843', goldDim: '#8a7030', text: '#d4cabb', red: '#c03030' }
// Mana color letter -> Forge ManaAtom byte (for IGameController.useMana).
const MANA_BYTE = { W: 1, U: 2, B: 4, R: 8, G: 16, C: 32 }

// Full-screen battle = your MTG Lab board + log panel, driven by Forge.
// The adapter turns snapshot + ui + prompt into `gs`; clicks become Forge
// IGameController actions (DESIGN.md §13).
export default function ForgeBattle({ snapshot, ui, prompt, respond, action, sendControl, mySeat, onExit }) {
  const [art, setArt] = useState(null)
  const [combatDraft, setCombatDraft] = useState({ attack: {}, block: {}, order: {}, selected: null })
  const [showSettings, setShowSettings] = useState(false)
  // Arena-style stops. Auto-play is always on; these choose which steps the
  // engine stops at (all others are auto-passed server-side). Sent on mount and
  // whenever changed.
  const [stops, setStops] = useState(loadStops)
  useEffect(() => {
    saveStops(stops)
    if (sendControl) sendControl({ type: 'control', action: 'stops', stops: stopKeys(stops) })
  }, [stops, sendControl])
  function toggleStop(key) { setStops(s => ({ ...s, [key]: !s[key] })) }
  const [logWidth, setLogWidth] = useState(() => {
    try { const w = parseInt(localStorage.getItem('mtg_log_width')); if (w >= 180 && w <= 700) return w } catch {}
    return 270
  })
  useEffect(() => { loadArt().then(setArt) }, [])
  useEffect(() => { try { localStorage.setItem('mtg_log_width', String(logWidth)) } catch {} }, [logWidth])

  const gs = useMemo(
    () => buildGs(snapshot, ui, prompt, { mySeat, art, respond, action }),
    [snapshot, ui, prompt, art, mySeat, respond, action],
  )

  // Auto-play is handled entirely by the engine now: it auto-passes every step
  // that isn't a configured stop (see the Stops toggles / isUiSetToSkipPhase),
  // and only while the stack is empty — so responses are never skipped.

  // Clicking a selectable card → Forge selectCard. The adapter tagged the card's
  // single option with its id.
  function handleAction({ event }) {
    if (event && event._select && event._cardId != null) {
      action('selectCard', { cardId: event._cardId })
    }
  }

  const settings = { hoverEnlarge: true, autoComplete: false }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <Board gs={gs} onAction={handleAction} combatDraft={combatDraft} setCombatDraft={setCombatDraft} settings={settings}
          ui={ui} onUiOk={() => action('selectButtonOk')} onUiCancel={() => action('selectButtonCancel')}
          onUseMana={c => action('useMana', { color: MANA_BYTE[c] || 0 })}
          onSelectPlayer={id => action('selectPlayer', { playerId: id })} />
      </div>
      <LogDivider onDrag={dx => setLogWidth(w => Math.max(180, Math.min(700, w - dx)))} />
      <div style={{ width: logWidth, flexShrink: 0, overflow: 'hidden' }}>
        <LogPanel log={gs.log} gs={gs}
          onPass={() => action('passPriority')} onPassAll={() => action('passPriority')}
          disabled={!!gs._pendingChoice} combatDraft={combatDraft}
          onCombatSubmit={() => action('selectButtonOk')}
          ui={ui} onUiOk={() => action('selectButtonOk')} onUiCancel={() => action('selectButtonCancel')}
          onSettings={() => setShowSettings(s => !s)} onExit={onExit} />
      </div>
      {showSettings && (
        <div onClick={() => setShowSettings(false)} style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,0.4)' }}>
          <div onClick={e => e.stopPropagation()} style={{
            position: 'absolute', top: 44, right: 16, background: 'rgba(10,10,16,0.98)',
            border: `1px solid ${T.gold}66`, borderRadius: 8, padding: 14, minWidth: 240,
            boxShadow: '0 8px 30px rgba(0,0,0,0.8)', fontFamily: "'Crimson Text', Georgia, serif",
          }}>
            <div style={{ fontSize: 12, color: T.gold, fontFamily: 'Cinzel,serif', letterSpacing: 1, marginBottom: 4 }}>Stops</div>
            <div style={{ fontSize: 10, color: T.goldDim, marginBottom: 10, lineHeight: 1.4 }}>
              Auto-play is always on — the game stops only at the steps you enable (and never skips while something is on the stack).
            </div>
            <StopsRow stops={stops} onToggle={toggleStop} />
          </div>
        </div>
      )}
    </div>
  )
}

// Arena-style stop toggles: five little pills, one per phase group. Enabling one
// makes the game stop there (on either player's turn) instead of auto-passing.
function StopsRow({ stops, onToggle }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {STOP_GROUPS.map(g => {
        const on = !!stops[g.key]
        return (
          <button key={g.key} onClick={() => onToggle(g.key)} title={on ? 'Stop here' : 'Auto-pass here'} style={{
            fontSize: 10, padding: '5px 9px', borderRadius: 6, cursor: 'pointer', fontFamily: 'Cinzel,serif', letterSpacing: 0.5,
            background: on ? 'rgba(212,168,67,0.25)' : 'rgba(255,255,255,0.03)',
            border: `1px solid ${on ? T.gold : T.goldDim + '66'}`, color: on ? T.gold : T.text,
          }}>{g.label}</button>
        )
      })}
    </div>
  )
}

// A floating OK / Cancel + message bar driven by Forge's updateButtons /
// showPromptMessage. OK covers "pass priority", "confirm attackers/blockers",
// "done paying", etc.; Cancel backs out of the current input.
function PromptBar({ ui, onOk, onCancel }) {
  return (
    <div style={{
      position: 'absolute', left: '50%', bottom: 12, transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
      background: 'rgba(8,8,14,0.96)', border: `1px solid ${T.gold}66`, borderRadius: 8,
      boxShadow: `0 6px 24px rgba(0,0,0,0.7), 0 0 16px ${T.gold}22`,
      maxWidth: '80%', zIndex: 9000,
    }}>
      {ui.message && (
        <span style={{ fontSize: 11, color: T.text, fontFamily: "'Crimson Text', Georgia, serif", whiteSpace: 'pre-wrap' }}>
          {ui.message}
        </span>
      )}
      {ui.cancel && (
        <button onClick={onCancel} style={btn(false)}>{ui.cancelLabel || 'Cancel'}</button>
      )}
      {ui.ok && (
        <button onClick={onOk} style={btn(true)}>{ui.okLabel || 'OK'}</button>
      )}
    </div>
  )
}

function btn(primary) {
  return {
    fontSize: 11, padding: '6px 14px', borderRadius: 5, cursor: 'pointer',
    fontFamily: 'Cinzel, serif', letterSpacing: 1,
    background: primary ? 'rgba(212,168,67,0.18)' : 'rgba(255,255,255,0.04)',
    border: `1px solid ${primary ? T.gold : T.goldDim}`,
    color: primary ? T.gold : T.text,
  }
}

function LogDivider({ onDrag }) {
  function start(e) {
    e.preventDefault()
    let last = e.clientX
    const move = ev => { const d = ev.clientX - last; last = ev.clientX; if (d) onDrag(d) }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div onPointerDown={start} style={{
      width: 6, flexShrink: 0, cursor: 'ew-resize',
      background: 'linear-gradient(180deg, transparent, rgba(212,168,67,0.18), transparent)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ width: 2, height: 40, borderRadius: 2, background: 'rgba(212,168,67,0.4)' }} />
    </div>
  )
}
