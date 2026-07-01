// Per-user art overrides: the player can pick a different printing's art for any
// card in the deck builder. The choice is keyed by card name and persisted in
// localStorage, and is consulted everywhere a card is drawn (deck builder AND the
// battle board via the adapter), so a chosen art shows up consistently.
//
// Override shape: { [cardName]: { image_url, image_url_back } }

const KEY = 'mtg_card_art'

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} }
}

export function loadArtOverrides() { return load() }

export function getArtOverride(name) { return load()[name] || null }

export function setArtOverride(name, art) {
  const m = load()
  m[name] = { image_url: art.image_url, image_url_back: art.image_url_back || '' }
  localStorage.setItem(KEY, JSON.stringify(m))
}

export function clearArtOverride(name) {
  const m = load()
  delete m[name]
  localStorage.setItem(KEY, JSON.stringify(m))
}

// Learned per-card printing counts. The catalog can't tell us how many distinct
// printings a card has (that needs Scryfall's all-printings bulk, which the proxy
// blocks at build time), so we record the real count the first time the art
// picker fetches it, and use it to hide the 🎨 button for true single-art cards.
// NOTE: key is versioned (_v2) to abandon poisoned zero-counts recorded while the
// printings lookup was broken. We never store a count < 1 (that means the fetch
// failed, not that the card has no printings — every real card has >= 1).
const COUNT_KEY = 'mtg_art_counts_v2'
function loadCounts() { try { return JSON.parse(localStorage.getItem(COUNT_KEY) || '{}') } catch { return {} } }
export function loadArtCounts() { return loadCounts() }
export function recordArtCount(name, n) {
  if (!Number.isFinite(n) || n < 1) return false  // failed lookup — don't poison the cache
  const m = loadCounts()
  if (m[name] === n) return false
  m[name] = n
  localStorage.setItem(COUNT_KEY, JSON.stringify(m))
  return true
}

// On-demand fetch of every printing's art for a card name, from Scryfall.
// Cached in memory for the session. Returns [{ id, set, setCode, collector,
// image_url, image_url_back }]. Network is assumed available (the app already
// loads card art from Scryfall).
const printsCache = new Map()

export async function fetchPrintings(name) {
  if (printsCache.has(name)) return printsCache.get(name)
  let out = []
  try {
    if (typeof window !== 'undefined' && window.forgeAPI?.printings) {
      // Electron: go through the main process (HTTP/1.1 + request queue).
      out = await window.forgeAPI.printings(name) || []
    } else {
      // Plain browser fallback: call Scryfall directly.
      const q = encodeURIComponent(`!"${name}"`)
      const r = await fetch(`https://api.scryfall.com/cards/search?order=released&unique=prints&q=${q}`)
      if (r.ok) {
        const j = await r.json()
        for (const c of (j.data || [])) {
          const front = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal
          const back = c.card_faces?.[1]?.image_uris?.normal || ''
          if (front) out.push({ id: c.id, set: c.set_name, setCode: c.set, collector: c.collector_number, image_url: front, image_url_back: back })
        }
      }
    }
  } catch (e) {
    console.warn(`[printings] lookup failed for ${name}: ${e.message}`)
  }
  if (!out.length) console.warn(`[printings] 0 printings resolved for ${name}`)
  printsCache.set(name, out)
  return out
}
