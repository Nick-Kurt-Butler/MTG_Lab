// Player profile. The username is stored in localStorage (Electron's userData
// dir, separate from the replaceable app bundle), so it's auto-created once on
// first install and preserved across version updates — same durability as decks.

const KEY = 'mtg_username'
const MAX_LEN = 24

const ADJ = ['Arcane', 'Goblin', 'Elvish', 'Ancient', 'Azure', 'Crimson', 'Verdant',
  'Phyrexian', 'Eternal', 'Storm', 'Mana', 'Dragon', 'Shadow', 'Radiant', 'Sly', 'Grim']
const NOUN = ['Planeswalker', 'Summoner', 'Archmage', 'Duelist', 'Brewer', 'Spellslinger',
  'Tinkerer', 'Conjurer', 'Tactician', 'Channeler', 'Warden', 'Pathfinder', 'Mistcaller']

export function generateUsername() {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)]
  const n = NOUN[Math.floor(Math.random() * NOUN.length)]
  return `${a}${n}${Math.floor(100 + Math.random() * 900)}`
}

// Returns the stored username, auto-generating and persisting one on first run.
export function loadUsername() {
  try {
    const v = localStorage.getItem(KEY)
    if (v && v.trim()) return v
  } catch { /* ignore */ }
  const g = generateUsername()
  try { localStorage.setItem(KEY, g) } catch { /* ignore */ }
  return g
}

// Saves a user-chosen name (trimmed/capped). Empty input keeps the current name.
export function saveUsername(name) {
  const clean = (name || '').trim().slice(0, MAX_LEN)
  if (!clean) return loadUsername()
  try { localStorage.setItem(KEY, clean) } catch { /* ignore */ }
  return clean
}
