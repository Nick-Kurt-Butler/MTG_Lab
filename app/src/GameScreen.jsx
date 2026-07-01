import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { connectBridge } from './engine/bridge.js'
import ForgeBattle from './battle/ForgeBattle.jsx'

// One setup screen for every matchup. The in-game UI (ForgeBattle) is identical
// for any seat — human or AI — so WLAN human-vs-human reuses it exactly; only
// the lobby differs. Modes (the bridge `start` control message):
//   • ai   — you (seat 0) vs the AI (seat 1)            [local, auto-starts]
//   • ai2  — AI vs AI; you spectate seat 0              [local, auto-starts]
//   • pvp  — two humans over WLAN; each picks own deck  [host starts once joined]

const T = {
  bg: '#040406', surface: '#0a0a10', surface2: '#0e0e16',
  gold: '#d4a843', goldBr: '#e8c45a', goldDim: '#8a7030',
  text: '#d4cabb', muted: '#7a7060', red: '#c03030', green: '#50a050', blue: '#5878b0',
}

const PRESETS = {
  'Mono Red (preset)': { Mountain: 24, 'Goblin Piker': 36 },
  'Mono Green (preset)': { Forest: 24, 'Grizzly Bears': 36 },
}
function loadDecks() {
  let saved = {}
  try { saved = JSON.parse(localStorage.getItem('mtg_decks') || '{}') } catch {}
  const usable = {}
  for (const [name, cards] of Object.entries(saved)) {
    if (cards && Object.values(cards).reduce((a, b) => a + b, 0) > 0) usable[name] = cards
  }
  return { ...usable, ...PRESETS }
}
const deckCount = cards => Object.values(cards || {}).reduce((a, b) => a + b, 0)

const EMPTY_UI = { message: '', ok: false, cancel: false, okLabel: 'OK', cancelLabel: 'Cancel', focusOk: false, mulligan: false, mulliganCount: 0, maxHandSize: 7, hasActions: true, selectables: [], weakly: [], highlighted: [], selInfo: [], weakInfo: [] }

