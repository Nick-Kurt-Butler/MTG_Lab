// Rebuilds the MTG Lab `gs` from a Forge snapshot + the current UI state + the
// current blocking prompt, and wires the components' callbacks to bridge
// messages. This is the single translation layer between Forge's engine and your
// UI (DESIGN.md §7, §12, §13).
//
// Two interaction channels (they never overlap):
//   • ui-driven  — Forge's input system highlights selectable cards and enables
//     OK/Cancel. Clicking a selectable card sends `selectCard`; Pass / sub-flow
//     OK/Cancel live by the stack (LogPanel). No `_pendingChoice`.
//   • prompt-driven — a blocking IGuiGame question (e.g. a card's ability menu
//     from getAbilityToPlay). Rendered as `_pendingChoice` (the bottom panel:
//     card name = question, options = answers); answering sends `response`.

import gs from '../game/state.js'
import { HumanPlayer, CpuPlayer } from '../game/player.js'
import { getArtOverride } from './artOverrides.js'

function parseIntOr(v, d) { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n }

// Strip Forge's internal object ids appended to names, e.g. "Soul's Attendant (22)"
// -> "Soul's Attendant". Only matches " (digits)", so token P/T like "(1/1)" is safe.
function cleanName(s) { return (s || '').replace(/\s*\((\d+)\)/g, '') }

function typeFlags(types) {
  const t = types || ''
  return {
    isCreature: /Creature/.test(t),
    isLand: /Land/.test(t),
    isPlaneswalker: /Planeswalker/.test(t),
    isToken: /Token/.test(t),
  }
}

function counterNumber(counters) {
  if (!counters) return 0
  const plus = counters.P1P1 || counters['+1/+1'] || 0
  const minus = counters.M1M1 || counters['-1/-1'] || 0
  return plus - minus
}

// Map a Forge player id (as carried on snapshot players, selectables, options)
// to our seat-relative pid. Falls back to p1 when unknown.
function pidByOwner(ownerId, myId, oppId) {
  return ownerId === myId ? 'p1' : ownerId === oppId ? 'p2' : 'p1'
}

// Create a minimal card record for a candidate that isn't in a visible zone
// (e.g. opponent hand, either library) so the matching zone viewer + button can
// surface it. No-op if the card is already present. Returns the card.
function injectCard(gsRef, id, name, zone, pid, artFor) {
  const uid = String(id)
  if (gsRef.cards[uid]) return gsRef.cards[uid]
  const a = artFor(name)
  const ov = getArtOverride(name)
  const card = {
    uid, _id: id, name: name || '', pid, zone: zone || 'library',
    imageUrl: (ov && ov.image_url) || (a ? a.image_url : null),
    imageUrlBack: (ov && ov.image_url_back) || (a ? (a.image_url_back || '') : ''),
    isCreature: false, actionable: false, options: () => [],
  }
  gsRef.cards[uid] = card
  return card
}

