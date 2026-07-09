import { useState, useRef, useEffect, useCallback } from 'react'
import { cardsIn } from '../game/state.js'
import { canBlock } from '../game/actions.js'
import { HumanPlayer } from '../game/player.js'
import { OrderTriggersUI, OrderBlockersUI, CombatLines } from './CombatUI'
import InteractionOverlay, { RevealOverlay } from './Interactions.jsx'
import { fetchTokenImage } from './tokenArt'

const MTG_BACK = 'https://backs.scryfall.io/large/59/b/59b15dba-3a0e-4b44-a34e-4e498e494c7c.jpg?1698702067'
const CARD_RATIO = 0.715 // width / height

const T = {
  bg:        '#040406',
  surface:   '#0a0a10',
  surface2:  '#0e0e16',
  goldDim:   '#8a7030',
  gold:      '#d4a843',
  goldBr:    '#e8c45a',
  text:      '#d4cabb',
  textMuted: '#7a7060',
  red:       '#c03030',
  green:     '#50a050',
  blue:      '#5878b0',
  silver:    '#cdd2dc',
}

const COMBAT_TITLES = new Set(['declare_attackers', 'declare_blockers', 'order_blockers'])
// Pending-choice kinds that render as a full-screen modal (so the hover preview
// must be suppressed — otherwise it floats above and hides the popup).
const MODAL_TITLES = new Set(['number', 'assign_amount', 'order_list', 'manipulate', 'insert', 'order_blockers', 'order_triggers'])

// ═══ PERSISTENCE ═══

const SIZES_KEY = 'mtg_board_sizes'

function loadSizes() {
  try {
    const s = JSON.parse(localStorage.getItem(SIZES_KEY))
    if (s && s.opp && s.player && s.hand) return s
  } catch {}
  return { opp: 1, player: 1, hand: 0.95 }
}

// ═══ HOOKS ═══

// Measures an element's content box (width/height) via ResizeObserver.
// Uses a callback ref so the observer reattaches if the DOM node changes.
function useSize() {
  const [size, setSize] = useState({ w: 0, h: 0 })
  const obs = useRef(null)
  const ref = useCallback(node => {
    if (obs.current) { obs.current.disconnect(); obs.current = null }
    if (node) {
      const ro = new ResizeObserver(entries => {
        const cr = entries[0].contentRect
        setSize({ w: cr.width, h: cr.height })
      })
      ro.observe(node)
      obs.current = ro
      // Seed an immediate measurement (ResizeObserver's first callback is async)
      const r = node.getBoundingClientRect()
      setSize({ w: r.width, h: r.height })
    }
  }, [])
  return [ref, size]
}

// Mana / symbol renderer. Handles both {W} and Forge's [W] bracket form, maps
// special codes to mana-font classes (T -> tap, Q -> untap), and strips '/' from
// hybrids so {W/U} -> ms-wu.
function symClass(raw) {
  let c = (raw || '').toLowerCase().replace(/\//g, '')
  if (c === 't') c = 'tap'
  else if (c === 'q') c = 'untap'
  return `ms ms-${c} ms-cost ms-shadow`
}
function ManaText({ text }) {
  const parts = (text || '').replace(/\s*\((\d+)\)/g, '').split(/(\{[^}]+\}|\[[^\]]+\])/)
  return <>{parts.map((part, i) => {
    const m = part.match(/^[{[]([^}\]]+)[}\]]$/)
    if (m) return <i key={i} className={symClass(m[1])} style={{ fontSize: 12, verticalAlign: 'middle', margin: '0 1px' }} />
    return <span key={i}>{part}</span>
  })}</>
}

function ManaPool({ pool, onUse }) {
  const entries = Object.entries(pool).filter(([, v]) => v > 0)
  if (!entries.length) return <span style={{ fontSize: 9, color: T.textMuted, fontStyle: 'italic' }}>—</span>
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      {entries.flatMap(([c, v]) =>
        Array.from({ length: v }).map((_, i) => (
          <i key={`${c}${i}`} className={`ms ms-${c.toLowerCase()} ms-cost ms-shadow`}
            onClick={onUse ? e => { e.stopPropagation(); onUse(c) } : undefined}
            title={onUse ? `Spend ${c} from pool` : undefined}
            style={{ fontSize: 13, cursor: onUse ? 'pointer' : 'default', filter: onUse ? `drop-shadow(0 0 3px ${T.gold})` : 'none' }} />
        ))
      )}
    </span>
  )
}

// ═══ TURN / PHASE / PRIORITY BAR ═══
// A compact visual replacement for the old "Priority/Turn/Phase/Stack" text line.
const PHASES = [
  ['Untap', 'Untap step — your permanents untap.'],
  ['Upkeep', 'Upkeep step — "at the beginning of upkeep" triggers happen.'],
  ['Draw', 'Draw step — the active player draws a card.'],
  ['Main 1', 'Pre-combat main phase — play lands and cast spells/sorceries.'],
  ['Combat', 'Combat phase — declare attackers, then blockers, then damage.'],
  ['Main 2', 'Post-combat main phase — play lands and cast spells/sorceries.'],
  ['End', 'End step & cleanup — end-of-turn triggers, discard to hand size.'],
]
function phaseIndex(raw) {
  const p = (raw || '').toLowerCase()
  if (p.includes('untap')) return 0
  if (p.includes('upkeep')) return 1
  if (p.includes('draw')) return 2
  if (p.includes('main')) return p.includes('post') ? 5 : 3
  if (p.includes('combat')) return 4
  if (p.includes('end') || p.includes('cleanup')) return 6
  return -1
}
function PhaseBar({ gs }) {
  const humanPid = (gs.players?.p1 instanceof HumanPlayer) ? 'p1' : (gs.players?.p2 instanceof HumanPlayer) ? 'p2' : 'p1'
  const yourTurn = gs.activePlayer === humanPid
  const cur = phaseIndex(gs.phaseRaw)
  const turnColor = yourTurn ? T.blue : T.red
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '3px 10px', flexShrink: 0,
      borderBottom: `1px solid ${T.gold}33`, background: `linear-gradient(90deg, ${turnColor}14, transparent)`,
      fontFamily: 'Cinzel,serif',
    }}>
      <span style={{ fontSize: 10, color: turnColor, letterSpacing: 1, whiteSpace: 'nowrap', fontWeight: 600 }}>
        ● {yourTurn ? 'YOUR TURN' : "OPPONENT'S TURN"} · T{gs.turn || 0}
      </span>
      <div style={{ display: 'flex', gap: 2, flex: 1, justifyContent: 'center' }}>
        {PHASES.map((ph, i) => (
          <span key={i} title={ph[1]} style={{
            fontSize: 8.5, padding: '2px 7px', borderRadius: 3, letterSpacing: 0.5, cursor: 'help',
            whiteSpace: 'nowrap',
            background: i === cur ? T.gold : 'rgba(255,255,255,0.04)',
            color: i === cur ? '#000' : T.textMuted,
            border: `1px solid ${i === cur ? T.gold : 'transparent'}`,
            fontWeight: i === cur ? 700 : 400,
          }}>{ph[0]}</span>
        ))}
      </div>
    </div>
  )
}

// Compute the card height that fills a zone vertically, shrinking if the row
// would overflow the zone width. Tapped cards occupy a wider (rotated) footprint.
function cardHeightFor(cards, zoneW, zoneH, gap = 3) {
  if (!cards.length || !zoneH || !zoneW) return Math.max(50, Math.min(zoneH || 90, 130))
  let h = Math.max(46, zoneH - 16) // small reserve for the badge bar below each card
  const footprintPerH = cards.reduce((s, c) => s + (c.tapped ? 1 : CARD_RATIO), 0)
  const widthAtH = h * footprintPerH + gap * (cards.length + 1)
  if (widthAtH > zoneW) {
    h = Math.max(40, (zoneW - gap * (cards.length + 1)) / footprintPerH)
  }
  return Math.min(h, 260)
}

// ═══ BOARD ═══

