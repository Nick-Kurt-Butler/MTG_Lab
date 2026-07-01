import { useRef, useEffect, useState } from 'react'
import { cardsIn } from '../game/state.js'
import { HumanPlayer } from '../game/player.js'

const T = {
  bg: '#040406', surface: '#0a0a10', surface2: '#0e0e16',
  goldDim: '#8a7030', gold: '#d4a843', goldBr: '#e8c45a',
  text: '#d4cabb', textMuted: '#7a7060',
  red: '#c03030', green: '#50a050', blue: '#5878b0',
}

function ManaText({ text }) {
  const parts = (text || '').replace(/\s*\((\d+)\)/g, '').split(/(\{[^}]+\})/)
  return <>{parts.map((part, i) => {
    const m = part.match(/^\{([^}]+)\}$/)
    if (m) return <i key={i} className={`ms ms-${m[1].toLowerCase()} ms-cost ms-shadow`} style={{ fontSize: 11, verticalAlign: 'middle', margin: '0 1px' }} />
    return <span key={i}>{part}</span>
  })}</>
}

// Check if the human player has any card actions available
function noOtherOptions(gs) {
  if (!gs?.players) return false
  const humanPid = (gs.players.p1 instanceof HumanPlayer) ? 'p1' : (gs.players.p2 instanceof HumanPlayer) ? 'p2' : null
  if (!humanPid) return false
  if (gs.priorityHolder !== humanPid) return false
  if (gs._pendingChoice) return false
  const hand = cardsIn(humanPid, 'hand')
  const battlefield = cardsIn(humanPid, 'battlefield')
  for (const card of [...hand, ...battlefield]) {
    if (card.actionable) return false
  }
  return true
}

export default function LogPanel({ log, gs, onPass, onPassAll, disabled, onExit, onSettings, combatDraft, onCombatSubmit, ui, onUiOk, onUiCancel }) {
  const endRef = useRef(null)
  const [hoverCard, setHoverCard] = useState(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [log?.length])

  const hasStack = gs?.stack?.length > 0
  const humanPid = gs?.players?.p1 instanceof HumanPlayer ? 'p1' : gs?.players?.p2 instanceof HumanPlayer ? 'p2' : null
  const myPriority = !!humanPid && gs?.priorityHolder === humanPid
  // You can pass priority whenever you hold it (Forge's plain-priority state),
  // even with an empty stack — Pass / Pass All live here by the stack.
  const canPass = myPriority && !disabled
  const canPassAll = canPass
  const onlyOption = !disabled && noOtherOptions(gs)

  // Combat declaration lock-in: the top-of-stack interactive control
  const combatTitle = ['declare_attackers', 'declare_blockers'].includes(gs?._pendingChoice?.title)
    ? gs._pendingChoice.title : null
  const draft = combatDraft || { attack: {}, block: {} }
  let combatLabel = null
  if (combatTitle === 'declare_attackers') {
    const n = Object.keys(draft.attack).length
    combatLabel = `DECLARE ${n} ATTACKER${n !== 1 ? 'S' : ''}`
  } else if (combatTitle === 'declare_blockers') {
    const n = Object.keys(draft.block).length
    combatLabel = `DECLARE ${n} BLOCKER${n !== 1 ? 'S' : ''}`
  }

  return (
    <div style={{
      width: '100%', display: 'flex', flexDirection: 'column',
      borderLeft: `1px solid ${T.gold}33`,
      background: `linear-gradient(180deg, ${T.bg} 0%, ${T.surface} 100%)`,
      height: '100%',
      fontFamily: "'Crimson Text', Georgia, serif",
    }}>

      {/* HEADER */}
      <div style={{
        padding: '8px 12px', borderBottom: `1px solid ${T.gold}33`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6,
        background: `linear-gradient(90deg, ${T.gold}08 0%, transparent 100%)`,
      }}>
        <span style={{ fontSize: 11, color: T.gold, fontFamily: 'Cinzel,serif', letterSpacing: 2 }}>LOG</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onSettings} title="Settings" style={{
            fontSize: 11, padding: '2px 8px', background: 'none',
            border: `1px solid ${T.gold}40`, color: T.textMuted, borderRadius: 3, cursor: 'pointer',
            fontFamily: 'Cinzel,serif',
          }}>⚙</button>
          <button onClick={onExit} style={{
            fontSize: 9, padding: '2px 8px', background: 'none',
            border: `1px solid ${T.gold}40`, color: T.textMuted, borderRadius: 3, cursor: 'pointer',
            fontFamily: 'Cinzel,serif',
          }}>EXIT</button>
        </div>
      </div>

      {/* LOG SECTION (now on top) */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {(log || []).map((line, i) => <LogEntry key={i} line={line} humanPid={humanPid} />)}
        <div ref={endRef} />
      </div>

      {/* STACK SECTION (now on bottom) */}
      <div style={{
        padding: '8px 12px 10px', flexShrink: 0,
        borderTop: `1px solid ${T.gold}33`,
        background: `linear-gradient(0deg, ${T.gold}06 0%, transparent 100%)`,
        maxHeight: '50%', overflowY: 'auto',
        position: 'relative',
      }}>
        <div style={{ fontSize: 10, color: T.gold, fontFamily: 'Cinzel,serif', letterSpacing: 2, marginBottom: 8, textAlign: 'center' }}>THE STACK</div>

        {/* Combat declaration lock-in (top-of-stack interactive control) */}
        {combatLabel && (
          <div onClick={onCombatSubmit} style={{
            fontSize: 10, padding: '7px 9px', marginBottom: 6, borderRadius: 3,
            background: 'rgba(255,255,255,0.12)', border: '1px solid #fff',
            color: '#fff', fontFamily: 'Cinzel,serif', letterSpacing: 0.8, textAlign: 'center',
            boxShadow: '0 0 14px rgba(255,255,255,0.5), inset 0 0 8px rgba(255,255,255,0.15)',
            cursor: 'pointer', transition: 'all 0.2s',
          }}>
            {combatLabel}
          </div>
        )}

        {hasStack ? (
          [...gs.stack].reverse().map((item, i) => {
            const isTop = i === 0
            const itemPid = item.card?.pid || item.pid
            const isYou = itemPid && itemPid === humanPid
            const isOpp = itemPid && itemPid !== humanPid
            const accentColor = isYou ? T.blue : isOpp ? T.red : T.gold
            return (
              <div key={i}
                onMouseEnter={() => setHoverCard(item.card)}
                onMouseLeave={() => setHoverCard(null)}
                style={{
                  fontSize: 10, padding: '5px 9px', marginBottom: 3, borderRadius: 3,
                  background: `${accentColor}12`, border: `1px solid ${accentColor}50`,
                  color: isTop ? T.text : T.textMuted,
                  fontFamily: 'Cinzel,serif', letterSpacing: 0.3,
                  boxShadow: `0 0 6px ${accentColor}40`,
                  opacity: isTop ? 1 : 0.7, transition: 'all 0.2s',
                }}>
                <ManaText text={item.name || item.log || 'Effect'} />
              </div>
            )
          })
        ) : (
          <div style={{ fontSize: 9, color: T.goldDim, fontStyle: 'italic', padding: '3px 9px', textAlign: 'center', marginBottom: 6 }}>— Empty —</div>
        )}

        {/* Pass / End-turn controls live in the bottom Options panel (PASS / END
            TURN / YIELD). The combat lock-in above stays here by the stack. */}

        {/* Hover card preview */}
        {hoverCard && hoverCard.imageUrl && (
          <div style={{
            position: 'fixed', right: 285, top: '50%', transform: 'translateY(-50%)',
            zIndex: 10000, pointerEvents: 'none',
          }}>
            <img src={hoverCard.imageUrl} alt={hoverCard.name} style={{ width: 200, borderRadius: 8, boxShadow: `0 8px 32px rgba(0,0,0,0.9), 0 0 20px ${T.gold}30` }} />
          </div>
        )}
      </div>
    </div>
  )
}

