// Catalog enrichment from Scryfall bulk data. Forge gives the card list; Scryfall
// gives reliable images + prices + legalities + popularity.
//
// Two modes, picked automatically by what's available:
//   • FULL  (default_cards bulk, every printing): reliable image from the MOST
//     STANDARD printing, cheapest price, legalities, edhrec_rank, and `multi_art`
//     (true only when the card has >1 distinct artwork — lets the UI hide the
//     "change art" control when there's no choice).
//   • LITE  (oracle_cards bulk, one printing per card): reliable image + price +
//     legalities + rank, but `multi_art` is left true (we can't count artworks
//     from one printing). Used as a fallback when the all-printings file can't be
//     downloaded (e.g. a proxy is blocking Scryfall).
//
// Run:  node --max-old-space-size=8192 scripts/enrich-catalog.mjs
//   FORCE_DOWNLOAD=1  re-download bulk
//   NO_DOWNLOAD=1     never hit the network; use whatever bulk is already cached

import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CATALOG = path.resolve(__dirname, '..', 'public', 'data', 'catalog.json')
const DC_TMP = path.join(os.tmpdir(), 'scryfall-default-cards.json')
const OR_TMP = path.join(os.tmpdir(), 'scryfall-oracle-cards.json')

const FORMATS = ['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'commander', 'pauper', 'brawl', 'historic', 'oathbreaker', 'penny', 'premodern']
const GOOD_SET_TYPES = new Set(['core', 'expansion', 'commander', 'masters', 'draft_innovation', 'starter', 'duel_deck', 'box'])
const norm = s => (s || '').toLowerCase().trim()
const imgs = c => ({ front: c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || '', back: c.card_faces?.[1]?.image_uris?.normal || '' })
const illust = c => c.illustration_id || c.card_faces?.[0]?.illustration_id || null
const legalOf = c => (c.legalities ? FORMATS.filter(f => c.legalities[f] === 'legal') : [])
const usdOf = c => (c.prices && c.prices.usd ? parseFloat(c.prices.usd) : null)

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'MTGForgeLab/1.0', Accept: 'application/json' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return getJson(res.headers.location).then(resolve, reject) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    https.get(url, { headers: { 'User-Agent': 'MTGForgeLab/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); file.close(); return download(res.headers.location, dest).then(resolve, reject) }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return }
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
    }).on('error', reject)
  })
}

const isBig = f => { try { return fs.statSync(f).size > 50e6 } catch { return false } }

function stdScore(c) {
  if (c.lang !== 'en' || !imgs(c).front) return -1
  let s = 0
  if (c.digital) s -= 100000
  if (c.image_status === 'highres_scan') s += 2000
  if (c.border_color === 'black') s += 800
  if (!c.promo) s += 400
  if (!c.full_art) s += 150
  if (!c.frame_effects || c.frame_effects.length === 0) s += 150
  if (c.frame === '2015') s += 120
  if (GOOD_SET_TYPES.has(c.set_type)) s += 300
  if (c.games && c.games.includes('paper')) s += 80
  return s
}

// FULL: group every printing by name; pick standard art, cheapest price, count arts.
function fullEnrich(sf, catalog) {
  const groups = new Map()
  for (const c of sf) {
    if (c.set_type === 'token' || c.layout === 'token' || c.layout === 'emblem' || c.layout === 'art_series') continue
    const names = [norm(c.name)]
    if (c.name.includes(' // ')) names.push(norm(c.name.split(' // ')[0]))
    for (const k of names) {
      let g = groups.get(k)
      if (!g) { g = { best: null, bestScore: -2, minPrice: null, arts: new Set(), legal: null, rank: null }; groups.set(k, g) }
      const sc = stdScore(c)
      if (sc > g.bestScore) { g.bestScore = sc; g.best = c }
      const usd = usdOf(c); if (usd != null && (g.minPrice == null || usd < g.minPrice)) g.minPrice = usd
      const il = illust(c); if (il && imgs(c).front) g.arts.add(il)
      if (g.legal == null && c.legalities) g.legal = legalOf(c)
      if (g.rank == null && typeof c.edhrec_rank === 'number') g.rank = c.edhrec_rank
    }
  }
  let withImg = 0, multi = 0, matched = 0
  for (const card of catalog) {
    const g = groups.get(norm(card.name)) || groups.get(norm((card.name || '').split(' // ')[0]))
    if (g && g.best) {
      const im = imgs(g.best)
      card.image_url = im.front || card.image_url
      card.image_url_back = im.back || ''
      card.usd_price = g.minPrice != null ? g.minPrice : 0
      card.legal = g.legal || []
      card.edhrec_rank = g.rank
      card.multi_art = g.arts.size > 1
      matched++; if (im.front) withImg++; if (card.multi_art) multi++
    } else { card.legal = Array.isArray(card.legal) ? card.legal : []; card.edhrec_rank = card.edhrec_rank ?? null; card.multi_art = false }
  }
  return `FULL: ${matched}/${catalog.length} matched · ${withImg} images · ${multi} multi-art`
}

