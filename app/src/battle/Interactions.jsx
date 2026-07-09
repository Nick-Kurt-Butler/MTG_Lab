import { useState } from 'react'

// Renderers for the engine interactions that aren't card-targeting or combat:
// number entry (X costs), amount distribution (combat damage split / divide
// counters), ordering (triggers, scry), rearrange (manipulate), and insert.
// Each collects a valid answer and calls choice.submit(...) which the adapter
// wired to respond to the engine.

const T = {
  surface2: '#0e0e16', gold: '#d4a843', goldBr: '#e8c45a', goldDim: '#8a7030',
  text: '#d4cabb', muted: '#7a7060', green: '#50a050',
}
const overlay = { position: 'fixed', inset: 0, background: 'rgba(4,4,8,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, fontFamily: "'Crimson Text', Georgia, serif" }
const panel = { background: T.surface2, border: `1px solid ${T.gold}66`, borderRadius: 12, padding: 20, minWidth: 340, maxWidth: 560, maxHeight: '82vh', overflowY: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,0.7)' }
const titleS = { fontFamily: 'Cinzel,serif', color: T.gold, fontSize: 15, letterSpacing: 1, marginBottom: 12 }
const btn = (primary, disabled) => ({ fontFamily: 'Cinzel,serif', fontSize: 12, letterSpacing: 1, padding: '8px 18px', borderRadius: 6, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1, background: primary ? 'rgba(212,168,67,0.18)' : 'rgba(255,255,255,0.04)', border: `1px solid ${primary ? T.gold : T.goldDim}`, color: primary ? T.gold : T.text })
const step = { width: 26, height: 26, borderRadius: 6, border: `1px solid ${T.goldDim}`, background: 'rgba(255,255,255,0.05)', color: T.text, cursor: 'pointer', fontSize: 15 }

export default function InteractionOverlay({ choice }) {
  if (!choice) return null
  switch (choice.title) {
    case 'number': return <NumberPrompt choice={choice} />
    case 'assign_amount': return <AssignAmount choice={choice} />
    case 'order_list':
    case 'manipulate': return <OrderList choice={choice} />
    case 'insert': return <InsertPrompt choice={choice} />
    default: return null
  }
}

function NumberPrompt({ choice }) {
  const { min, max } = choice
  const [v, setV] = useState(min)
  const clamp = x => Math.max(min, Math.min(max, x))
  return (
    <div style={overlay}><div style={panel}>
      <div style={titleS}>{choice.prompt}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, justifyContent: 'center', margin: '8px 0 10px' }}>
        <button style={step} onClick={() => setV(clamp(v - 1))}>−</button>
        <span style={{ fontFamily: 'Cinzel,serif', color: T.goldBr, fontSize: 30, minWidth: 52, textAlign: 'center' }}>{v}</span>
        <button style={step} onClick={() => setV(clamp(v + 1))}>+</button>
      </div>
      <div style={{ fontSize: 10, color: T.muted, textAlign: 'center', marginBottom: 14 }}>range {min}–{max}</div>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <button style={btn(true)} onClick={() => choice.submit(v)}>Confirm</button>
      </div>
    </div></div>
  )
}