export default function Board({ gs: gameState, onAction, combatDraft, setCombatDraft, settings, ui, onUiOk, onUiCancel, onUseMana, onSelectPlayer }) {
  const [selectedCard, setSelectedCard] = useState(null)
  const [zoneViewer, setZoneViewer] = useState(null)
  const [targetCard, setTargetCard] = useState(null)
  const [preview, setPreview] = useState(null)
  const [revealSeen, setRevealSeen] = useState(null)  // last dismissed reveal key
  const [, forceUpdate] = useState(0)

  const [sizes, setSizes] = useState(loadSizes)

  const boardRef = useRef(null)

  const [oppRef, oppSize] = useSize()
  const [playerRef, playerSize] = useSize()
  const [handRef, handSize] = useSize()

  useEffect(() => { try { localStorage.setItem(SIZES_KEY, JSON.stringify(sizes)) } catch {} }, [sizes])

  const draft = combatDraft || { attack: {}, block: {}, order: {}, selected: null }

  if (!gameState?.players) return null
  const revealKey = gameState._reveal ? `${gameState._reveal.message}:${(gameState._reveal.options || []).length}` : null
  const p1 = gameState.players.p1
  const p2 = gameState.players.p2
  const humanPid = (p1 instanceof HumanPlayer) ? 'p1' : (p2 instanceof HumanPlayer) ? 'p2' : null
  const pendingChoice = gameState._pendingChoice
  const isTargeting = pendingChoice?.title === 'select_target'
  const declMode = pendingChoice && COMBAT_TITLES.has(pendingChoice.title) ? pendingChoice.title : null
  // Forge's InputBlock declare-blockers step (Channel B, no pendingChoice): you
  // click attackers to choose which to block, then your creatures to block it.
  const blockStep = !!gameState._blockStep
  // A full-screen modal (interaction overlay / reveal / zone viewer) is open.
  // The hover preview (z-index 10000) is hidden while one is, so it can never
  // cover a popup and trap you (the reported glitch).
  const modalOpen = !!(zoneViewer || (gameState._reveal && revealKey !== revealSeen) || (pendingChoice && MODAL_TITLES.has(pendingChoice.title)))

  const activePid = gameState.activePlayer
  const defPid = activePid === 'p1' ? 'p2' : 'p1'
  const inCombatPhase = gameState.phase === 'combat'
  // A real engine sub-flow (mana payment, etc.) — distinct from plain priority,
  // whose cancel button is labelled "End Turn".
  const subFlow = !!(ui && ui.cancel && !/end turn/i.test(ui.cancelLabel || ''))
  // A card is a "candidate" for the current selection if the engine marked it
  // clickable (Channel B) or it matches the active target filter (Channel A).
  // Used to light up / enable zone buttons wherever the candidate lives.
  const isCandidate = card => !!(card && (card.actionable || (isTargeting && pendingChoice?.filter && pendingChoice.filter(card))))

  // Sort by _uiOrder if set, otherwise stable order from cardsIn
  const sortByOrder = list => list.slice().sort((a, b) => (a._uiOrder ?? 1e9) - (b._uiOrder ?? 1e9))
  const p1Battlefield = sortByOrder(cardsIn('p1', 'battlefield'))
  const p2Battlefield = sortByOrder(cardsIn('p2', 'battlefield'))
  const p1Hand = sortByOrder(cardsIn('p1', 'hand'))

  // ── Combat helpers ──
  const validCombatIds = declMode === 'declare_attackers' || declMode === 'declare_blockers'
    ? new Set(pendingChoice.options.map(o => o.id))
    : new Set()
  const attackerUids = new Set(gameState.combat?.attackers?.map(a => a.uid) || [])
  // Forge declare-attackers step. The silver→target→red draft only engages when
  // the opponent has planeswalkers to choose between; otherwise attackers just
  // auto-target the player on a single click (unchanged).
  const attackStep = !!gameState._attackStep
  const hasAltDefenders = attackStep && cardsIn(defPid, 'battlefield').some(c => c.isPlaneswalker)
  const attackDraft = attackStep && hasAltDefenders

  function setDraft(updater) {
    if (setCombatDraft) setCombatDraft(prev => updater(prev || { attack: {}, block: {}, order: {}, selected: null }))
  }

  const hoverEnlarge = settings?.hoverEnlarge !== false
  function handlePreview(url, rect) {
    if (!url) return
    const PW = 230, PH = Math.round(PW / CARD_RATIO)
    let x = rect.right + 12
    if (x + PW > window.innerWidth - 4) x = rect.left - PW - 12
    if (x < 4) x = Math.max(4, window.innerWidth - PW - 4)
    let y = rect.top + rect.height / 2 - PH / 2
    y = Math.max(4, Math.min(y, window.innerHeight - PH - 4))
    setPreview({ url, x, y })
  }

  // ── Attacker target label (shown above an attacking card) ──
  function attackTargetLabel(card) {
    let t = null
    if (declMode === 'declare_attackers') t = draft.attack[card.uid]
    else {
      const atk = (gameState.combat?.attackers || []).find(a => a.uid === card.uid)
      t = atk?.target
    }
    if (t == null) return null
    if (t === 'player' || t === defPid) return gameState.players[defPid].name
    return gameState.cards[t]?.name || null
  }

  // ── Divider drag: transfer flex between two adjacent sections ──
  function dragSections(keyA, keyB, sizeA, sizeB, dyPx) {
    setSizes(prev => {
      const fA = prev[keyA], fB = prev[keyB]
      const pxPerFlex = (sizeA.h + sizeB.h) / (fA + fB || 1)
      if (!pxPerFlex || !isFinite(pxPerFlex)) return prev
      let df = dyPx / pxPerFlex
      const nA = Math.max(0.2, fA + df)
      const nB = Math.max(0.2, fB - df)
      return { ...prev, [keyA]: nA, [keyB]: nB }
    })
  }

  // Reorder within hand/battlefield (drag-and-drop)
  function reorder(fromUid, toUid) {
    const from = gameState.cards[fromUid]
    const to = gameState.cards[toUid]
    if (!from || !to || from.zone !== to.zone || from.pid !== to.pid) return
    const zoneCards = sortByOrder(cardsIn(from.pid, from.zone))
    const filtered = zoneCards.filter(c => c.uid !== fromUid)
    const toIdx = filtered.findIndex(c => c.uid === toUid)
    filtered.splice(toIdx, 0, from)
    filtered.forEach((c, i) => { c._uiOrder = i })
    forceUpdate(n => n + 1)
  }

  // ── Card click router ──
  function handleCardClick(card, e) {
    e.stopPropagation()
    if (declMode === 'declare_attackers') return handleAttackerClick(card)
    if (declMode === 'declare_blockers') return handleBlockerClick(card)
    if (declMode === 'order_blockers') return
    // Declare attackers with alternate defenders (planeswalkers): blocker-style
    // draft. Arm your attacker (silver), then click a planeswalker (or the
    // opponent's life bar) to target it (red + line). With no planeswalker the
    // draft is skipped and a single click auto-targets the player (below).
    if (attackDraft) {
      const isDefender = card.pid === defPid && card.isPlaneswalker
      setDraft(prev => {
        const attack = { ...prev.attack }
        if (isDefender) {
          if (prev.selected == null) return prev
          attack[prev.selected] = card.uid
          return { ...prev, attack, selected: null }
        }
        if (!card.actionable) return { ...prev, selected: null }   // not a legal attacker
        if (attack[card.uid] != null) { delete attack[card.uid]; return { ...prev, attack, selected: null } }
        return { ...prev, selected: prev.selected === card.uid ? null : card.uid }
      })
      return
    }
    // Declare blockers (Forge InputBlock): blocker-first draft. Click one of your
    // legal blockers to arm it (silver), then click an attacker to assign the
    // block (blue + connecting line). Click an armed blocker again to disarm, or
    // an assigned blocker to unassign. Nothing is sent to Forge until you confirm.
    if (blockStep) {
      const isAttacker = attackerUids.has(card.uid)
      setDraft(prev => {
        const block = { ...prev.block }
        if (isAttacker) {
          if (prev.selected == null) return prev
          const armed = gameState.cards[prev.selected]
          if (armed && !canBlock(card, armed)) return prev   // illegal (e.g. flying)
          block[prev.selected] = card.uid
          return { ...prev, block, selected: null }
        }
        if (!card.actionable) return { ...prev, selected: null }   // not a legal blocker
        if (block[card.uid] != null) { delete block[card.uid]; return { ...prev, block, selected: null } }
        return { ...prev, selected: prev.selected === card.uid ? null : card.uid }
      })
      return
    }
    // Targeting mode (select_target)
    if (isTargeting) {
      if (pendingChoice.filter && pendingChoice.filter(card)) setTargetCard(card)
      return
    }
    // An ability menu is open → clicking another card switches straight to it
    // (no Cancel button); clicking a card with no options just declines + shows it.
    if (pendingChoice && pendingChoice.cancel) {
      pendingChoice.cancel()
      if (card.actionable) { const cid = card._id; setTimeout(() => onAction({ type: 'action', event: { _select: true, _cardId: cid } }), 60) }
      else setSelectedCard({ card, options: [] })
      return
    }
    if (pendingChoice) return
    // Mana payment / other sub-flow: only actionable (e.g. a land) clicks matter.
    if (subFlow) { if (card.actionable) onAction({ type: 'action', event: { _select: true, _cardId: card._id } }); return }
    // Idle: an actionable card opens its options; anything else just shows "no actions".
    if (card.actionable) { setSelectedCard(null); onAction({ type: 'action', event: { _select: true, _cardId: card._id } }); return }
    setSelectedCard({ card, options: [] })
  }

  function handleAttackerClick(card) {
    setDraft(prev => {
      // Armed + clicked an opponent planeswalker → assign it as the target
      if (prev.selected != null && card.pid === defPid && card.isPlaneswalker) {
        return { ...prev, attack: { ...prev.attack, [prev.selected]: card.uid }, selected: null }
      }
      const attack = { ...prev.attack }
      if (attack[card.uid] != null) { delete attack[card.uid]; return { ...prev, attack, selected: null } }
      if (validCombatIds.has(card.uid)) return { ...prev, selected: prev.selected === card.uid ? null : card.uid }
      return { ...prev, selected: null } // clicked something irrelevant → disarm
    })
  }

  function handleBlockerClick(card) {
    setDraft(prev => {
      // Clicking an attacker assigns the armed blocker to it
      if (attackerUids.has(card.uid)) {
        if (prev.selected == null) return prev
        const blocker = gameState.cards[prev.selected]
        if (!canBlock(card, blocker)) return prev  // illegal (e.g. flying) — ignore
        return { ...prev, block: { ...prev.block, [prev.selected]: card.uid }, selected: null }
      }
      const block = { ...prev.block }
      if (block[card.uid] != null) { delete block[card.uid]; return { ...prev, block, selected: null } }
      if (validCombatIds.has(card.uid)) return { ...prev, selected: prev.selected === card.uid ? null : card.uid }
      return { ...prev, selected: null }
    })
  }

  function handlePlayerCombatTarget(pid) {
    setDraft(prev => {
      if (prev.selected == null) return prev
      return { ...prev, attack: { ...prev.attack, [prev.selected]: 'player' }, selected: null }
    })
  }

  function handleTargetConfirm() { if (pendingChoice?.pick) { pendingChoice.pick(targetCard); setTargetCard(null) } }
  function handleTargetSkip() { if (pendingChoice?.pick) { pendingChoice.pick(null); setTargetCard(null) } }

  // Commit the attacker draft (planeswalker targeting) to Forge, then confirm.
  // Forge declares each attacker against the "current defender" (default: the
  // player), so we declare all player-targeted attackers first, then switch the
  // defender to each planeswalker and declare its attackers. OK locks them in.
  function handleConfirmAttackers() {
    const attack = draft.attack || {}
    const playerAtks = []
    const byPw = {}
    for (const [atkUid, target] of Object.entries(attack)) {
      if (target === 'player') playerAtks.push(atkUid)
      else (byPw[target] ||= []).push(atkUid)
    }
    const select = uid => { const c = gameState.cards[uid]; if (c) onAction({ type: 'action', event: { _select: true, _cardId: c._id } }) }
    for (const a of playerAtks) select(a)
    for (const [pwUid, atks] of Object.entries(byPw)) {
      select(pwUid)               // switch current defender to this planeswalker
      for (const a of atks) select(a)
    }
    setDraft(prev => ({ ...prev, attack: {}, selected: null }))
    if (onUiOk) onUiOk()
  }

  // Commit the block draft to Forge, then confirm. Forge's InputBlock assigns a
  // blocker to the "current" attacker, so per attacker we select it first, then
  // each of its blockers; finally OK locks the blocks in.
  function handleConfirmBlocks() {
    const block = draft.block || {}
    const byAttacker = {}
    for (const [b, a] of Object.entries(block)) (byAttacker[a] ||= []).push(b)
    for (const [atkUid, blockerUids] of Object.entries(byAttacker)) {
      const atk = gameState.cards[atkUid]
      if (atk) onAction({ type: 'action', event: { _select: true, _cardId: atk._id } })
      for (const bUid of blockerUids) {
        const b = gameState.cards[bUid]
        if (b) onAction({ type: 'action', event: { _select: true, _cardId: b._id } })
      }
    }
    setDraft(prev => ({ ...prev, block: {}, selected: null }))
    if (onUiOk) onUiOk()
  }

  function cardHasActions(card) {
    if (pendingChoice) return false
    return !!card.actionable
  }
  function isTargetable(card) { return isTargeting && pendingChoice.filter && pendingChoice.filter(card) }
  function isPlayerTargetable(pid) {
    if (isTargeting) return pendingChoice.filter && pendingChoice.filter({ isPlayer: true, pid, name: gameState.players[pid].name })
    // Channel-B targeting: any player is clickable; Forge validates and rejects
    // an illegal choice (e.g. a hexproof player), flashing rather than erroring.
    return !!gameState._targeting
  }
  function handlePlayerTargetClick(pid) {
    if (isTargeting) { if (isPlayerTargetable(pid)) setTargetCard({ isPlayer: true, pid, name: gameState.players[pid].name }); return }
    // Channel-B: send the player target straight to Forge (no confirm step, same
    // as clicking a creature target).
    if (gameState._targeting && onSelectPlayer) {
      onSelectPlayer(pid === 'p1' ? gameState._myPlayerId : gameState._oppPlayerId)
    }
  }
  function handleOptionClick(event) { setSelectedCard(null); onAction({ type: 'action', event }) }
  function handleChoiceClick(option) { if (pendingChoice?.pick) pendingChoice.pick(option) }

  // Combat-specific per-card visual state
  function combatStateFor(card) {
    if (declMode === 'declare_attackers') {
      if (draft.attack[card.uid] != null) return { connected: true, color: T.red }   // target chosen → red
      if (draft.selected === card.uid) return { armed: true, color: T.gold }         // clicked → gold (no raise)
      if (card.pid === defPid && card.isPlaneswalker) return { target: true }        // attackable planeswalker
      // Legal-but-unselected attacker → gold "available" glow.
      if (card.pid === activePid && validCombatIds.has(card.uid)) return { selectable: true, color: T.gold }
      // Dim anything irrelevant: my permanents that can't attack, and opponent
      // permanents that can't block and aren't planeswalkers.
      if (card.pid === activePid && !validCombatIds.has(card.uid)) return { dim: true }
      if (card.pid === defPid && !(card.validBlocker && card.validBlocker())) return { dim: true }
      return null
    }
    if (declMode === 'declare_blockers') {
      const armed = draft.selected != null ? gameState.cards[draft.selected] : null
      if (attackerUids.has(card.uid)) {
        // While a blocker is armed, show which attackers it may legally block.
        if (armed) return canBlock(card, armed)
          ? { selectable: true, color: T.green }
          : { illegal: true, color: T.textMuted }
        return { connected: true, color: T.red }
      }
      if (draft.block[card.uid] != null) return { connected: true, color: T.blue }
      if (draft.selected === card.uid) return { lifted: true, color: T.gold }
      if (validCombatIds.has(card.uid)) return { selectable: true, color: T.gold }
      return null
    }
    // Forge declare-blockers step (blocker-first draft): valid blocker glows
    // gold, armed blocker turns silver, and once assigned to an attacker it turns
    // blue (with a blue connecting line). While a blocker is armed, attackers it
    // may legally block glow green.
    if (blockStep) {
      if (attackerUids.has(card.uid)) {
        const armed = draft.selected != null ? gameState.cards[draft.selected] : null
        if (armed) return canBlock(card, armed)
          ? { selectable: true, color: T.green }
          : { illegal: true, color: T.textMuted }
        return { connected: true, color: T.red }
      }
      if (draft.block[card.uid] != null) return { connected: true, color: T.blue }
      if (draft.selected === card.uid) return { connected: true, color: T.silver }
      if (card.actionable) return { selectable: true, color: T.gold }
      return null
    }
    // Forge declare-attackers draft (planeswalker targeting): your legal attacker
    // glows gold, armed turns silver, and once aimed at a defender turns red
    // (with a red line). While an attacker is armed, the opponent's planeswalkers
    // light up gold as valid targets.
    if (attackDraft) {
      if (card.pid === activePid) {
        if (draft.attack[card.uid] != null) return { connected: true, color: T.red }
        if (draft.selected === card.uid) return { connected: true, color: T.silver }
        if (card.actionable) return { selectable: true, color: T.gold }
        return null
      }
      if (card.pid === defPid && card.isPlaneswalker) {
        if (Object.values(draft.attack).includes(card.uid)) return { connected: true, color: T.red }
        if (draft.selected != null) return { selectable: true, color: T.gold }
        return null
      }
      return null
    }
    // Committed combat highlights (resolve step etc.)
    if (inCombatPhase) {
      if (attackerUids.has(card.uid)) return { connected: true, color: T.red }
      if ((gameState.combat?.blockers || []).some(b => b.uid === card.uid)) return { connected: true, color: T.blue }
    }
    return null
  }

  // ── Renders one battlefield zone. Cards fill height; combat is conveyed via
  //    per-card highlights + badge icons (no special layout). ──
  function renderBattlefield(cards, side, zoneRef, zoneSize) {
    const cardH = cardHeightFor(cards, zoneSize.w, zoneSize.h)
    const labelColor = side === 'opp' ? T.red : T.blue
    const combatActive = !!declMode || inCombatPhase
    return (
      <div style={{ flex: 1, display: 'flex', minHeight: 40, position: 'relative', overflow: 'hidden' }}>
        <div style={{ flexShrink: 0, width: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{
            transform: 'rotate(-90deg)', whiteSpace: 'nowrap',
            fontSize: 8, color: labelColor + 'aa', fontFamily: 'Cinzel,serif',
            letterSpacing: 2, textTransform: 'uppercase', textAlign: 'center',
          }}>Battlefield</div>
        </div>
        <div ref={zoneRef} style={{ flex: 1, display: 'flex', gap: 3, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', padding: '1px 3px 1px 0' }}>
          {cards.map(card => (
            <CardSlot key={card.uid} card={card} fixedH={cardH}
              onClick={e => handleCardClick(card, e)}
              selected={selectedCard?.card?.uid === card.uid}
              targetable={isTargetable(card)}
              targeted={targetCard?.uid === card.uid}
              dimmed={isTargeting && !isTargetable(card)}
              attacking={attackerUids.has(card.uid)}
              combat={combatActive ? combatStateFor(card) : null}
              actionable={card.actionable}
              onPreview={hoverEnlarge ? handlePreview : undefined}
              onPreviewEnd={hoverEnlarge ? () => setPreview(null) : undefined}
              draggable={!isTargeting && card.pid === humanPid && side === 'you'}
              onDrop={reorder} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div ref={boardRef} style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: `radial-gradient(ellipse at 50% 40%, ${T.surface2} 0%, ${T.bg} 70%)`,
      fontFamily: "'Crimson Text', Georgia, serif",
      position: 'relative',
    }} onClick={() => { if (pendingChoice && pendingChoice.cancel) pendingChoice.cancel(); setSelectedCard(null) }}>

      {/* TURN / PHASE / PRIORITY BAR (visual status) */}
      <PhaseBar gs={gameState} />

      {/* OPPONENT STATS BAR */}
      <PlayerBar player={p2} pid="p2" gs={gameState} side="opp"
        targetable={isPlayerTargetable('p2')}
        targeted={targetCard?.isPlayer && targetCard.pid === 'p2'}
        combatTarget={(declMode === 'declare_attackers' || attackDraft) && defPid === 'p2' && draft.selected != null}
        onCombatTarget={() => handlePlayerCombatTarget('p2')}
        onTargetClick={() => handlePlayerTargetClick('p2')}
        candidate={isCandidate}
        onZone={z => setZoneViewer({ zone: z, pid: 'p2' })} />

      {/* OPPONENT BATTLEFIELD */}
      <div style={{ flex: sizes.opp, display: 'flex', minHeight: 40, borderBottom: `1px solid ${T.gold}1a`, overflow: 'hidden' }}>
        {renderBattlefield(p2Battlefield, 'opp', oppRef, oppSize)}
      </div>

      {/* DIVIDER (drag to resize) */}
      <Divider onDrag={dy => dragSections('opp', 'player', oppSize, playerSize, dy)} />

      {/* PLAYER BATTLEFIELD */}
      <div style={{ flex: sizes.player, display: 'flex', minHeight: 40, overflow: 'hidden' }}>
        {renderBattlefield(p1Battlefield, 'you', playerRef, playerSize)}
      </div>

      {/* PLAYER STATS BAR */}
      <PlayerBar player={p1} pid="p1" gs={gameState} side="you"
        targetable={isPlayerTargetable('p1')}
        targeted={targetCard?.isPlayer && targetCard.pid === 'p1'}
        combatTarget={(declMode === 'declare_attackers' || attackDraft) && defPid === 'p1' && draft.selected != null}
        onCombatTarget={() => handlePlayerCombatTarget('p1')}
        onTargetClick={() => handlePlayerTargetClick('p1')}
        onUseMana={subFlow ? onUseMana : undefined}
        candidate={isCandidate}
        onZone={z => setZoneViewer({ zone: z, pid: 'p1' })} />

      {/* DIVIDER (player battlefield <-> hand) */}
      <Divider onDrag={dy => dragSections('player', 'hand', playerSize, handSize, dy)} />

      {/* HAND */}
      <div style={{
        flex: sizes.hand, display: 'flex', minHeight: 40, overflow: 'hidden',
        borderTop: `1px solid ${T.gold}33`,
        background: `linear-gradient(0deg, ${T.gold}08 0%, transparent 100%)`,
      }}>
        <div style={{ flexShrink: 0, width: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{
            transform: 'rotate(-90deg)', whiteSpace: 'nowrap',
            fontSize: 8, color: T.goldDim, fontFamily: 'Cinzel,serif',
            letterSpacing: 2, textTransform: 'uppercase', textAlign: 'center',
          }}>Hand</div>
        </div>
        <div ref={handRef} style={{ flex: 1, display: 'flex', gap: 3, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', padding: '1px 3px 1px 0' }}>
          {p1Hand.map(card => (
            <CardSlot key={card.uid} card={card} fixedH={cardHeightFor(p1Hand, handSize.w, handSize.h)}
              onClick={e => handleCardClick(card, e)}
              selected={selectedCard?.card?.uid === card.uid}
              targetable={isTargetable(card)}
              targeted={targetCard?.uid === card.uid}
              dimmed={isTargeting && !isTargetable(card)}
              actionable={card.actionable}
              onPreview={hoverEnlarge ? handlePreview : undefined}
              onPreviewEnd={hoverEnlarge ? () => setPreview(null) : undefined}
              draggable={!declMode && !isTargeting} onDrop={reorder} />
          ))}
        </div>
      </div>

      {/* OPTIONS PANEL (persistent bottom bar) */}
      <OptionsPanel selectedCard={selectedCard} pendingChoice={pendingChoice}
        targetCard={targetCard} humanPid={humanPid} isActive={activePid === humanPid} mulligan={gameState.mulligan}
        mulliganTo={(gameState.maxHandSize || 7) - (gameState.mulliganCount || 0) - 1}
        blockStep={blockStep} channelBTargeting={gameState._targeting} targetPrompt={gameState._targetPrompt}
        ui={ui} onUiOk={onUiOk} onUiCancel={onUiCancel}
        onOptionClick={handleOptionClick} onChoiceClick={handleChoiceClick}
        onConfirmBlocks={handleConfirmBlocks} onConfirmAttackers={handleConfirmAttackers}
        onTargetConfirm={handleTargetConfirm} onTargetSkip={handleTargetSkip} />

      {/* ZONE VIEWER MODAL */}
      {zoneViewer && <ZoneViewerModal zone={zoneViewer.zone} pid={zoneViewer.pid} gs={gameState}
        filter={card => (isTargeting && pendingChoice.filter && pendingChoice.filter(card)) || !!card.actionable}
        onPick={card => {
          if (isTargeting) setTargetCard(card)
          else if (card.actionable) onAction({ type: 'action', event: { _select: true, _cardId: card._id } })
          setZoneViewer(null)
        }}
        onClose={() => setZoneViewer(null)} />}

      {/* ORDER TRIGGERS UI */}
      {pendingChoice?.title === 'order_triggers' && (
        <OrderTriggersUI
          items={pendingChoice.options}
          humanPid={humanPid}
          onConfirm={chosen => { if (pendingChoice.pick) pendingChoice.pick(chosen) }}
        />
      )}

      {/* ORDER BLOCKERS UI (resolve combat — multi-blocked attackers) */}
      {pendingChoice?.title === 'order_blockers' && (
        <OrderBlockersUI
          groups={pendingChoice.options}
          gs={gameState}
          onConfirm={map => { if (pendingChoice.pick) pendingChoice.pick(map) }}
        />
      )}

      {/* NUMBER / ASSIGN-AMOUNT / ORDER / MANIPULATE / INSERT interactions */}
      <InteractionOverlay choice={pendingChoice} />

      {/* REVEALED CARDS (non-blocking; dismissed locally) */}
      {gameState._reveal && revealKey !== revealSeen && (
        <RevealOverlay reveal={gameState._reveal} onDismiss={() => setRevealSeen(revealKey)} />
      )}

      {/* COMBAT CONNECTION LINES */}
      <CombatLines boardRef={boardRef} gs={gameState} draft={draft} declMode={declMode} blockStep={blockStep} attackDraft={attackDraft} />

      {/* HOVER CARD PREVIEW (hidden while a modal is open so it can't cover it) */}
      {preview && !modalOpen && (
        <img src={preview.url} alt="" draggable={false} style={{
          position: 'fixed', left: preview.x, top: preview.y, width: 230,
          borderRadius: 10, zIndex: 10000, pointerEvents: 'none',
          border: `1px solid ${T.gold}`, boxShadow: `0 8px 40px rgba(0,0,0,0.9), 0 0 24px ${T.gold}40`,
        }} />
      )}
    </div>
  )
}

// ═══ DIVIDERS ═══

// Generic draggable horizontal divider. Distinguishes a click from a drag.
function Divider({ onDrag, height = 8 }) {
  function start(e) {
    e.preventDefault()
    let last = e.clientY
    const move = ev => { const d = ev.clientY - last; last = ev.clientY; if (d) onDrag(d) }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div onPointerDown={start} style={{
      height, flexShrink: 0, cursor: 'ns-resize',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `linear-gradient(90deg, transparent, ${T.gold}10, transparent)`,
    }}>
      <div style={{ width: 40, height: 2, borderRadius: 2, background: `${T.gold}40` }} />
    </div>
  )
}

// ═══ PLAYER STATS BAR ═══

function PlayerBar({ player, pid, gs, side, onZone, targetable, targeted, onTargetClick, combatTarget, onCombatTarget, barRef, onUseMana, candidate }) {
  const isOpp = side === 'opp'
  const isActive = gs.activePlayer === pid
  const hasPriority = !!player.hasPriority
  const lifeColor = player.life <= 5 ? T.red : player.life <= 10 ? T.gold : T.green
  const accentColor = isOpp ? T.red : T.blue
  const clickable = targetable || combatTarget
  const highlight = targeted || combatTarget

  return (
    <div ref={el => barRef && barRef(pid, el)}
      data-pbar={pid}
      onClick={clickable ? (targetable ? onTargetClick : onCombatTarget) : undefined} style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '6px 14px',
        background: highlight ? `${T.red}20` : `linear-gradient(90deg, ${accentColor}10 0%, transparent 50%, ${accentColor}10 100%)`,
        borderTop: highlight ? `2px solid ${T.red}` : hasPriority ? `2px solid ${T.gold}` : `1px solid ${accentColor}30`,
        borderBottom: highlight ? `2px solid ${T.red}` : hasPriority ? `2px solid ${T.gold}` : `1px solid ${accentColor}30`,
        boxShadow: highlight ? `inset 0 0 20px ${T.red}40` : clickable ? `inset 0 0 16px ${T.red}25` : hasPriority ? `inset 0 0 20px ${T.gold}15` : 'none',
        cursor: clickable ? 'pointer' : 'default',
        flexShrink: 0, transition: 'all 0.2s', position: 'relative', zIndex: 42,
      }}>
      {/* Active indicator */}
      <div style={{ width: 12, display: 'flex', justifyContent: 'center' }}>
        {isActive && <div title="Active player" style={{ width: 7, height: 7, borderRadius: '50%', background: T.gold, boxShadow: `0 0 6px ${T.gold}` }} />}
      </div>

      {/* Name */}
      <span style={{ fontFamily: 'Cinzel,serif', fontSize: 12, color: accentColor, letterSpacing: 1, fontWeight: 500, minWidth: 80 }}>{player.name}</span>

      {/* Priority badge */}
      {hasPriority && (
        <span style={{ fontSize: 8, color: T.gold, padding: '2px 6px', borderRadius: 3, background: `${T.gold}15`, border: `1px solid ${T.gold}50`, fontFamily: 'Cinzel,serif', letterSpacing: 1 }}>PRIORITY</span>
      )}

      {/* Life */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: 7, color: T.textMuted, fontFamily: 'Cinzel,serif', letterSpacing: 1 }}>LIFE</span>
        <span style={{ fontSize: 16, color: lifeColor, fontFamily: 'Cinzel,serif', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{player.life}</span>
      </div>

      {/* Mana pool */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: 7, color: T.textMuted, fontFamily: 'Cinzel,serif', letterSpacing: 1 }}>MANA</span>
        <ManaPool pool={player.manaPool} onUse={onUseMana} />
      </div>

      {/* Zones */}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
        {(() => {
          const cand = candidate || (() => false)
          // A candidate sitting in a zone lights that zone's button (either
          // player). Your own hand is shown on the board, so its button only
          // becomes active when a hidden selection needs the hand viewer.
          const handCand = cardsIn(pid, 'hand').some(cand)
          const libCand = cardsIn(pid, 'library').some(cand)
          const gyCand = cardsIn(pid, 'graveyard').some(cand)
          const exCand = cardsIn(pid, 'exile').some(cand)
          return <>
            <ZoneBtn label="Hand" count={cardsIn(pid, 'hand').length} icon="✋" mono
              onClick={handCand ? () => onZone('hand') : () => {}} highlight={handCand} />
            <ZoneBtn label="Library" count={player.libraryOrder.length} icon="📖" mono
              onClick={() => onZone('library')} disabled={isOpp && !libCand} highlight={libCand} />
            <ZoneBtn label="Graveyard" count={cardsIn(pid, 'graveyard').length} icon="✝"
              onClick={() => onZone('graveyard')} highlight={gyCand} />
            <ZoneBtn label="Exile" count={cardsIn(pid, 'exile').length} icon="⊘"
              onClick={() => onZone('exile')} highlight={exCand} />
          </>
        })()}
      </div>
    </div>
  )
}

function ZoneBtn({ label, count, icon, onClick, mono, disabled, highlight }) {
  return (
    <button onClick={disabled ? undefined : e => { e.stopPropagation(); onClick() }}
      title={highlight ? `${label} — has a valid target, click to pick` : label}
      style={{
        fontSize: 10, padding: '3px 8px', borderRadius: 4, cursor: disabled ? 'default' : 'pointer',
        background: highlight ? `${T.red}25` : 'rgba(255,255,255,0.025)',
        border: `1px solid ${highlight ? T.red : T.gold + '30'}`,
        boxShadow: highlight ? `0 0 10px ${T.red}, inset 0 0 6px ${T.red}55` : 'none',
        color: disabled ? T.textMuted : highlight ? '#fff' : T.text, fontFamily: 'Cinzel,serif', letterSpacing: 0.5,
        opacity: disabled ? 0.4 : 1, display: 'inline-flex', alignItems: 'center', gap: 4, transition: 'all 0.15s',
      }}>
      <span style={{ filter: mono ? 'grayscale(1)' : undefined, fontSize: 11 }}>{icon}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{count}</span>
    </button>
  )
}

// ═══ SIMPLE CARD IMAGE (used by order-blockers view) ═══

function CardImg({ card, h = 70, border = T.goldDim, onPreview, onPreviewEnd }) {
  const w = Math.round(h * CARD_RATIO)
  return (
    <div
      onMouseEnter={e => onPreview && onPreview(card.imageUrl, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => onPreviewEnd && onPreviewEnd()}
      style={{ width: w, height: h, borderRadius: 4, overflow: 'hidden', border: `1.5px solid ${border}`, boxShadow: `0 0 6px ${border}40` }}>
      {card.imageUrl
        ? <img src={card.imageUrl} alt={card.name} draggable={false} style={{ width: w, height: h, objectFit: 'cover' }} />
        : <div style={{ padding: 2, fontSize: 6, color: T.textMuted }}>{card.name}</div>}
    </div>
  )
}

// ═══ OPTIONS PANEL ═══

const OVERLAY_CHOICES = new Set(['select_target', 'declare_attackers', 'declare_blockers', 'order_blockers', 'order_triggers',
  'number', 'assign_amount', 'order_list', 'manipulate', 'insert'])

function OptionsPanel({ selectedCard, pendingChoice, targetCard, humanPid, isActive, mulligan, mulliganTo, blockStep, channelBTargeting, targetPrompt, ui, onUiOk, onUiCancel, onOptionClick, onChoiceClick, onConfirmBlocks, onConfirmAttackers, onTargetConfirm, onTargetSkip }) {
  const title = pendingChoice?.title
  const isTargeting = title === 'select_target'
  const combatDecl = title === 'declare_attackers' || title === 'declare_blockers' || title === 'order_blockers'
  const menuChoice = pendingChoice && !OVERLAY_CHOICES.has(title) ? pendingChoice : null
  // Plain priority: Forge enables OK + a cancel button labelled either "End Turn"
  // or, right after an undoable action (e.g. playing a land), "Undo (N)". We surface
  // PASS plus END TURN / YIELD / UNDO accordingly; the visual PhaseBar carries the
  // turn/phase/priority/stack info instead of text.
  const isPriority = !menuChoice && !isTargeting && !combatDecl && ui && ui.ok && ui.cancel && (/end turn/i.test(ui.cancelLabel || '') || /undo/i.test(ui.cancelLabel || ''))
  // Forge's declare-attackers input: OK = confirm, cancel = "Alpha Strike"/"Call Back".
  const isAttackDeclare = !menuChoice && !isTargeting && ui && ui.ok && /alpha strike|call back/i.test(ui.cancelLabel || '')
  // Forge's keep-or-mulligan decision (InputConfirmMulligan): OK = Keep, cancel =
  // Mulligan. Distinct from the bottoming step (engine mulligan flag set).
  const mulliganDecision = !menuChoice && !isTargeting && !combatDecl && !mulligan && ui && ui.ok && ui.cancel && /mulligan/i.test(ui.cancelLabel || '')

  let content
  if (isTargeting) {
    const searchZone = pendingChoice?.searchZone
    content = (
      <div>
        <div style={{ fontSize: 9, color: T.red, fontFamily: 'Cinzel,serif', letterSpacing: 1, marginBottom: 6 }}>
          🎯 <ManaText text={pendingChoice?.prompt || 'Select Target'} />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {searchZone === 'library' && !targetCard && (
            <span style={{ fontSize: 10, color: T.gold, fontStyle: 'italic' }}>Click your Library 📖 to search, then pick a highlighted card.</span>
          )}
          {pendingChoice?.optional && (
            <button onClick={e => { e.stopPropagation(); onTargetSkip() }} style={btnElegant}>No target</button>
          )}
          {targetCard ? (
            <button onClick={e => { e.stopPropagation(); onTargetConfirm() }} style={{ ...btnElegant, background: `${T.red}20`, borderColor: T.red, color: T.red }}>
              Confirm: {targetCard.name}
            </button>
          ) : (
            !searchZone && <button disabled style={{ ...btnElegant, opacity: 0.4, cursor: 'default' }}>(Click a highlighted card)</button>
          )}
        </div>
      </div>
    )
  } else if (menuChoice) {
    content = (
      <div>
        <div style={{ fontSize: 9, color: T.gold, fontFamily: 'Cinzel,serif', letterSpacing: 1, marginBottom: 6 }}><ManaText text={menuChoice.title} /></div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {menuChoice.options.map((opt, i) => (
            <button key={i} onClick={e => { e.stopPropagation(); onChoiceClick(opt) }} style={btnElegant}>
              <ManaText text={String(opt.text ?? opt.id)} />
            </button>
          ))}
        </div>
      </div>
    )
  } else if (combatDecl) {
    const hint = title === 'order_blockers'
      ? 'Set blocker damage order in the panel, then confirm.'
      : title === 'declare_attackers'
        ? 'Click an attacker then a target, then lock in on the stack.'
        : 'Click a blocker then an attacker, then lock in on the stack.'
    content = <div style={{ fontSize: 10, color: T.textMuted, fontStyle: 'italic' }}>{hint}</div>
  } else if (isAttackDeclare) {
    const callBack = /call back/i.test(ui.cancelLabel || '')
    content = (
      <div>
        <div style={{ fontSize: 9, color: T.red, fontFamily: 'Cinzel,serif', letterSpacing: 1, marginBottom: 6 }}>⚔ Declare Attackers</div>
        <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 6, fontStyle: 'italic' }}>Click a creature to attack. With a planeswalker in play, click the attacker (silver) then its target (planeswalker or life total); otherwise it attacks the player. Then confirm.</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={e => { e.stopPropagation(); onConfirmAttackers && onConfirmAttackers() }} style={{ ...btnElegant, borderColor: T.red, color: T.red }}>Confirm Attackers</button>
          <button onClick={e => { e.stopPropagation(); onUiCancel && onUiCancel() }} style={btnElegant}>{callBack ? 'Call Back All' : 'Attack With All'}</button>
        </div>
      </div>
    )
  } else if (blockStep) {
    content = (
      <div>
        <div style={{ fontSize: 9, color: T.blue, fontFamily: 'Cinzel,serif', letterSpacing: 1, marginBottom: 6 }}>🛡 Declare Blockers</div>
        <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 6, fontStyle: 'italic' }}>
          Click a blocker (turns silver), then the attacker it should block (turns blue). Click a blocker again to unassign. Confirm when done — or confirm with none to take the damage.
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={e => { e.stopPropagation(); onConfirmBlocks && onConfirmBlocks() }} style={{ ...btnElegant, borderColor: T.blue, color: T.blue }}>Confirm Blocks</button>
        </div>
      </div>
    )
  } else if ((mulligan || mulliganDecision) && ui && (ui.ok || ui.cancel)) {
    // Mulligan panel, driven entirely by the engine's buttons.
    //  • Opening hand / keep decision (mulliganDecision): Keep (OK) or "Mulligan to
    //    X" (cancel). Nothing to select here.
    //  • Bottoming step (mulligan): click hand cards to choose which to put on the
    //    bottom — they glow gold (available) and red once selected. The engine caps
    //    the count, lets you deselect, and only enables Confirm (OK) at the exact
    //    number. "Auto" (cancel) bottoms the rest for you.
    const bottoming = mulligan
    const canMull = Number.isFinite(mulliganTo) && mulliganTo >= 0
    content = (
      <div>
        <div style={{ fontSize: 9, color: T.gold, fontFamily: 'Cinzel,serif', letterSpacing: 1, marginBottom: 6 }}>
          {bottoming ? '✋ Mulligan — choose cards to put on the bottom' : '✋ Opening Hand'}
        </div>
        <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 6, fontStyle: 'italic' }}>
          {ui.message
            ? <ManaText text={String(ui.message).replace(/\n+/g, ' ')} />
            : (bottoming ? 'Click cards in your hand to put on the bottom.' : 'Keep this hand, or mulligan for a new one.')}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button disabled={!ui.ok} onClick={ui.ok ? e => { e.stopPropagation(); onUiOk && onUiOk() } : undefined}
            title={ui.ok ? 'Keep this hand' : 'Select the required number of cards first'}
            style={{ ...btnElegant, borderColor: ui.ok ? T.gold : T.goldDim, color: ui.ok ? T.gold : T.textMuted, opacity: ui.ok ? 1 : 0.5, cursor: ui.ok ? 'pointer' : 'default' }}>
            {bottoming ? 'Confirm' : 'Keep'}
          </button>
          {bottoming
            ? <button onClick={e => { e.stopPropagation(); onUiCancel && onUiCancel() }} style={btnElegant} title="Auto-pick the remaining cards to bottom">Auto</button>
            : (canMull && ui.cancel && <button onClick={e => { e.stopPropagation(); onUiCancel && onUiCancel() }} style={btnElegant} title="Shuffle back and draw a fresh seven">Mulligan to {mulliganTo}</button>)}
        </div>
      </div>
    )
  } else if (channelBTargeting) {
    // Forge InputSelectTargets ("any target" etc.): highlighted cards + players
    // are clickable; OK confirms once enough targets are chosen, Cancel aborts.
    content = (
      <div>
        <div style={{ fontSize: 9, color: T.red, fontFamily: 'Cinzel,serif', letterSpacing: 1, marginBottom: 6 }}>
          🎯 <ManaText text={targetPrompt || 'Choose a target'} />
        </div>
        <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 6, fontStyle: 'italic' }}>
          Click a highlighted target — a permanent, or a player's bar for "any target".
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {ui.ok && <button onClick={e => { e.stopPropagation(); onUiOk && onUiOk() }} style={{ ...btnElegant, borderColor: T.red, color: T.red }}>{ui.okLabel && !/^ok$/i.test(ui.okLabel) ? ui.okLabel : 'Done'}</button>}
          {ui.cancel && <button onClick={e => { e.stopPropagation(); onUiCancel && onUiCancel() }} style={btnElegant}>{ui.cancelLabel || 'Cancel'}</button>}
        </div>
      </div>
    )
  } else if (isPriority && !selectedCard) {
    const canUndo = /undo/i.test(ui.cancelLabel || '')
    content = (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={e => { e.stopPropagation(); onUiOk && onUiOk() }} style={{ ...btnElegant, borderColor: T.gold, color: T.gold }}>PASS</button>
        <button onClick={e => { e.stopPropagation(); onUiCancel && onUiCancel() }} style={btnElegant}
          title={canUndo ? 'Undo your last action (e.g. a land you just played)' : undefined}>
          {canUndo ? `↶ ${ui.cancelLabel}` : (isActive ? 'END TURN' : 'YIELD')}
        </button>
      </div>
    )
  } else if (ui && ui.cancel && !selectedCard) {
    // Engine sub-flow that needs confirm/abort (mulligan, mana payment, etc.).
    // The question + its options belong in this bottom panel, not by the stack.
    content = (
      <div>
        <div style={{ fontSize: 9, color: T.gold, fontFamily: 'Cinzel,serif', letterSpacing: 1, marginBottom: 6 }}>
          {ui.message ? <ManaText text={ui.message} /> : 'Choose'}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {ui.ok && (
            <button onClick={e => { e.stopPropagation(); onUiOk && onUiOk() }} style={btnElegant}>{/^auto$/i.test(ui.okLabel || '') ? 'Auto-Pay' : (ui.okLabel || 'OK')}</button>
          )}
          <button onClick={e => { e.stopPropagation(); onUiCancel && onUiCancel() }} style={btnElegant}>{ui.cancelLabel || 'Cancel'}</button>
        </div>
      </div>
    )
  } else if (selectedCard) {
    const opts = selectedCard.options || []
    content = (
      <div>
        <div style={{ fontSize: 9, color: T.gold, fontFamily: 'Cinzel,serif', letterSpacing: 1, marginBottom: 6 }}>{selectedCard.card.name}</div>
        {opts.length ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {opts.map((opt, i) => (
              <button key={i} onClick={e => { e.stopPropagation(); onOptionClick(opt) }} style={btnElegant}>
                <ManaText text={opt.log || opt.type} />
              </button>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 10, color: T.textMuted, fontStyle: 'italic' }}>No available actions for this card.</div>
        )}
      </div>
    )
  } else {
    content = <div style={{ fontSize: 10, color: T.goldDim, fontStyle: 'italic' }}>Click a card to see its actions.</div>
  }

  return (
    <div style={{
      padding: '8px 18px', flexShrink: 0, minHeight: 52,
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      background: 'rgba(8,8,14,0.96)', borderTop: `2px solid ${T.gold}55`,
      boxShadow: `0 -4px 20px ${T.gold}15`, maxHeight: 140, overflowY: 'auto',
    }}>
      {content}
    </div>
  )
}