function LogEntry({ line, humanPid }) {
  if (line.startsWith('──')) {
    return <div style={{
      fontSize: 9, color: T.gold, textAlign: 'center', margin: '8px 0 4px',
      borderTop: `1px solid ${T.gold}30`, paddingTop: 5, letterSpacing: 1.5,
      fontFamily: 'Cinzel,serif',
    }}>{line.replace(/──/g, '').trim()}</div>
  }
  if (line.startsWith('—')) {
    return <div style={{
      fontSize: 8, color: T.goldDim, textAlign: 'center', margin: '4px 0 2px',
      letterSpacing: 1, fontFamily: 'Cinzel,serif',
    }}>{line.replace(/—/g, '').trim()}</div>
  }
  if (line.includes('🏆')) {
    return <div style={{
      fontSize: 11, color: T.green, textAlign: 'center', fontWeight: 600,
      margin: '6px 0', fontFamily: 'Cinzel,serif', letterSpacing: 1,
    }}>{line}</div>
  }

  // Parse [p1] or [p2] prefix
  const match = line.match(/^\[(p[12])\]\s*(.+)$/)
  if (match) {
    const pid = match[1]
    const text = match[2]
    const isYou = pid === humanPid
    const isPass = text === 'passes'

    if (isPass) {
      return <div style={{ fontSize: 8, color: '#3a3a3a', fontStyle: 'italic', textAlign: isYou ? 'right' : 'left' }}>
        {isYou ? 'You pass' : 'Opponent passes'}
      </div>
    }

    return (
      <div style={{ display: 'flex', justifyContent: isYou ? 'flex-end' : 'flex-start', margin: '1px 0' }}>
        <div style={{
          maxWidth: '88%', padding: '3px 8px', borderRadius: 6, fontSize: 10, lineHeight: 1.3,
          background: isYou ? `${T.blue}15` : `${T.red}15`,
          border: `1px solid ${isYou ? T.blue + '40' : T.red + '40'}`,
          color: T.text,
          borderBottomRightRadius: isYou ? 2 : 6,
          borderBottomLeftRadius: isYou ? 6 : 2,
        }}>
          <ManaText text={text} />
        </div>
      </div>
    )
  }

  return <div style={{ fontSize: 10, color: T.text, textAlign: 'center' }}><ManaText text={line} /></div>
}
