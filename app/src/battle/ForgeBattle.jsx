import { useEffect, useMemo, useState } from 'react'
import Board from './Board.jsx'
import LogPanel from './LogPanel.jsx'
import { buildGs } from '../engine/adapter.js'
import { loadArt } from '../engine/artLoader.js'

const T = { gold: '#d4a843', goldDim: '#8a7030', text: '#d4cabb', red: '#c03030' }
// Mana color letter -> Forge ManaAtom byte (for IGameController.useMana).
const MANA_BYTE = { W: 1, U: 2, B: 4, R: 8, G: 16, C: 32 }

// Full-screen battle = your MTG Lab board + log panel, driven by Forge.
// The adapter turns snapshot + ui + prompt into `gs`; clicks become Forge
// IGameController actions (DESIGN.md §13).
export default function ForgeBattle({ snapshot, ui, prompt, respond, action, mySeat, onExit }) {
  const [art, setArt] = useState(null)
  const [combatDraft, setCombatDraft] = useState({ attack: {}, block: {}, order: {}, selected: null })
  const [showSettings, setShowSettings] = useState(false)
  const [autoPass, setAutoPass] = useState(() => {
    try { return localStorage.getItem('mtg_auto_pass') !== '0' } catch { return true }
  })
  useEffect(() => { try { localStorage.setItem('mtg_auto_pass', autoPass ? '1' : '0') } catch {} }, [autoPass])
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

  // Auto-pass: Forge itself tells us whether you have any action other than
  // passing (`hasActions`, computed at priority — it excludes pointless mana taps).
  // When you don't, and auto-pass is on, we pass for you. This works on either
  // player's turn (no turn/label gating). We don't auto-pass a mulligan, a combat
  // declaration, or while an Undo is offered (so a just-played land keeps its undo
  // window), and a blocking prompt (Channel A) is handled separately. hasActions
  // defaults to true when unknown, so we never pass blindly.
  // Auto-pass: Forge tells us (`hasActions`) whether you have any play other than
  // passing, and labels the pass-priority button "End Turn" on either player's turn
  // (mulligan="Mulligan", combat="Alpha Strike", a pending land-undo="Undo (N)" —
  // none of which we auto-pass). When it's a plain priority pass with no plays and
  // auto-pass is on, we pass for you. We depend on `ui` (a fresh object per message)
  // so this re-arms every time priority returns across phases — not only when the
  // boolean flips value.
  const cancelLbl = ui?.cancelLabel || ''
  const isPriorityPass = /end turn/i.test(cancelLbl)
  const canAutoPass = !!(autoPass && ui && ui.ok && ui.hasActions === false && isPriorityPass && !prompt)
  useEffect(() => {
    if (!canAutoPass) return
    const t = setTimeout(() => action('selectButtonOk'), 200)
    return () => clearTimeout(t)
  }, [canAutoPass, ui, action])

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
          onUseMana={c => action('useMana', { color: MANA_BYTE[c] || 0 })} />
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
            <div style={{ fontSize: 12, color: T.gold, fontFamily: 'Cinzel,serif', letterSpacing: 1, marginBottom: 10 }}>Settings</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: T.text }}>
              <input type="checkbox" checked={autoPass} onChange={e => setAutoPass(e.target.checked)} style={{ accentColor: T.gold }} />
              Auto-pass when you have no plays
            </label>
            <div style={{ fontSize: 10, color: T.goldDim, marginTop: 6, lineHeight: 1.4 }}>
              Automatically passes priority during steps where you can't do anything (you keep control whenever you have a play).
            </div>
          </div>
        </div>
      )}
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
