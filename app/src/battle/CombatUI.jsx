import { useState, useEffect, useLayoutEffect, useRef } from 'react'

// Combat declaration (declare attackers / blockers) happens inline on the
// board via the combat draft — see Board.jsx. The only standalone combat
// overlays still used are the two ordering panels below.

const T = {
  bg: '#040406', surface: '#0a0a10', surface2: '#0e0e16',
  goldDim: '#8a7030', gold: '#d4a843', goldBr: '#e8c45a',
  text: '#d4cabb', textMuted: '#7a7060',
  red: '#c03030', green: '#50a050', blue: '#5878b0',
}

// ═══ ORDER TRIGGERS UI ═══
// Overlays the log panel (right sidebar). Stack-styled with blue/red hues by
// controller. Hover shows card preview. Reorder by dragging.
// Order shown top-to-bottom = resolution order (top resolves first).

export function OrderTriggersUI({ items, humanPid, onConfirm }) {
  const [order, setOrder] = useState(items.map(it => it.id))
  const [hoverCard, setHoverCard] = useState(null)
  const [dragId, setDragId] = useState(null)

  function handleDrop(targetId) {
    if (dragId == null || dragId === targetId) return
    const next = order.filter(id => id !== dragId)
    const idx = next.indexOf(targetId)
    next.splice(idx, 0, dragId)
    setOrder(next)
    setDragId(null)
  }

  function submit() {
    // UI shows top = resolves first. Stack pushes last = resolves first.
    // So push in reverse of displayed order.
    const displayed = order.map(id => items.find(it => it.id === id))
    onConfirm([...displayed].reverse())
  }

  return (
    <div style={{
      position: 'fixed', right: 0, top: 0, width: 270, height: '100%',
      background: 'rgba(6,6,10,0.97)', borderLeft: `2px solid ${T.gold}`,
      zIndex: 1500, display: 'flex', flexDirection: 'column',
      fontFamily: "'Crimson Text', Georgia, serif", boxShadow: `-8px 0 30px rgba(0,0,0,0.7)`,
    }}>
      <div style={{ padding: '12px', borderBottom: `1px solid ${T.gold}33`, textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: T.gold, fontFamily: 'Cinzel,serif', letterSpacing: 2 }}>ORDER TRIGGERS</div>
        <div style={{ fontSize: 8, color: T.textMuted, marginTop: 4 }}>Drag to reorder · top resolves first</div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
        {order.map((id, i) => {
          const it = items.find(x => x.id === id)
          const pid = it.card?.pid
          const isYou = pid === humanPid
          const accent = isYou ? T.blue : T.red
          return (
            <div key={id}
              draggable
              onDragStart={() => setDragId(id)}
              onDragOver={e => e.preventDefault()}
              onDrop={() => handleDrop(id)}
              onMouseEnter={() => setHoverCard(it.card)}
              onMouseLeave={() => setHoverCard(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 10, padding: '8px 9px', marginBottom: 4, borderRadius: 4,
                background: `${accent}15`, border: `1px solid ${accent}55`,
                boxShadow: `0 0 6px ${accent}40`, color: T.text,
                fontFamily: 'Cinzel,serif', cursor: 'grab',
                opacity: dragId === id ? 0.4 : 1, transition: 'opacity 0.15s',
              }}>
              <span style={{ color: accent, fontSize: 11, minWidth: 14 }}>{i + 1}</span>
              <span style={{ flex: 1 }}>{it.text}</span>
              <span style={{ color: T.textMuted, fontSize: 12 }}>⠿</span>
            </div>
          )
        })}
      </div>

      <div style={{ padding: '12px', borderTop: `1px solid ${T.gold}33` }}>
        <button onClick={submit} style={{
          width: '100%', padding: '8px', fontSize: 11, fontFamily: 'Cinzel,serif', letterSpacing: 1.5,
          background: `${T.gold}15`, border: `1px solid ${T.gold}`, color: T.gold,
          borderRadius: 5, cursor: 'pointer',
        }}>CONFIRM ORDER</button>
      </div>

      {hoverCard && hoverCard.imageUrl && (
        <div style={{ position: 'fixed', right: 285, top: '50%', transform: 'translateY(-50%)', zIndex: 10000, pointerEvents: 'none' }}>
          <img src={hoverCard.imageUrl} alt={hoverCard.name} style={{ width: 200, borderRadius: 8, boxShadow: `0 8px 32px rgba(0,0,0,0.9), 0 0 20px ${T.gold}30` }} />
        </div>
      )}
    </div>
  )
}