export default function GameScreen({ wlan }) {
  const nav = useNavigate()
  const [decks] = useState(loadDecks)
  const names = Object.keys(decks)

  const [step, setStep] = useState('setup')      // setup | lobby | playing
  const [wlanRole, setWlanRole] = useState(null)  // host | join (wlan only)
  const [yourDeck, setYourDeck] = useState(names[0] || '')
  const [oppDeck, setOppDeck] = useState(names[1] || names[0] || '')
  const [hostIp, setHostIp] = useState('')

  const [status, setStatus] = useState('idle')
  const [lobby, setLobby] = useState({ filled: [], ip: null, deckNames: [] })
  const [snapshot, setSnapshot] = useState(null)
  const [ui, setUi] = useState(EMPTY_UI)
  const [prompt, setPrompt] = useState(null)
  const [mySeat, setMySeat] = useState(0)

  const seatRef = useRef(0)
  const connRef = useRef(null)
  const startPayloadRef = useRef(null)   // sent to start the match (auto for local, on button for host)
  const deckOnWelcomeRef = useRef(null)  // deck to announce on connect (WLAN: each seat picks own)
  const autoStartRef = useRef(false)
  const gotSnapshotRef = useRef(false)
  const retriesRef = useRef(0)
  const unmountedRef = useRef(false)

  useEffect(() => () => { unmountedRef.current = true; connRef.current?.close() }, [])

  const applyUi = useCallback(msg => {
    setUi(prev => {
      switch (msg.kind) {
        case 'message': return { ...prev, message: msg.message || '' }
        case 'reveal':  return { ...prev, message: msg.message || prev.message }
        case 'buttons': return { ...prev, ok: !!msg.ok, cancel: !!msg.cancel,
          okLabel: msg.okLabel || 'OK', cancelLabel: msg.cancelLabel || 'Cancel', focusOk: !!msg.focusOk, mulligan: !!msg.mulligan,
          mulliganCount: msg.mulliganCount ?? prev.mulliganCount, maxHandSize: msg.maxHandSize ?? prev.maxHandSize,
          hasActions: msg.hasActions ?? true }
        case 'selectables': return { ...prev, selectables: msg.cards || [], selInfo: msg.cardInfo || [] }
        case 'weaklySelectable': return { ...prev, weakly: msg.cards || [], weakInfo: msg.cardInfo || [] }
        case 'highlighted': return { ...prev, highlighted: msg.cards || [] }
        default: return prev
      }
    })
  }, [])

  const open = useCallback(target => {
    setStatus('connecting')
    connRef.current = connectBridge(target, {
      onOpen: () => setStatus('connected'),
      onClose: () => {
        setStatus('closed')
        if (!gotSnapshotRef.current && !unmountedRef.current && retriesRef.current < 40) {
          retriesRef.current += 1
          setTimeout(() => { if (!unmountedRef.current) open(target) }, 1500)
        }
      },
      onError: () => setStatus('closed'),
      onWelcome: seat => {
        seatRef.current = seat; setMySeat(seat)
        // Announce this seat's deck (WLAN: each human picks their own).
        if (deckOnWelcomeRef.current) connRef.current?.send({ type: 'control', action: 'deck', deck: deckOnWelcomeRef.current })
        // Local modes auto-start; the WLAN host starts manually once the guest joins.
        if (autoStartRef.current && seat === 0 && startPayloadRef.current) connRef.current?.send(startPayloadRef.current)
      },
      onLobby: msg => setLobby({ filled: msg.filled || [], ip: msg.ip || null, deckNames: msg.deckNames || [] }),
      onSnapshot: s => { gotSnapshotRef.current = true; setSnapshot(s); setStep('playing') },
      onUi: msg => { if (msg.seat == null || msg.seat === seatRef.current) applyUi(msg) },
      onPrompt: d => { if (d.seat == null || d.seat === seatRef.current) setPrompt(d) },
    })
  }, [applyUi])

  const deckObj = name => ({ name, cards: decks[name] })
  function prepConn() {
    unmountedRef.current = false; gotSnapshotRef.current = false; retriesRef.current = 0
    connRef.current?.close()
  }

  // Local play (vs AI or spectate AI vs AI): host configures both decks, auto-start.
  function beginLocal(mode) {
    if (!yourDeck) return
    deckOnWelcomeRef.current = null
    startPayloadRef.current = { type: 'control', action: 'start', mode, decks: [deckObj(yourDeck), deckObj(oppDeck)] }
    autoStartRef.current = true
    prepConn(); setWlanRole(null); setStep('lobby'); open('ws://127.0.0.1:8088')
  }
  // WLAN host: announce your deck, wait for a guest, then start (guest brings own deck).
  function hostWlan() {
    if (!yourDeck) return
    deckOnWelcomeRef.current = deckObj(yourDeck)
    startPayloadRef.current = { type: 'control', action: 'start', mode: 'pvp', decks: [deckObj(yourDeck)] }
    autoStartRef.current = false
    prepConn(); setWlanRole('host'); setStep('lobby'); open('ws://127.0.0.1:8088')
  }
  function hostStart() { if (startPayloadRef.current) connRef.current?.send(startPayloadRef.current) }
  // WLAN join: connect to the host, announce your deck; never sends start.
  function joinWlan() {
    if (!yourDeck) return
    deckOnWelcomeRef.current = deckObj(yourDeck)
    startPayloadRef.current = null
    autoStartRef.current = false
    prepConn(); setWlanRole('join'); setStep('lobby')
    open(`ws://${(hostIp.trim() || 'localhost')}:8088`)
  }

  const respond = useCallback((id, data) => { connRef.current?.respond(id, data); setPrompt(null) }, [])
  const action = useCallback((kind, fields) => { connRef.current?.action(kind, fields) }, [])
  function leave() { unmountedRef.current = true; connRef.current?.close(); nav('/') }
  function backToSetup() { unmountedRef.current = true; connRef.current?.close(); setStep('setup'); setStatus('idle'); setSnapshot(null); setUi(EMPTY_UI); setLobby({ filled: [], ip: null, deckNames: [] }) }

  if (step === 'playing' && snapshot) {
    return <ForgeBattle snapshot={snapshot} ui={ui} prompt={prompt} respond={respond} action={action} mySeat={mySeat} onExit={leave} />
  }
  return <Setup {...{ wlan, names, decks, yourDeck, setYourDeck, oppDeck, setOppDeck, hostIp, setHostIp,
    step, wlanRole, status, lobby, beginLocal, hostWlan, hostStart, joinWlan, nav, backToSetup }} />
}