// ═══ ZONE VIEWER MODAL ═══

function ZoneViewerModal({ zone, pid, gs: gameState, filter, onPick, onClose }) {
  const isLibrary = zone === 'library'
  // Two library views: grouped-by-name (default, order hidden) and an ordered
  // top→bottom list (Arena-style) for when an effect lets you see library order.
  const [ordered, setOrdered] = useState(false)
  let cards = [], title = ''
  if (zone === 'library') {
    // Show the owner's known library contents (grouped + counts; order never
    // shown). Only the cards the engine sent us are listed.
    cards = cardsIn(pid, 'library')
    title = `${gameState.players[pid].name}'s Library`
  } else {
    cards = cardsIn(pid, zone)
    const zname = zone === 'graveyard' ? 'Graveyard' : zone === 'exile' ? 'Exile' : zone === 'hand' ? 'Hand' : zone
    title = `${gameState.players[pid].name}'s ${zname}`
  }

  const grouped = {}
  for (const card of cards) {
    if (!card || !card.name) continue
    if (!grouped[card.name]) grouped[card.name] = { card, count: 0 }
    grouped[card.name].count++
  }
  const entries = Object.values(grouped).sort((a, b) => a.card.name.localeCompare(b.card.name))
  // Count of cards actually shown (named). For an opponent hand only the revealed
  // candidates are known, so this differs from the full hand size.
  const shown = entries.reduce((s, e) => s + e.count, 0)
  // Only treat the viewer as a selection prompt when a card here is actually
  // selectable right now; otherwise it's just a normal browse of the zone.
  const anyTargetable = !!filter && entries.some(e => filter(e.card))

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: T.surface, border: `1px solid ${T.gold}`, borderRadius: 6,
        padding: 22, maxWidth: '85vw', maxHeight: '78vh', overflow: 'auto', minWidth: 340,
        boxShadow: `0 0 40px ${T.gold}25, 0 0 0 1px ${T.gold}15`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 8, borderBottom: `1px solid ${T.gold}30` }}>
          <span style={{ fontSize: 14, color: T.gold, fontFamily: 'Cinzel,serif', letterSpacing: 1.5 }}>{title} <span style={{ color: T.textMuted, fontSize: 11 }}>({shown})</span></span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {isLibrary && (
              <div style={{ display: 'flex', gap: 4 }}>
                {[['Grouped', false], ['Order', true]].map(([lbl, val]) => (
                  <button key={lbl} onClick={() => setOrdered(val)} style={{
                    fontSize: 9, padding: '3px 9px', borderRadius: 4, cursor: 'pointer', fontFamily: 'Cinzel,serif', letterSpacing: 0.5,
                    background: ordered === val ? 'rgba(212,168,67,0.22)' : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${ordered === val ? T.gold : T.gold + '30'}`, color: ordered === val ? T.gold : T.textMuted,
                  }}>{lbl}</button>
                ))}
              </div>
            )}
            <button onClick={onClose} style={{ ...btnElegant, padding: '3px 10px' }}>✕</button>
          </div>
        </div>
        {anyTargetable && (
          <div style={{ fontSize: 9, color: T.gold, fontFamily: 'Cinzel,serif', marginBottom: 10 }}>🎯 Click a highlighted card to select it</div>
        )}
        {(ordered && isLibrary ? cards.length === 0 : entries.length === 0) ? (
          <div style={{ color: T.textMuted, fontSize: 11, fontStyle: 'italic', textAlign: 'center', padding: 20 }}>Empty</div>
        ) : ordered && isLibrary ? (
          // Arena-style: cards face-down in true shuffled order, scrub with a
          // slider; a card shows its face only if the engine reveals it. Uses the
          // explicit ordered uid list (object key order isn't reliable).
          <LibraryFlipper
            cards={(gameState._libOrderUids || []).map(u => gameState.cards[u]).filter(c => c && c.pid === pid && c.zone === 'library')}
            filter={filter} onPick={onPick} />
        ) : (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {entries.map(({ card, count }) => {
              const targetable = anyTargetable && filter(card)
              const dimmed = anyTargetable && !targetable
              return (
                <ZoneCard key={card.name} card={card} count={count}
                  targetable={targetable} dimmed={dimmed}
                  onClick={targetable ? () => onPick(card) : undefined} />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ═══ LIBRARY FLIPPER (Arena-style ordered browse) ═══
// The library is shown in true shuffled order, every card face-down, and you
// scrub through it with a slider (simulating flipping through the deck). A card
// only shows its face when the engine says it's revealed (card._libVisible),
// e.g. an effect that lets you play with the top card revealed.
function LibraryFlipper({ cards, filter, onPick }) {
  const [idx, setIdx] = useState(0)
  const n = cards.length
  const i = Math.min(idx, n - 1)
  const card = cards[i]
  if (!card) return null
  const visible = !!card._libVisible
  const targetable = !!filter && filter(card)
  const pos = i === 0 ? 'TOP' : i === n - 1 ? 'BOTTOM' : ''
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '6px 0' }}>
      <div style={{ fontSize: 10, color: T.gold, fontFamily: 'Cinzel,serif', letterSpacing: 1 }}>
        {pos && <span style={{ color: T.goldBr, marginRight: 6 }}>{pos}</span>}Card {i + 1} of {n}
      </div>
      <img src={(visible ? card.imageUrl : null) || MTG_BACK} alt={visible ? card.name : 'Hidden card'} draggable={false}
        onClick={targetable ? () => onPick(card) : undefined}
        style={{ width: 230, borderRadius: 12, cursor: targetable ? 'pointer' : 'default', border: `2px solid ${targetable ? T.gold : visible ? T.goldDim : '#2a2a30'}`, boxShadow: visible ? `0 0 16px ${T.gold}40` : '0 6px 24px rgba(0,0,0,0.8)' }} />
      <div style={{ fontSize: 12, color: visible ? T.goldBr : T.textMuted, fontFamily: 'Cinzel,serif' }}>{visible ? card.name : 'Face down'}</div>
      <input type="range" min={0} max={Math.max(0, n - 1)} value={i} onChange={e => setIdx(parseInt(e.target.value))}
        style={{ width: '80%', accentColor: T.gold }} />
      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={() => setIdx(x => Math.max(0, x - 1))} style={{ ...btnElegant, opacity: i === 0 ? 0.4 : 1 }}>◀ Up</button>
        <button onClick={() => setIdx(x => Math.min(n - 1, x + 1))} style={{ ...btnElegant, opacity: i === n - 1 ? 0.4 : 1 }}>Down ▶</button>
      </div>
    </div>
  )
}

// ═══ ZONE CARD (with peek-flip) ═══

function ZoneCard({ card, count, targetable, dimmed, onClick }) {
  const [showBack, setShowBack] = useState(false)
  const canFlip = !!card.imageUrlBack
  const img = showBack && canFlip ? card.imageUrlBack : card.imageUrl
  return (
    <div onClick={onClick}
      style={{ width: 88, textAlign: 'center', cursor: targetable ? 'pointer' : 'default', opacity: dimmed ? 0.35 : 1, transition: 'opacity 0.2s' }}>
      <div style={{ position: 'relative' }}>
        <img src={img || MTG_BACK} alt={card.name} draggable={false}
          style={{ width: 88, borderRadius: 5, display: 'block', border: `1.5px solid ${targetable ? T.gold : T.goldDim}`, boxShadow: targetable ? `0 0 10px ${T.gold}80` : '0 2px 10px rgba(0,0,0,0.5)' }} />
        {count > 1 && (
          <div style={{ position: 'absolute', top: -5, right: -5, background: T.gold, borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#000', fontWeight: 'bold', fontFamily: 'Cinzel,serif' }}>
            {count}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginTop: 4 }}>
        <span style={{ fontSize: 8, color: T.text, fontFamily: 'Cinzel,serif' }}>{showBack ? card.name2 : card.name}</span>
        {canFlip && (
          <span onClick={e => { e.stopPropagation(); setShowBack(s => !s) }}
            title="Peek at other face"
            style={{ fontSize: 9, padding: '0 4px', borderRadius: 2, background: showBack ? `${T.gold}40` : 'rgba(255,255,255,0.06)', border: `1px solid ${T.gold}60`, color: T.gold, cursor: 'pointer' }}>⟳</span>
        )}
      </div>
    </div>
  )
}

// ═══ CARD SLOT ═══

function CardSlot({ card, onClick, selected, attacking, targetable, targeted, dimmed, size, fixedH, combat, combatBadges, onPreview, onPreviewEnd, draggable, onDragStart, onDrop, actionable }) {
  // Engine-driven highlight (e.g. London-mulligan cards you've chosen to bottom)
  // means "selected" → red. Available-to-select cards glow gold (see below).
  selected = selected || !!card._highlighted
  const [tooltip, setTooltip] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [showBack, setShowBack] = useState(false)
  const [tokenImg, setTokenImg] = useState(null)

  // Tokens have no printed art — fetch it from Scryfall once, then cache it on
  // the card so previews and re-renders reuse it.
  useEffect(() => {
    if (!card.isToken || card.imageUrl) return
    let alive = true
    fetchTokenImage(card).then(url => {
      if (!alive || !url) return
      card.imageUrl = url
      setTokenImg(url)
    })
    return () => { alive = false }
  }, [card.uid])
  const w = fixedH ? Math.round(fixedH * CARD_RATIO) : (size === 'lg' ? 70 : 58)
  const h = fixedH ? fixedH : (size === 'lg' ? 98 : 81)

  // Combat states take visual precedence
  const cLifted = combat?.lifted
  const cArmed = combat?.armed
  const cDim = combat?.dim
  const cSelectable = combat?.selectable
  const cConnected = combat?.connected
  const cInfo = combat?.info
  const cTarget = combat?.target
  const cIllegal = combat?.illegal
  const cColor = combat?.color || T.gold

  const borderColor = cConnected ? cColor
    : cArmed ? T.goldBr
    : cLifted ? T.goldBr
    : cSelectable ? cColor
    : cTarget ? T.red
    : cIllegal ? T.textMuted
    : cInfo ? T.textMuted
    : targeted ? T.red : selected ? T.red : targetable ? T.gold : actionable ? T.gold : attacking ? T.red : T.goldDim + '40'
  const glow = cConnected ? `0 0 12px ${cColor}`
    : cArmed ? `0 0 14px ${T.goldBr}`
    : cLifted ? `0 0 14px ${T.goldBr}`
    : cSelectable ? `0 0 8px ${cColor}90`
    : cTarget ? `0 0 8px ${T.red}80`
    : cInfo ? `0 0 4px ${T.textMuted}60`
    : targeted ? `0 0 16px ${T.red}` : selected ? `0 0 12px ${T.red}` : targetable ? `0 0 12px ${T.gold}` : actionable ? `0 0 10px ${T.gold}99` : attacking ? `0 0 10px ${T.red}80` : '0 1px 4px rgba(0,0,0,0.5)'
  const borderWidth = cConnected || cArmed || cLifted || cSelectable || cTarget || targeted || selected || targetable || actionable ? 2 : cInfo ? 1.5 : 1
  const borderStyle = cInfo || cIllegal ? 'dashed' : 'solid'

  const hasBackFace = !!card.imageUrlBack
  const canFlip = hasBackFace && card.zone !== 'battlefield'
  const displayImage = showBack && hasBackFace ? card.imageUrlBack : (card.imageUrl || tokenImg)

  // Current (layer-computed) power/toughness, coloured against the printed base
  // so anthems / counters / pumps / debuffs are all visible at a glance.
  const isCreatureCard = card.isCreature
  const curP = isCreatureCard ? card.power : 0
  const curT = isCreatureCard ? card.toughness : 0
  const baseP = parseInt(card._power) || 0
  const baseT = parseInt(card._toughness) || 0
  const ptColor = (curP > baseP || curT > baseT) ? '#62c062'
    : (curP < baseP || curT < baseT) ? '#d05a5a'
    : '#ece0c4'

  const badges = [...(combatBadges || [])]
  if (card.summoningSick) badges.push({ icon: '🌀', label: 'Summoning Sickness', color: 'rgba(100,100,140,0.7)' })
  const kws = (card.keywords || '').toLowerCase()
  if (kws.includes('flying')) badges.push({ icon: '🪽', label: 'Flying', color: 'rgba(100,140,220,0.7)' })
  if (kws.includes('lifelink')) badges.push({ icon: '💚', label: 'Lifelink', color: 'rgba(60,160,60,0.7)' })
  if (kws.includes('deathtouch')) badges.push({ icon: '☠', label: 'Deathtouch', color: 'rgba(80,40,100,0.7)' })
  if (kws.includes('haste')) badges.push({ icon: '⚡', label: 'Haste', color: 'rgba(200,60,60,0.7)' })
  if (kws.includes('trample')) badges.push({ icon: '🦶', label: 'Trample', color: 'rgba(60,140,60,0.7)' })
  if (kws.includes('vigilance')) badges.push({ icon: '👁', label: 'Vigilance', color: 'rgba(180,180,60,0.7)' })

  // +1/+1 (or -1/-1) counters as a badge — bottom row, so multiple counter
  // kinds can coexist instead of a single corner number.
  if (card.counters) {
    const pos = card.counters > 0
    const n = Math.abs(card.counters)
    badges.unshift({
      icon: `${pos ? '+' : '−'}${n}/${pos ? '+' : '−'}${n}`,
      label: `${n} ${pos ? '+1/+1' : '-1/-1'} counter${n > 1 ? 's' : ''}`,
      color: pos ? 'rgba(70,150,70,0.9)' : 'rgba(120,60,120,0.9)',
    })
  }

  return (
    <div
      data-uid={card.uid}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, position: 'relative', opacity: (dimmed || cDim) ? 0.35 : 1, transform: cLifted ? 'translateY(-6px)' : undefined, transition: 'opacity 0.2s, transform 0.15s' }}
      draggable={draggable}
      onDragStart={e => { e.dataTransfer.setData('text/plain', card.uid); e.dataTransfer.effectAllowed = 'move'; onDragStart && onDragStart(card.uid) }}
      onDragOver={e => { if (draggable) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(true) } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        const fromUid = e.dataTransfer.getData('text/plain')
        if (fromUid && fromUid !== card.uid && onDrop) onDrop(fromUid, card.uid)
      }}>
      <div onClick={onClick}
        onMouseEnter={e => onPreview && onPreview(displayImage, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => onPreviewEnd && onPreviewEnd()}
        style={{
          width: card.tapped ? h : w, height: card.tapped ? w + 4 : h,
          position: 'relative', borderRadius: 5, overflow: 'hidden',
          border: `${borderWidth}px ${dragOver ? 'solid' : borderStyle} ${dragOver ? T.goldBr : borderColor}`, background: T.surface,
          cursor: 'pointer', transition: 'border-color 0.15s, box-shadow 0.15s',
          boxShadow: dragOver ? `0 0 12px ${T.goldBr}` : glow,
        }}>
        {displayImage ? (
          <img src={displayImage} alt={card.name} draggable={false}
            style={{ width: w, height: h, objectFit: 'cover', transform: card.tapped ? 'rotate(90deg) translate(0, -100%)' : undefined, transformOrigin: 'top left', pointerEvents: 'none' }} />
        ) : (
          <div style={{
            width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 3, padding: 3, textAlign: 'center',
            background: 'radial-gradient(ellipse at 50% 30%, #1c1812 0%, #0c0a07 100%)',
          }}>
            <div style={{ fontSize: Math.max(6, Math.round(w / 9)), color: T.gold, fontFamily: 'Cinzel,serif', lineHeight: 1.1 }}>{card.name}</div>
            {card.isToken && <div style={{ fontSize: 6, color: T.textMuted, letterSpacing: 2, fontFamily: 'Cinzel,serif' }}>TOKEN</div>}
            {isCreatureCard && <div style={{ fontSize: Math.max(8, Math.round(w / 6)), color: ptColor, fontFamily: 'Cinzel,serif' }}>{curP}/{curT}</div>}
          </div>
        )}
        {/* Live P/T pill, positioned over the card's printed P/T box (and rotated with tapped cards). */}
        {isCreatureCard && displayImage && (
          <div style={{
            position: 'absolute', top: 0, left: 0, width: w, height: h,
            transform: card.tapped ? 'rotate(90deg) translate(0, -100%)' : undefined,
            transformOrigin: 'top left', pointerEvents: 'none',
          }}>
            <div style={{
              position: 'absolute', right: '5%', bottom: '2.5%',
              minWidth: Math.round(w * 0.20),
              padding: `0 ${Math.max(2, Math.round(w * 0.045))}px`,
              fontSize: Math.max(8, Math.round(h * 0.088)), lineHeight: 1.3,
              fontFamily: 'Cinzel,serif', fontWeight: 700, textAlign: 'center',
              color: ptColor, background: 'rgba(6,5,3,0.84)',
              border: `1px solid ${ptColor}aa`, borderRadius: 3,
              boxShadow: '0 1px 3px rgba(0,0,0,0.7)',
            }}>{curP}/{curT}</div>
          </div>
        )}
      </div>
      {/* Badge bar — always reserved so cards stay uniform height */}
      <div style={{ display: 'flex', gap: 2, marginTop: 2, height: 11, alignItems: 'center', justifyContent: 'center' }}>
        {badges.map((b, i) => (
          <span key={i}
            onMouseEnter={e => { const r = e.currentTarget.getBoundingClientRect(); setTooltip({ text: b.label, x: r.left + r.width / 2, y: r.top }) }}
            onMouseLeave={() => setTooltip(null)}
            style={{ fontSize: 7, lineHeight: 1, padding: '1px 2px', borderRadius: 2, background: b.color, cursor: 'default' }}>{b.icon}</span>
        ))}
        {canFlip && (
          <span onClick={e => { e.stopPropagation(); setShowBack(s => !s) }}
            title="Peek at other face"
            style={{ fontSize: 8, lineHeight: 1, padding: '1px 4px', borderRadius: 2, background: showBack ? `${T.gold}40` : 'rgba(255,255,255,0.06)', border: `1px solid ${T.gold}60`, color: T.gold, cursor: 'pointer' }}>⟳</span>
        )}
      </div>
      {tooltip && (
        <div style={{
          position: 'fixed', left: tooltip.x, top: tooltip.y, transform: 'translate(-50%, -100%)',
          background: T.surface, border: `1px solid ${T.gold}`, borderRadius: 4,
          padding: '3px 8px', fontSize: 9, color: T.text, whiteSpace: 'nowrap',
          zIndex: 10000, pointerEvents: 'none', fontFamily: 'Cinzel,serif',
          boxShadow: `0 4px 12px rgba(0,0,0,0.7)`,
        }}>{tooltip.text}</div>
      )}
    </div>
  )
}

const btnElegant = {
  padding: '5px 12px', fontSize: 10, fontFamily: 'Cinzel,serif', letterSpacing: 0.5,
  background: 'rgba(8,8,14,0.9)', border: `1px solid ${T.gold}50`, color: T.gold,
  borderRadius: 4, cursor: 'pointer', transition: 'all 0.15s',
}