// LITE: one printing per name; reliable image + price + legal + rank; multi_art=true.
function liteEnrich(sf, catalog) {
  const score = c => (typeof c.edhrec_rank === 'number' ? 1e6 : 0) + legalOf(c).length * 1000 + (usdOf(c) ? 1 : 0)
  const best = new Map()
  for (const c of sf) {
    if (c.layout === 'token' || c.layout === 'emblem' || c.layout === 'art_series') continue
    for (const k of [norm(c.name), ...(c.name.includes(' // ') ? [norm(c.name.split(' // ')[0])] : [])]) {
      const cur = best.get(k)
      if (!cur || score(c) > score(cur)) best.set(k, c)
    }
  }
  let withImg = 0, matched = 0
  for (const card of catalog) {
    const c = best.get(norm(card.name)) || best.get(norm((card.name || '').split(' // ')[0]))
    if (c) {
      const im = imgs(c)
      card.image_url = im.front || card.image_url
      card.image_url_back = im.back || ''
      card.usd_price = usdOf(c) ?? 0
      card.legal = legalOf(c)
      card.edhrec_rank = typeof c.edhrec_rank === 'number' ? c.edhrec_rank : null
      card.multi_art = true // unknown from one printing; keep the art control available
      matched++; if (im.front) withImg++
    } else { card.legal = Array.isArray(card.legal) ? card.legal : []; card.edhrec_rank = card.edhrec_rank ?? null; card.multi_art = card.multi_art ?? true }
  }
  return `LITE: ${matched}/${catalog.length} matched · ${withImg} images (no artwork counts — re-run with Scryfall reachable for those)`
}

async function ensureDefaultCards() {
  if (isBig(DC_TMP) && !process.env.FORCE_DOWNLOAD) return true
  if (process.env.NO_DOWNLOAD) return false
  try {
    console.log('[enrich] fetching Scryfall bulk index…')
    const index = await getJson('https://api.scryfall.com/bulk-data')
    const bulk = index.data.find(b => b.type === 'default_cards')
    console.log(`[enrich] downloading default_cards (${(bulk.size / 1e6).toFixed(0)}MB)…`)
    await download(bulk.download_uri, DC_TMP)
    if (isBig(DC_TMP)) return true
    fs.rmSync(DC_TMP, { force: true })
    return false
  } catch (e) {
    console.warn('[enrich] default_cards download failed:', e.message)
    try { fs.rmSync(DC_TMP, { force: true }) } catch {}
    return false
  }
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'))
  let result
  if (await ensureDefaultCards()) {
    console.log('[enrich] parsing default_cards…')
    result = fullEnrich(JSON.parse(fs.readFileSync(DC_TMP, 'utf8')), catalog)
  } else if (isBig(OR_TMP)) {
    console.warn('[enrich] all-printings file unavailable — using cached oracle bulk (LITE).')
    result = liteEnrich(JSON.parse(fs.readFileSync(OR_TMP, 'utf8')), catalog)
  } else {
    throw new Error('No Scryfall bulk available and download blocked. Connect to Scryfall and re-run.')
  }
  fs.writeFileSync(CATALOG, JSON.stringify(catalog))
  console.log('[enrich] done:', result, '→', CATALOG)
}

main().catch(e => { console.error('[enrich] failed:', e); process.exit(1) })