// ═══ ORDER BLOCKERS UI ═══
// Right-side panel (modeled on OrderTriggersUI). For each multi-blocked
// attacker, the active player drags its blockers into damage order
// (top = first damage). Confirm returns { [attackerUid]: [orderedBlockerUid] }.

export function OrderBlockersUI({ groups, gs, onConfirm }) {
  const [order, setOrder] = useState(() => {
    const o = {}
    for (const g of groups) o[g.attackerUid] = [...g.blockerUids]
    return o
  })
  const [hoverCard, setHoverCard] = useState(null)
  const dragRef = useState({ atk: null, id: null })[0]

  function handleDrop(atkUid, targetId) {
    if (dragRef.atk !== atkUid || dragRef.id == null || dragRef.id === targetId) return
    setOrder(prev => {
      const list = prev[atkUid].filter(id => id !== dragRef.id)
      const idx = list.indexOf(targetId)
      list.splice(idx, 0, dragRef.id)
      return { ...prev, [atkUid]: list }
    })
    dragRef.id = null
    dragRef.atk = null
  }

  return (
    <div style={{
      position: 'fixed', right: 0, top: 0, width: 280, height: '100%',
      background: 'rgba(6,6,10,0.97)', borderLeft: `2px solid ${T.gold}`,
      zIndex: 1500, display: 'flex', flexDirection: 'column',
      fontFamily: "'Crimson Text', Georgia, serif", boxShadow: `-8px 0 30px rgba(0,0,0,0.7)`,
    }}>
      <div style={{ padding: '12px', borderBottom: `1px solid ${T.gold}33`, textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: T.gold, fontFamily: 'Cinzel,serif', letterSpacing: 2 }}>ORDER BLOCKERS</div>
        <div style={{ fontSize: 8, color: T.textMuted, marginTop: 4 }}>Drag to set damage order · top takes damage first</div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
        {groups.map(g => {
          const atk = gs.cards[g.attackerUid]
          return (
            <div key={g.attackerUid} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: T.red, fontFamily: 'Cinzel,serif', letterSpacing: 0.5, marginBottom: 6 }}>
                ⚔ {atk?.name || 'Attacker'} ({atk?.power}/{atk?.toughness})
              </div>
              {(order[g.attackerUid] || []).map((bid, i) => {
                const blk = gs.cards[bid]
                if (!blk) return null
                return (
                  <div key={bid}
                    draggable
                    onDragStart={() => { dragRef.atk = g.attackerUid; dragRef.id = bid }}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => handleDrop(g.attackerUid, bid)}
                    onMouseEnter={() => setHoverCard(blk)}
                    onMouseLeave={() => setHoverCard(null)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      fontSize: 10, padding: '7px 9px', marginBottom: 4, borderRadius: 4,
                      background: `${T.blue}15`, border: `1px solid ${T.blue}55`,
                      boxShadow: `0 0 6px ${T.blue}30`, color: T.text,
                      fontFamily: 'Cinzel,serif', cursor: 'grab',
                    }}>
                    <span style={{ color: T.gold, fontSize: 11, minWidth: 14 }}>{i + 1}</span>
                    <span style={{ flex: 1 }}>{blk.name} ({blk.power}/{blk.toughness})</span>
                    <span style={{ color: T.textMuted, fontSize: 12 }}>⠿</span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      <div style={{ padding: '12px', borderTop: `1px solid ${T.gold}33` }}>
        <button onClick={() => onConfirm(order)} style={{
          width: '100%', padding: '8px', fontSize: 11, fontFamily: 'Cinzel,serif', letterSpacing: 1.5,
          background: `${T.gold}15`, border: `1px solid ${T.gold}`, color: T.gold,
          borderRadius: 5, cursor: 'pointer',
        }}>CONFIRM ORDER</button>
      </div>

      {hoverCard && hoverCard.imageUrl && (
        <div style={{ position: 'fixed', right: 295, top: '50%', transform: 'translateY(-50%)', zIndex: 10000, pointerEvents: 'none' }}>
          <img src={hoverCard.imageUrl} alt={hoverCard.name} style={{ width: 200, borderRadius: 8, boxShadow: `0 8px 32px rgba(0,0,0,0.9), 0 0 20px ${T.gold}30` }} />
        </div>
      )}
    </div>
  )
}

// ═══ COMBAT CONNECTION LINES ═══
// A tasteful alternative to badge icons. Draws soft Bézier "tethers" through the
// empty band between the two battlefields: red from each attacker to its target,
// blue from each blocker to the attacker it blocks. Anchored at card edges (never
// across faces), thin with a faint glow, multi-blocks fanned, fades in.

export function CombatLines({ boardRef, gs, draft, declMode, blockStep, attackDraft }) {
  const [lines, setLines] = useState([])
  const prev = useRef('')

  useLayoutEffect(() => {
    const board = boardRef?.current
    if (!board) { if (prev.current !== '') { prev.current = ''; setLines([]) } return }
    const origin = board.getBoundingClientRect()

    const rectOf = sel => {
      const el = board.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        cx: (r.left + r.right) / 2 - origin.left,
        top: r.top - origin.top,
        bottom: r.bottom - origin.top,
        cy: (r.top + r.bottom) / 2 - origin.top,
      }
    }
    const cardRect = uid => rectOf(`[data-uid="${uid}"]`)
    const defPid = gs.activePlayer === 'p1' ? 'p2' : 'p1'

    // Build an edge-to-edge curve that bows through the gap between the cards.
    const tether = (from, toX, toTop, toBottom, toCy, id, kind) => {
      const fromAbove = from.cy < toCy
      const x1 = from.cx, y1 = fromAbove ? from.bottom : from.top
      const x2 = toX, y2 = fromAbove ? toTop : toBottom
      const dy = y2 - y1
      const k = Math.max(22, Math.min(Math.abs(dy) * 0.45, 150)) * (dy >= 0 ? 1 : -1)
      return { id, kind, x2, y2, d: `M ${x1} ${y1} C ${x1} ${y1 + k} ${x2} ${y2 - k} ${x2} ${y2}` }
    }

    const out = []

    // Attacker → target (opponent's life bar, or a planeswalker card). During the
    // Forge attack draft we draw from the in-progress draft (before it's committed).
    const atkSrc = (declMode === 'declare_attackers' || attackDraft)
      ? (draft?.attack || {})
      : Object.fromEntries((gs.combat?.attackers || []).map(a => [a.uid, a.target]))
    for (const [uid, target] of Object.entries(atkSrc)) {
      const from = cardRect(uid); if (!from) continue
      if (target === 'player' || target === defPid) {
        const bar = rectOf(`[data-pbar="${defPid}"]`); if (!bar) continue
        out.push(tether(from, from.cx, bar.top, bar.bottom, bar.cy, `a:${uid}`, 'red'))
      } else {
        const to = cardRect(target); if (!to) continue
        out.push(tether(from, to.cx, to.top, to.bottom, to.cy, `a:${uid}>${target}`, 'red'))
      }
    }

    // Blocker → attacker, fanned so multi-blocks read as a neat splay. During the
    // Forge block step we draw from the in-progress draft (before it's committed).
    const blkSrc = (declMode === 'declare_blockers' || blockStep)
      ? (draft?.block || {})
      : Object.fromEntries((gs.combat?.blockers || []).map(b => [b.uid, b.blocking]))
    const byAttacker = {}
    for (const [b, a] of Object.entries(blkSrc)) (byAttacker[a] ||= []).push(b)
    for (const [a, blockers] of Object.entries(byAttacker)) {
      const atk = cardRect(a); if (!atk) continue
      blockers.forEach((b, i) => {
        const blk = cardRect(b); if (!blk) return
        const spread = (i - (blockers.length - 1) / 2) * 14
        out.push(tether(blk, atk.cx + spread, atk.top, atk.bottom, atk.cy, `b:${b}>${a}`, 'blue'))
      })
    }

    const sig = JSON.stringify(out)
    if (sig !== prev.current) { prev.current = sig; setLines(out) }
  })

  // Recompute on window resize (parent also re-renders on its tick).
  useEffect(() => {
    const onResize = () => { prev.current = '~' }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (!lines.length) return null
  const colorOf = k => (k === 'red' ? T.red : T.blue)

  return (
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 38 }}>
      <defs>
        <filter id="mtgLineGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
        <style>{`@keyframes mtgLineIn { from { opacity: 0 } to { opacity: 1 } }`}</style>
      </defs>
      {lines.map(l => {
        const col = colorOf(l.kind)
        return (
          <g key={l.id} style={{ animation: 'mtgLineIn 260ms ease-out' }}>
            <path d={l.d} fill="none" stroke={col} strokeOpacity="0.13" strokeWidth="5" strokeLinecap="round" filter="url(#mtgLineGlow)" />
            <path d={l.d} fill="none" stroke={col} strokeOpacity="0.6" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx={l.x2} cy={l.y2} r="2.6" fill={col} fillOpacity="0.8" />
          </g>
        )
      })}
    </svg>
  )
}