// ctx: { mySeat, art, respond, action, ui, prompt }
export function buildGs(snapshot, ui, prompt, ctx) {
  ctx = ctx || {}
  const { mySeat = 0, art = null } = ctx
  const players = snapshot.players || []
  const pidOf = idx => (idx === mySeat ? 'p1' : 'p2')

  // Cards Forge says are interactable right now (priority plays, targets,
  // attackers/blockers, lands to tap for mana — all the same gesture).
  const actionable = new Set([...(ui?.selectables || []), ...(ui?.weakly || [])])
  // Identity/zone/owner for selectable cards (so hidden-zone selectables — opp
  // hand, either library — can be placed correctly and made clickable).
  const infoById = new Map()
  for (const ci of [...(ui?.selInfo || []), ...(ui?.weakInfo || [])]) {
    if (ci && ci.id != null) infoById.set(ci.id, ci)
  }
  const highlightedSet = new Set(ui?.highlighted || [])
  // The engine's mulligan flag comes on the buttons message (reliable), not the
  // snapshot (which can be stale during an input).
  const mulligan = !!(ui?.mulligan) || !!snapshot.mulligan

  gs.cards = {}
  gs._pendingChoice = null
  gs._legalBlocks = null
  // The viewer's library uids in true top→bottom order (object key order can't be
  // trusted for numeric ids, so the ordered library viewer uses this list).
  gs._libOrderUids = []

  const me = players.find(p => p.index === mySeat) || players[0] || {}
  const opp = players.find(p => p.index !== mySeat) || players[1] || {}
  gs.players = { p1: new HumanPlayer(me.name || 'You'), p2: new CpuPlayer(opp.name || 'Opponent') }
  gs._oppPlayerId = opp.id
  gs._myPlayerId = me.id

  const artFor = name => (art && art[name]) || null

  function addCard(c, pid, zone) {
    const flags = typeFlags(c.types)
    const a = artFor(c.name)
    const ov = getArtOverride(c.name)
    const id = c.id
    const card = {
      uid: String(id), name: c.name, pid, zone,
      _id: id,
      // During the London mulligan the engine doesn't push selectables, but you
      // click hand cards to choose which to bottom — so make your hand clickable.
      actionable: actionable.has(id) || (mulligan && zone === 'hand' && pid === 'p1'),
      // Forge highlights different things in different inputs (mulligan cards to
      // bottom, the current combat defender, …). We only want the red "chosen"
      // styling during the mulligan; otherwise a combat highlight would wrongly
      // paint a creature red.
      _highlighted: mulligan && highlightedSet.has(id),
      imageUrl: (ov && ov.image_url) || (a ? a.image_url : null),
      imageUrlBack: (ov && ov.image_url_back) || (a ? (a.image_url_back || '') : ''),
      ...flags,
      power: parseIntOr(c.power, 0),
      toughness: parseIntOr(c.toughness, 0),
      _power: c.power, _toughness: c.toughness,
      tapped: !!c.tapped,
      summoningSick: !!c.sick,
      keywords: c.keywords || '',
      counters: counterNumber(c.counters),
      damage: c.damage || 0,
      // Library-only: whether the engine lets the owner see this card face-up
      // (e.g. top card revealed). The ordered library viewer shows the rest as backs.
      _libVisible: !!c.visible,
      // Real per-card options aren't in the snapshot — they come from Forge's
      // getAbilityToPlay when the card is selected. options() stays empty; the
      // `actionable` flag tells the board this card can be clicked to ask Forge.
      options: () => [],
      validBlocker: () => flags.isCreature,
    }
    gs.cards[card.uid] = card
  }

  for (const p of players) {
    const pid = pidOf(p.index)
    const pl = gs.players[pid]
    pl.life = p.life
    pl.manaPool = manaPoolOf(p)
    pl.hasPriority = !!p.hasPriority
    pl.libraryOrder = Array.from({ length: p.librarySize || 0 }, (_, k) => `lib_${pid}_${k}`)
    if (pid === 'p1') {
      for (const c of (p.hand || [])) addCard(c, pid, 'hand')
      // Your own library contents (the engine sends them only to you), kept in
      // true order for the Arena-style ordered viewer (grouped view ignores it).
      for (const c of (p.library || [])) addCard(c, pid, 'library')
      gs._libOrderUids = (p.library || []).map(c => String(c.id))
    } else {
      for (let k = 0; k < (p.handCount || 0); k++) {
        const u = `ophand_${k}`
        gs.cards[u] = { uid: u, name: '', pid, zone: 'hand', imageUrl: null, isCreature: false, actionable: false, options: () => [] }
      }
    }
    for (const c of (p.graveyard || [])) addCard(c, pid, 'graveyard')
    for (const c of (p.exile || [])) addCard(c, pid, 'exile')
  }
  for (const c of (snapshot.battlefield || [])) addCard(c, pidOf(c.controller), 'battlefield')

  // Channel B: any selectable card not in a visible zone (opponent hand, either
  // library) gets injected where the engine says it lives, so its zone viewer +
  // button surface it. Visible cards were already marked actionable in addCard.
  for (const id of actionable) {
    if (gs.cards[String(id)]) continue
    const ci = infoById.get(id)
    if (!ci) continue
    const pid = pidByOwner(ci.owner, me.id, opp.id)
    const card = injectCard(gs, id, ci.name, ci.zone, pid, artFor)
    card.actionable = true
  }

  gs.activePlayer = pidOf(snapshot.activePlayer)
  gs.turn = snapshot.turn || 0
  gs.mulligan = mulligan
  // Prefer the live count from the buttons message (the snapshot's lags by one).
  gs.mulliganCount = (ui?.mulliganCount ?? me.mulliganCount) || 0
  gs.maxHandSize = (ui?.maxHandSize ?? me.maxHandSize) || 7
  gs.phaseRaw = snapshot.phase || ''
  // Combat phases contain "combat" but not "main" (so "precombat/postcombat main"
  // don't false-positive as combat).
  const _pl = (snapshot.phase || '').toLowerCase()
  gs.phase = (/combat/.test(_pl) && !/main/.test(_pl)) ? 'combat' : (snapshot.phase || '')
  gs.log = snapshot.log || []
  // Combat arrows: attacker -> defender (player pid or card uid), blocker -> attacker.
  const pidByPlayerId = id => (id === gs._myPlayerId ? 'p1' : id === gs._oppPlayerId ? 'p2' : null)
  gs.combat = { attackers: [], blockers: [] }
  for (const e of (snapshot.combat || [])) {
    const atkUid = String(e.attacker)
    const target = pidByPlayerId(e.defender) || String(e.defender)
    gs.combat.attackers.push({ uid: atkUid, target })
    for (const b of (e.blockers || [])) gs.combat.blockers.push({ uid: String(b), blocking: atkUid })
  }
  // Declare-blockers step (Forge InputBlock): as the defender you're prompted with
  // OK enabled and Cancel disabled during the declare-blockers phase. Your legal
  // blockers already arrive as weaklySelectable (actionable). Also make the
  // attacking creatures clickable so you can choose which attacker to block —
  // Forge tracks a "current attacker" and switches it when you click one (it
  // highlights the current one, which we surface as `_highlighted`).
  gs._blockStep = !!(ui && ui.ok && !ui.cancel && !prompt && /declare_blockers/i.test(snapshot.phase || ''))
  if (gs._blockStep) {
    for (const a of gs.combat.attackers) { const c = gs.cards[a.uid]; if (c) c.actionable = true }
  }
  // Declare-attackers step (Forge InputAttack): detected by its Alpha Strike /
  // Call Back cancel button. Legal attackers are already actionable; the Board
  // uses a draft to target planeswalkers when the opponent has any.
  gs._attackStep = !!(ui && !prompt && /alpha strike|call back/i.test(ui.cancelLabel || ''))
  // You hold priority whenever Forge is letting you act (OK/pass enabled) and
  // there's no modal prompt pending. Drives the PhaseBar priority indicator.
  gs.priorityHolder = (ui && ui.ok && !prompt) ? 'p1' : null
  gs.stack = (snapshot.stack || []).map(s => ({ name: s.text, card: null }))
  // Non-blocking reveal (cards the engine showed you: top of library, a revealed
  // hand, etc.) — surfaced as a dismissible overlay by the board.
  gs._reveal = (ui && ui.reveal) || null

  // Channel-B targeting (Forge InputSelectTargets — e.g. an "any target" ability
  // like Walking Ballista): the engine marks legal card targets selectable and
  // shows a "…target…" message, but creates no blocking prompt. Flag it so the
  // board shows a clear targeting prompt and lets you click a PLAYER too (players
  // aren't sent as selectables; Forge validates the click and rejects illegal
  // ones). Mana payment / other sub-flows don't mention "target", so they're out.
  gs._targeting = !!(ui && ui.ok && !prompt && !gs._blockStep && !gs._attackStep && !mulligan
    && /target/i.test(ui.message || ''))
  gs._targetPrompt = gs._targeting ? (ui.message || 'Choose a target') : null

  if (prompt) applyPrompt(prompt, ctx)
  return gs
}

