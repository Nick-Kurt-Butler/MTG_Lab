// Arena-style auto-play stops. Auto-play is always on: the engine auto-passes
// any step you haven't marked as a stop (only while the stack is empty, so you
// never miss responding to a spell). These five toggles group Forge's PhaseType
// steps; an enabled group stops on BOTH your turn and the opponent's.

export const STOP_GROUPS = [
  { key: 'upkeep_draw', label: 'Upkeep & Draw', phases: ['UPKEEP', 'DRAW'] },
  { key: 'pre_combat',  label: 'Before Combat', phases: ['MAIN1'] },
  { key: 'combat',      label: 'At Combat',      phases: ['COMBAT_BEGIN', 'COMBAT_DECLARE_ATTACKERS', 'COMBAT_DECLARE_BLOCKERS', 'COMBAT_DAMAGE', 'COMBAT_END'] },
  { key: 'post_combat', label: 'After Combat',   phases: ['MAIN2'] },
  { key: 'end',         label: 'End of Turn',    phases: ['END_OF_TURN'] },
]

// Default: stop at your plays (both mains) and during combat.
const DEFAULTS = { pre_combat: true, combat: true, post_combat: true }

export function loadStops() {
  try {
    const s = JSON.parse(localStorage.getItem('mtg_stops'))
    if (s && typeof s === 'object') return s
  } catch {}
  return { ...DEFAULTS }
}

export function saveStops(s) {
  try { localStorage.setItem('mtg_stops', JSON.stringify(s)) } catch {}
}

// Expand the enabled groups into the flat turn-relative phase keys the bridge
// checks in isUiSetToSkipPhase ("my:<PHASE>" / "opp:<PHASE>").
export function stopKeys(stops) {
  const out = []
  for (const g of STOP_GROUPS) {
    if (!stops[g.key]) continue
    for (const ph of g.phases) { out.push(`my:${ph}`); out.push(`opp:${ph}`) }
  }
  return out
}
