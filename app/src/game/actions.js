// Combat legality helper used by the block-declaration UI. Forge is the real
// authority on legality (it marks legal blockers as selectable), but the block
// draft in Board.jsx uses this to gray out obviously-illegal attacker/blocker
// pairs while you're assigning blocks (e.g. a grounded creature can't block a
// flyer).

export function canBlock(attacker, blocker) {
  if (!attacker || !blocker) return false
  if (!blocker.isCreature) return false
  if (blocker.tapped) return false
  const ak = (attacker.keywords || '').toLowerCase()
  const bk = (blocker.keywords || '').toLowerCase()
  // Flying can only be blocked by creatures with flying or reach.
  if (ak.includes('flying') && !(bk.includes('flying') || bk.includes('reach'))) return false
  return true
}