function manaPoolOf(p) {
  // Snapshot may carry a mana pool map {W,U,B,R,G,C: n}; tolerate absence.
  const mp = p.manaPool || p.mana || {}
  const out = {}
  for (const [k, v] of Object.entries(mp)) if (v > 0) out[k] = v
  return out
}

// A blocking IGuiGame question -> the bottom panel (card name = question for an
// ability menu; options = answers).
function applyPrompt(d, ctx) {
  const respond = ctx.respond
  const opts = (d.options || []).map(o => ({ id: o.index, text: cleanName(o.label), _cardId: o.id, _zone: o.zone, _owner: o.owner }))

  switch (d.kind) {
    case 'chooseAbility':
    case 'option': {
      // A card's ability menu (or a label list). No Cancel button — clicking
      // another card switches to it, clicking empty space declines (the Board
      // calls pendingChoice.cancel for both).
      gs._pendingChoice = menu(cleanName(d.prompt) || 'Choose', opts,
        opt => respond(d.id, { choice: opt.id }),
        () => respond(d.id, { choice: -1 }))
      return
    }
    case 'chooseEntity':
    case 'chooseEntities':
    case 'choose': {
      // If every option is an entity (card/player id present), use MTG Lab's
      // highlight-and-click targeting (click the card in its zone) instead of a
      // redundant flat list. Otherwise fall back to a label button menu.
      const entityOpts = opts.filter(o => o._cardId != null)
      if (opts.length && entityOpts.length === opts.length) {
        applyEntityTargeting(d, opts, ctx)
        return
      }
      const list = opts.slice()
      if ((d.min ?? 1) === 0) list.push({ id: -1, text: 'Done / None' })
      gs._pendingChoice = menu(d.prompt || 'Choose', list,
        opt => respond(d.id, { choices: opt.id === -1 ? [] : [opt.id] }))
      return
    }
    case 'confirm': {
      gs._pendingChoice = menu(d.prompt || 'Confirm',
        [{ id: 1, text: 'Yes' }, { id: 0, text: 'No' }],
        opt => respond(d.id, { confirm: opt.id === 1 }))
      return
    }
    case 'getInteger': {
      // Pick a number in [min,max] (X costs, "choose a number"). Engine wants an int.
      const min = d.min ?? 0
      const max = (d.max == null || d.max < min) ? min + 20 : d.max
      gs._pendingChoice = {
        title: 'number', prompt: d.prompt || 'Choose a number', min, max,
        submit: v => respond(d.id, { value: v }),
      }
      return
    }
    case 'assignAmount': {
      // Distribute `amount` across the options (combat damage split, divide
      // damage/counters). One integer per option; must sum to amount.
      gs._pendingChoice = {
        title: 'assign_amount', prompt: d.prompt || 'Assign',
        amount: d.amount ?? 0, atLeastOne: !!d.atLeastOne, maySkip: !!d.maySkip, mode: d.mode,
        // Combat damage is assigned in blocker order (lethal before moving on)
        // unless the engine says the split is free (overrideOrder / trample choice).
        ordered: d.mode === 'damage' && !d.overrideOrder,
        options: (d.options || []).map(o => ({ id: o.index, label: cleanName(o.label), lethal: o.lethal || 0, isDefender: !!o.isDefender })),
        submit: amounts => respond(d.id, { amounts }),
      }
      return
    }
    case 'order': {
      // Order a set (triggers on the stack, cards being placed). Returns the
      // chosen order as option-indices.
      gs._pendingChoice = {
        title: 'order_list', prompt: d.prompt || 'Choose the order', top: d.top, canRemember: !!d.remember,
        // subset: pick which cards move (and order them) vs. reorder them all.
        // Used by scry (pick cards for the bottom) / surveil (pick for graveyard).
        subset: !!d.subset, min: d.min ?? 0, max: d.max ?? (d.options || []).length,
        options: opts.map(o => ({ id: o.id, label: o.text })),
        submit: (order, remember) => respond(d.id, { order, remember }),
      }
      return
    }
    case 'manipulate': {
      // Scry / surveil / rearrange top of library: order cards and (optionally)
      // send some to top or bottom. Returns the resulting top-to-bottom order.
      gs._pendingChoice = {
        title: 'manipulate', prompt: d.prompt || 'Arrange cards',
        toTop: !!d.toTop, toBottom: !!d.toBottom, toAnywhere: !!d.toAnywhere,
        options: (d.options || []).map(o => ({ id: o.index, label: cleanName(o.label), movable: o.movable !== false })),
        submit: order => respond(d.id, { order }),
      }
      return
    }
    case 'insert': {
      // Insert a new item at a chosen position in a list. Returns the position.
      gs._pendingChoice = {
        title: 'insert', prompt: d.prompt || 'Choose a position', newItem: cleanName(d.newItem || ''),
        options: opts.map(o => ({ id: o.id, label: o.text })),
        submit: position => respond(d.id, { position }),
      }
      return
    }
    case 'input': {
      if (d.numeric) {
        gs._pendingChoice = {
          title: 'number', prompt: d.prompt || 'Enter a number', min: 0, max: 99,
          submit: v => respond(d.id, { value: String(v) }),
        }
        return
      }
      const list = opts.length ? opts : [{ id: 0, text: 'OK' }]
      gs._pendingChoice = menu(d.prompt || 'Input', list,
        opt => respond(d.id, { value: opt.text }))
      return
    }
    default: {
      // Unknown prompt: a single Continue that answers empty.
      gs._pendingChoice = menu(d.prompt || d.kind, [{ id: 0, text: 'Continue' }], () => respond(d.id, {}))
    }
  }
}