function AssignAmount({ choice }) {
  const opts = choice.options || []
  const ordered = !!choice.ordered
  const floor = choice.atLeastOne ? 1 : 0
  const [amts, setAmts] = useState(() => opts.map(() => floor))
  const total = amts.reduce((a, b) => a + b, 0)
  const remaining = choice.amount - total
  const set = (i, val) => setAmts(a => a.map((x, j) => (j === i ? Math.max(floor, val) : x)))
  // Lethal-first: in ordered (combat) mode you can't add to a row until every
  // earlier blocker already has at least its lethal damage. The defender row
  // (trample overflow) unlocks only once all blockers are lethal.
  const unlocked = i => {
    if (!ordered) return true
    for (let j = 0; j < i; j++) {
      if (opts[j].isDefender) continue
      if (amts[j] < (opts[j].lethal || 0)) return false
    }
    return true
  }
  const ok = total === choice.amount
  return (
    <div style={overlay}><div style={panel}>
      <div style={titleS}>{choice.prompt}</div>
      <div style={{ fontSize: 12, color: remaining === 0 ? T.green : T.gold, textAlign: 'center', marginBottom: 12 }}>
        {remaining === 0 ? 'All assigned' : `${remaining} left`} · {total}/{choice.amount}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
        {opts.map((o, i) => {
          const canAdd = remaining > 0 && unlocked(i)
          const short = ordered && !o.isDefender && amts[i] < (o.lethal || 0)
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '8px 12px', opacity: unlocked(i) ? 1 : 0.5 }}>
              <span style={{ color: o.isDefender ? T.gold : T.text, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {o.isDefender ? '🛡 ' : ''}{o.label}
                {!o.isDefender && o.lethal > 0 && (
                  <span style={{ fontSize: 10, color: short ? T.gold : T.green, marginLeft: 6 }}>lethal {o.lethal}</span>
                )}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button style={step} onClick={() => set(i, amts[i] - 1)}>−</button>
                <span style={{ fontFamily: 'Cinzel,serif', color: T.goldBr, fontSize: 18, minWidth: 28, textAlign: 'center' }}>{amts[i]}</span>
                <button style={{ ...step, opacity: canAdd ? 1 : 0.4 }} onClick={() => canAdd && set(i, amts[i] + 1)}>+</button>
              </span>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button style={btn(true, !ok)} onClick={() => ok && choice.submit(amts)}>Confirm</button>
        {choice.maySkip && <button style={btn(false)} onClick={() => choice.submit(opts.map(() => 0))}>Skip</button>}
      </div>
    </div></div>
  )
}

function OrderList({ choice }) {
  // A subset pick (scry: choose cards for the bottom; surveil: for the graveyard)
  // uses the two-pane mover; a plain order just reorders every card.
  if (choice.subset) return <MoveOrder choice={choice} />
  const opts = choice.options || []
  const [order, setOrder] = useState(() => opts.map((_, i) => i)) // opts-indices, top first
  const move = (pos, dir) => setOrder(o => {
    const n = [...o]; const t = pos + dir
    if (t < 0 || t >= n.length) return o
    ;[n[pos], n[t]] = [n[t], n[pos]]; return n
  })
  const topLabel = choice.toTop ? 'Top of library first' : (choice.top || 'Top resolves first')
  return (
    <div style={overlay}><div style={panel}>
      <div style={titleS}>{choice.prompt}</div>
      <div style={{ fontSize: 10, color: T.muted, marginBottom: 8 }}>{topLabel}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
        {order.map((idx, pos) => (
          <div key={opts[idx].id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '7px 10px' }}>
            <span style={{ color: T.gold, fontSize: 11, minWidth: 16 }}>{pos + 1}</span>
            <span style={{ flex: 1, color: T.text, fontSize: 13 }}>{opts[idx].label}</span>
            <button style={{ ...step, opacity: pos === 0 ? 0.4 : 1 }} onClick={() => move(pos, -1)}>▲</button>
            <button style={{ ...step, opacity: pos === order.length - 1 ? 0.4 : 1 }} onClick={() => move(pos, 1)}>▼</button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <button style={btn(true)} onClick={() => choice.submit(order, false)}>Confirm Order</button>
      </div>
    </div></div>
  )
}

// Two-pane subset picker + order. Left = cards left alone (scry: stay on top);
// right = the cards you move (scry: to the bottom, ordered top-to-bottom). Click
// to move a card across; reorder the right pile. Confirm submits the right pile's
// option indices, in order — exactly what the engine's `many`/scry expects.
function MoveOrder({ choice }) {
  const opts = choice.options || []
  const min = choice.min ?? 0
  const max = choice.max ?? opts.length
  const [dest, setDest] = useState([])          // opts-indices, in chosen order
  const inDest = new Set(dest)
  const source = opts.map((_, i) => i).filter(i => !inDest.has(i))
  const toDest = i => setDest(d => (d.length >= max ? d : [...d, i]))
  const toSource = i => setDest(d => d.filter(x => x !== i))
  const move = (pos, dir) => setDest(d => {
    const n = [...d]; const t = pos + dir
    if (t < 0 || t >= n.length) return d
    ;[n[pos], n[t]] = [n[t], n[pos]]; return n
  })
  const ok = dest.length >= min && dest.length <= max
  const destLabel = choice.top || 'Selected'
  const colStyle = { flex: 1, minWidth: 150, display: 'flex', flexDirection: 'column', gap: 5 }
  const rowStyle = { display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '7px 9px' }
  const emptyStyle = { fontSize: 10, color: T.muted, fontStyle: 'italic', padding: '10px 4px', textAlign: 'center' }
  const range = min === max ? `exactly ${min}` : `${min}–${max}`
  return (
    <div style={overlay}><div style={{ ...panel, minWidth: 420 }}>
      <div style={titleS}>{choice.prompt}</div>
      <div style={{ fontSize: 10, color: ok ? T.green : T.gold, marginBottom: 10 }}>
        {dest.length} chosen · need {range}
      </div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
        <div style={colStyle}>
          <div style={{ fontSize: 9, color: T.goldDim, fontFamily: 'Cinzel,serif', letterSpacing: 1, textTransform: 'uppercase' }}>Leave</div>
          {source.length === 0 && <div style={emptyStyle}>—</div>}
          {source.map(i => (
            <div key={opts[i].id} style={{ ...rowStyle, cursor: 'pointer' }} onClick={() => toDest(i)}>
              <span style={{ flex: 1, color: T.text, fontSize: 13 }}>{opts[i].label}</span>
              <span style={{ color: T.gold, fontSize: 13 }}>→</span>
            </div>
          ))}
        </div>
        <div style={colStyle}>
          <div style={{ fontSize: 9, color: T.goldDim, fontFamily: 'Cinzel,serif', letterSpacing: 1, textTransform: 'uppercase' }}>{destLabel}</div>
          {dest.length === 0 && <div style={emptyStyle}>click a card to move it here</div>}
          {dest.map((i, pos) => (
            <div key={opts[i].id} style={rowStyle}>
              <span style={{ color: T.gold, fontSize: 11, minWidth: 14 }}>{pos + 1}</span>
              <span style={{ flex: 1, color: T.text, fontSize: 13 }}>{opts[i].label}</span>
              <button style={{ ...step, opacity: pos === 0 ? 0.4 : 1 }} onClick={() => move(pos, -1)}>▲</button>
              <button style={{ ...step, opacity: pos === dest.length - 1 ? 0.4 : 1 }} onClick={() => move(pos, 1)}>▼</button>
              <button style={step} onClick={() => toSource(i)}>✕</button>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <button style={btn(true, !ok)} onClick={() => ok && choice.submit(dest, false)}>Confirm</button>
      </div>
    </div></div>
  )
}

function InsertPrompt({ choice }) {
  const opts = choice.options || []
  return (
    <div style={overlay}><div style={panel}>
      <div style={titleS}>{choice.prompt}</div>
      <div style={{ fontSize: 12, color: T.muted, marginBottom: 10 }}>Place “{choice.newItem}”:</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button style={btn(false)} onClick={() => choice.submit(0)}>↑ Before everything</button>
        {opts.map((o, i) => (
          <div key={o.id}>
            <div style={{ color: T.text, fontSize: 12, padding: '4px 10px' }}>{o.label}</div>
            <button style={btn(false)} onClick={() => choice.submit(i + 1)}>↓ After “{o.label}”</button>
          </div>
        ))}
      </div>
    </div></div>
  )
}

// Non-blocking display of cards the engine revealed to you (top of library,
// revealed hand, etc.). Dismissed locally — the engine already moved on.
export function RevealOverlay({ reveal, onDismiss }) {
  if (!reveal || !(reveal.options || []).length) return null
  return (
    <div style={overlay}><div style={panel}>
      <div style={titleS}>{reveal.message || 'Revealed'}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14, justifyContent: 'center' }}>
        {reveal.options.map((o, i) => (
          <div key={i} style={{ padding: '8px 12px', border: `1px solid ${T.goldDim}`, borderRadius: 8, color: T.text, fontSize: 12 }}>{(o.label || '').replace(/\s*\(\d+\)/g, '')}</div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <button style={btn(true)} onClick={onDismiss}>OK</button>
      </div>
    </div></div>
  )
}