// ── Setup / lobby screen ────────────────────────────────────────────────────

const btn = (primary, disabled) => ({
  fontFamily: 'Cinzel, serif', fontSize: 13, letterSpacing: 1, padding: '10px 22px',
  borderRadius: 7, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
  background: primary ? 'rgba(212,168,67,0.18)' : 'rgba(255,255,255,0.04)',
  border: `1px solid ${primary ? T.gold : T.goldDim}`, color: primary ? T.gold : T.text,
})
const wrap = {
  minHeight: '100vh', background: `radial-gradient(ellipse at 50% 0%, ${T.surface2}, ${T.bg} 70%)`,
  color: T.text, fontFamily: "'Crimson Text', Georgia, serif",
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, padding: 32,
}
const dot = i => ({ width: 10, height: 10, borderRadius: '50%', background: T.gold, animation: `afpulse 1.4s ease-in-out ${i * 0.2}s infinite` })
const inputStyle = { width: '100%', padding: '8px 10px', background: '#1a1a20', border: `1px solid ${T.goldDim}`, color: T.text, borderRadius: 6, fontSize: 13, outline: 'none', fontFamily: "'Crimson Text',serif" }

function DeckPicker({ label, names, decks, value, onChange }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const needle = q.trim().toLowerCase()
  const filtered = needle ? names.filter(n => n.toLowerCase().includes(needle)) : names
  return (
    <div style={{ marginBottom: 16, position: 'relative' }} ref={ref}>
      <div style={{ fontSize: 10, color: T.goldDim, fontFamily: 'Cinzel,serif', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>{label}</div>
      <button onClick={() => { setOpen(o => !o); setQ('') }} style={{
        width: 320, maxWidth: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        padding: '9px 12px', borderRadius: 7, cursor: 'pointer', textAlign: 'left',
        background: 'rgba(10,10,16,0.9)', border: `1px solid ${open ? T.gold : T.goldDim + '88'}`, color: T.text,
      }}>
        <span style={{ fontFamily: 'Cinzel,serif', fontSize: 13, color: value ? T.goldBr : T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {value || 'Select a deck…'}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {value && <span style={{ fontSize: 10, color: T.muted }}>{deckCount(decks[value])} cards</span>}
          <span style={{ color: T.goldDim, fontSize: 10 }}>{open ? '▲' : '▼'}</span>
        </span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', zIndex: 20, marginTop: 4, width: 320, maxWidth: '100%',
          background: T.surface2, border: `1px solid ${T.gold}66`, borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.6)', overflow: 'hidden',
        }}>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${names.length} decks…`}
            style={{ ...inputStyle, border: 'none', borderBottom: `1px solid ${T.goldDim}55`, borderRadius: 0, background: '#15151c' }} />
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {filtered.length === 0 && <div style={{ padding: '12px', color: T.muted, fontSize: 12, fontStyle: 'italic' }}>No decks match "{q}"</div>}
            {filtered.map(nm => (
              <div key={nm} className="deckrow" onClick={() => { onChange(nm); setOpen(false) }} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer',
                background: nm === value ? 'rgba(212,168,67,0.16)' : 'transparent',
                borderLeft: `2px solid ${nm === value ? T.gold : 'transparent'}`,
              }}>
                <span style={{ fontSize: 13, color: nm === value ? T.goldBr : T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nm}</span>
                <span style={{ fontSize: 10, color: T.muted, flexShrink: 0 }}>{deckCount(decks[nm])}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Panel({ children, width }) {
  return <div style={{ background: T.surface, border: `1px solid ${T.gold}33`, borderRadius: 12, padding: 22, maxWidth: width || 600 }}>{children}</div>
}

function Setup(p) {
  const { wlan, names, decks, yourDeck, setYourDeck, oppDeck, setOppDeck, hostIp, setHostIp,
    step, wlanRole, status, lobby, beginLocal, hostWlan, hostStart, joinWlan, nav, backToSetup } = p
  const css = `@keyframes afpulse{0%,100%{opacity:.3;transform:scale(.9)}50%{opacity:1;transform:scale(1.1)}}.deckrow:hover{background:rgba(212,168,67,0.10)!important}`
  const guestJoined = !!(lobby.filled && lobby.filled[1])
  const oppDeckName = (lobby.deckNames || [])[1]
  const hostDeckName = (lobby.deckNames || [])[0]

  // ── Lobby / connecting states ──
  if (step === 'lobby') {
    return (<div style={wrap}><style>{css}</style>
      <h1 style={{ fontFamily: 'Cinzel,serif', color: T.gold, letterSpacing: 4, fontSize: 24 }}>
        {wlanRole === 'host' ? 'HOSTING' : wlanRole === 'join' ? 'JOINING' : 'STARTING'}
      </h1>
      {wlanRole === 'host' ? (
        <Panel width={440}>
          <div style={{ marginBottom: 14, padding: '10px 12px', background: 'rgba(212,168,67,0.08)', border: `1px solid ${T.gold}44`, borderRadius: 8 }}>
            <div style={{ fontSize: 10, color: T.goldDim, fontFamily: 'Cinzel,serif', letterSpacing: 1, textTransform: 'uppercase' }}>Your LAN address — share with opponent</div>
            <div style={{ fontFamily: 'Cinzel,serif', color: T.goldBr, fontSize: 20, letterSpacing: 2, marginTop: 4 }}>{lobby.ip || 'detecting…'}</div>
          </div>
          <p style={{ color: guestJoined ? T.green : T.muted, fontSize: 14, marginBottom: 6 }}>
            {guestJoined ? `✓ Opponent joined${oppDeckName ? ` — playing ${oppDeckName}` : ' — choosing a deck…'}` : 'Waiting for an opponent to join…'}
          </p>
          {!(guestJoined && oppDeckName) && <div style={{ display: 'flex', gap: 10, margin: '10px 0 14px' }}>{[0, 1, 2].map(i => <div key={i} style={dot(i)} />)}</div>}
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <button onClick={hostStart} disabled={!(guestJoined && oppDeckName)} style={btn(true, !(guestJoined && oppDeckName))}>Start Match</button>
            <button onClick={backToSetup} style={btn(false, false)}>Cancel</button>
          </div>
        </Panel>
      ) : wlanRole === 'join' ? (
        <Panel width={440}>
          <p style={{ color: status === 'connected' ? T.green : T.muted, fontSize: 14, marginBottom: 10 }}>
            {status === 'connected'
              ? `✓ Connected${hostDeckName ? ` — host is playing ${hostDeckName}` : ''}. Waiting for the host to start…`
              : status === 'closed' ? 'Could not reach the host. Retrying…' : 'Connecting to host…'}
          </p>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>{[0, 1, 2].map(i => <div key={i} style={dot(i)} />)}</div>
          <button onClick={backToSetup} style={btn(false, false)}>Cancel</button>
        </Panel>
      ) : (
        <Panel width={440}>
          <p style={{ color: T.muted, fontSize: 13 }}>
            {status === 'connected' ? 'Connected. Dealing…' : 'Starting engine… (first launch loads the card database, ~20s)'}
          </p>
          <div style={{ display: 'flex', gap: 10, margin: '14px 0' }}>{[0, 1, 2].map(i => <div key={i} style={dot(i)} />)}</div>
          <button onClick={backToSetup} style={btn(false, false)}>Cancel</button>
        </Panel>
      )}
    </div>)
  }

  // ── WLAN setup: choose Host or Join (each player picks their OWN deck) ──
  if (wlan && !wlanRole) {
    return (<div style={wrap}><style>{css}</style>
      <h1 style={{ fontFamily: 'Cinzel,serif', color: T.gold, letterSpacing: 4, fontSize: 26 }}>WLAN GAME</h1>
      <p style={{ color: T.muted, fontStyle: 'italic', fontSize: 13, marginTop: -8 }}>Play another person on your network — same board UI, two humans.</p>
      <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'center' }}>
        {/* Host */}
        <Panel>
          <h2 style={{ fontFamily: 'Cinzel,serif', color: T.goldBr, fontSize: 16, letterSpacing: 2, marginTop: 0 }}>📡 Host</h2>
          <p style={{ color: T.muted, fontSize: 11, marginBottom: 12 }}>Pick your deck; your opponent joins by IP and brings their own.</p>
          <DeckPicker label="Your deck" names={names} decks={decks} value={yourDeck} onChange={setYourDeck} />
          <button onClick={hostWlan} disabled={!yourDeck} style={btn(true, !yourDeck)}>Create Game</button>
        </Panel>
        {/* Join */}
        <Panel>
          <h2 style={{ fontFamily: 'Cinzel,serif', color: T.goldBr, fontSize: 16, letterSpacing: 2, marginTop: 0 }}>🔗 Join</h2>
          <p style={{ color: T.muted, fontSize: 11, marginBottom: 12 }}>Enter the host's LAN IP and pick your deck.</p>
          <input value={hostIp} onChange={e => setHostIp(e.target.value)} placeholder="192.168.x.x" style={{ ...inputStyle, marginBottom: 14 }} />
          <DeckPicker label="Your deck" names={names} decks={decks} value={yourDeck} onChange={setYourDeck} />
          <button onClick={joinWlan} disabled={!yourDeck} style={btn(true, !yourDeck)}>Connect</button>
        </Panel>
      </div>
      <button onClick={() => nav('/')} style={btn(false, false)}>← Menu</button>
    </div>)
  }

  // ── Local setup: vs AI or spectate AI vs AI ──
  return (<div style={wrap}><style>{css}</style>
    <h1 style={{ fontFamily: 'Cinzel,serif', color: T.gold, letterSpacing: 4, fontSize: 26 }}>PLAY</h1>
    <Panel>
      <DeckPicker label="Your deck (seat 1)" names={names} decks={decks} value={yourDeck} onChange={setYourDeck} />
      <DeckPicker label="Opponent deck (seat 2)" names={names} decks={decks} value={oppDeck} onChange={setOppDeck} />
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
        <button onClick={() => beginLocal('ai')} disabled={!yourDeck} style={btn(true, !yourDeck)}>⚔ Play vs AI</button>
        <button onClick={() => beginLocal('ai2')} disabled={!yourDeck} style={btn(false, !yourDeck)}>👁 Watch AI vs AI</button>
        <button onClick={() => nav('/')} style={btn(false, false)}>← Menu</button>
      </div>
      <p style={{ color: T.muted, fontSize: 11, marginTop: 14, fontStyle: 'italic' }}>
        Decks come from the Deck Builder (saved locally), plus a couple of presets.
      </p>
    </Panel>
  </div>)
}