// Entity choice (target a card/player, or search a zone) rendered as MTG Lab
// targeting: valid cards are highlighted in their zone (battlefield, graveyard,
// exile) or in the library viewer for a search; click one to pick. Candidate
// cards that aren't in a visible zone (a library search) are injected into the
// library so the zone viewer can show them grouped with counts.
function applyEntityTargeting(d, opts, ctx) {
  const respond = ctx.respond
  const myId = gs._myPlayerId, oppId = gs._oppPlayerId
  const validIds = new Set(opts.map(o => o._cardId))
  const artFor = name => (ctx.art && ctx.art[name]) || null

  // Place any candidate that isn't already in a visible zone where the engine
  // says it lives (either player's hand/library/graveyard/exile). Track whether
  // any candidate sits in a zone the player must open (a library, or a hidden
  // hand) so the prompt can hint at it.
  let searchZone = null
  for (const o of opts) {
    const cid = o._cardId
    if (cid === myId || cid === oppId) continue          // a player target
    let c = gs.cards[String(cid)]
    if (!c) {
      const pid = o._owner != null ? pidByOwner(o._owner, myId, oppId) : 'p1'
      c = injectCard(gs, cid, o.text, o._zone || 'library', pid, artFor)
    }
    // Battlefield/graveyard/exile are visible in place; a library (always) and an
    // opponent's hand (face-down on the board) must be opened to reach.
    if (c.zone === 'library' || (c.zone === 'hand' && c.pid !== 'p1')) searchZone = c.zone
  }

  const respondWith = idx => {
    if (d.kind === 'chooseEntity') respond(d.id, { choice: idx == null ? -1 : idx })
    else respond(d.id, { choices: idx == null ? [] : [idx] })
  }

  gs._pendingChoice = {
    title: 'select_target',
    prompt: d.prompt,
    optional: !!d.optional || (d.min ?? 1) === 0,
    searchZone,
    filter: card => {
      if (!card) return false
      if (card.isPlayer) { const pv = card.pid === 'p1' ? myId : oppId; return validIds.has(pv) }
      return validIds.has(card._id)
    },
    pick: tc => {
      if (!tc) { respondWith(null); return }
      const cid = tc.isPlayer ? (tc.pid === 'p1' ? myId : oppId) : tc._id
      const opt = opts.find(o => o._cardId === cid)
      respondWith(opt ? opt.id : null)
    },
    options: opts,
  }
}

function menu(title, options, pick, cancel) {
  // title not in the Board's OVERLAY_CHOICES set -> rendered as a button menu.
  return { title, options, pick, cancel }
}
