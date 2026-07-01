// Merge MTG Lab's curated card data (cards.json) into the Forge catalog.
// MTG Lab's file is the user's own dataset: it carries the popularity rating
// (popularity %, copies_per_deck, decks) and known-good Scryfall CDN images.
// This is local (no network), so it works regardless of any proxy blocking
// Scryfall. Matched by card name; Forge-only cards keep their existing fields.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CATALOG = path.resolve(__dirname, '..', 'public', 'data', 'catalog.json')
const MTGLAB = process.env.MTGLAB_CARDS ||
  path.resolve(__dirname, '..', '..', '..', 'MTG_Lab', 'public', 'data', 'cards.json')

const norm = s => (s || '').toLowerCase().trim()

const lab = JSON.parse(fs.readFileSync(MTGLAB, 'utf8'))
const labArr = Array.isArray(lab) ? lab : (lab.cards || Object.values(lab))
const byName = new Map()
for (const c of labArr) {
  if (c && c.name) byName.set(norm(c.name), c)
}

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'))
let matched = 0, withImg = 0, withPop = 0
for (const card of catalog) {
  const l = byName.get(norm(card.name)) || byName.get(norm((card.name || '').split(' // ')[0]))
  if (l) {
    if (l.image_url) { card.image_url = l.image_url; withImg++ }
    card.image_url_back = l.image_url_back || card.image_url_back || ''
    if (l.usd_price != null) card.usd_price = l.usd_price
    card.popularity = parseFloat(String(l.popularity ?? 0).toString().replace('%', '')) || 0
    card.copies_per_deck = l.copies_per_deck ?? 0
    card.decks = l.decks ?? 0
    if (card.popularity > 0 || card.decks > 0) withPop++
    matched++
  } else {
    // Forge-only card not in MTG Lab: keep its (Scryfall) image; zero popularity.
    if (card.popularity == null) card.popularity = 0
    if (card.decks == null) card.decks = 0
  }
}

fs.writeFileSync(CATALOG, JSON.stringify(catalog))
console.log(`[merge-mtglab] ${matched}/${catalog.length} matched · ${withImg} images · ${withPop} with popularity → ${CATALOG}`)
