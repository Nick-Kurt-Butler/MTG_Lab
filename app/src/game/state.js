// The client-side game-state singleton. The adapter (engine/adapter.js) rebuilds
// its fields from each Forge snapshot; the battle UI reads from it. It's a plain
// mutable object shared across the app (imported as the default export).

const gs = {
  cards: {},                                   // uid -> card record
  players: {},                                 // { p1, p2 } (HumanPlayer/CpuPlayer)
  activePlayer: 'p1',
  turn: 0,
  phase: '',
  phaseRaw: '',
  mulligan: false,
  mulliganCount: 0,
  maxHandSize: 7,
  log: [],
  stack: [],
  combat: { attackers: [], blockers: [] },
  priorityHolder: null,
  _pendingChoice: null,
  _legalBlocks: null,
  _blockStep: false,
  _myPlayerId: null,
  _oppPlayerId: null,
}

// All cards belonging to `pid` currently in `zone` (battlefield/hand/graveyard/
// exile/library), in a stable insertion order. The battlefield renderer applies
// its own `_uiOrder` sort on top of this.
export function cardsIn(pid, zone) {
  const out = []
  for (const uid in gs.cards) {
    const c = gs.cards[uid]
    if (c && c.pid === pid && c.zone === zone) out.push(c)
  }
  return out
}

export default gs
