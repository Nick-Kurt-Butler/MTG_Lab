// Resolves token art for the UI from the committed public/data/tokens.json.
// Fully offline — no network. Tokens not in the file simply fall back to the
// themed placeholder rendered by CardSlot. Engine/headless play never calls this.

function specKey(card) {
  return [card.name, card._power, card._toughness, card.colorIdentity].join('|')
}

// Curated token database, loaded once.
let dbPromise = null
function loadDB() {
  if (!dbPromise) {
    dbPromise = fetch(`${import.meta.env.BASE_URL}data/tokens.json`).then(r => (r.ok ? r.json() : {})).catch(() => ({}))
  }
  return dbPromise
}

// Returns a Promise<string|null> resolving to a token image URL from tokens.json.
export async function fetchTokenImage(card) {
  const db = await loadDB()
  return db[specKey(card)]?.image_url || null
}
