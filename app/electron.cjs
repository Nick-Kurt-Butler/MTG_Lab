const { app, BrowserWindow, protocol, net, ipcMain, session } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawn, execSync } = require('child_process')

// Corporate TLS-inspection proxies frequently break HTTP/2, surfacing as
// net::ERR_HTTP2_PROTOCOL_ERROR on otherwise-reachable hosts (e.g. Scryfall card
// images). Forcing the whole Chromium network stack — including net.fetch — down
// to HTTP/1.1 sidesteps it so card art and the Scryfall API actually load.
app.commandLine.appendSwitch('disable-http2')

// Disk-backed image cache. Card art lives on cards.scryfall.io, which this
// machine's corporate proxy throttles/blocks intermittently, so loading 30k+
// images directly leaves random gaps. The renderer requests images via the
// custom `cardimg://fetch/<encoded-url>` scheme; the main process serves them
// from a local disk cache, fetching+saving on first miss (through Electron's
// authenticated network stack, which reaches Scryfall where raw fetch can't).
// After the first successful load an image is permanent and offline.
protocol.registerSchemesAsPrivileged([
  { scheme: 'cardimg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
])

const IMG_CACHE_DIR = path.join(app.getPath('userData'), 'imgcache')
const cacheFileFor = url => path.join(IMG_CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.jpg')
const PRINTS_CACHE_DIR = path.join(app.getPath('userData'), 'printscache')
const printsFileFor = name => path.join(PRINTS_CACHE_DIR, crypto.createHash('sha1').update(name).digest('hex') + '.json')

// The corporate TLS-inspection proxy resets connections under parallel load
// (ERR_CONNECTION_RESET), so we never fire image requests in bursts. Two
// independent lanes: an interactive lane for things the user is looking at
// (on-screen cards, the art picker) and a slower background lane for the warmer,
// so the picker never waits behind the warmer's huge backlog.
function makeLane(max) {
  let active = 0
  const q = []
  function pump() {
    while (active < max && q.length) {
      const job = q.shift()
      active++
      job().finally(() => { active--; pump() })
    }
  }
  return fn => new Promise((resolve, reject) => { q.push(() => fn().then(resolve, reject)); pump() })
}
const interactiveLane = makeLane(6)
const warmLane = makeLane(1)
function enqueueFetch(fn, prioritize = false) {
  return (prioritize ? interactiveLane : warmLane)(fn)
}

let warmStats = { ok: 0, fail: 0, total: 0 }

// Low-level GET via Electron's classic net.request API. Unlike net.fetch, this
// reliably sets request headers (net.fetch's undici layer crashes on header
// conversion in this Electron build) — and Scryfall's API *requires* User-Agent
// and Accept headers or it returns HTTP 400. Resolves to { status, ct, buffer }.
function httpGet(url, accept = '*/*') {
  return new Promise(resolve => {
    let req
    try { req = net.request({ method: 'GET', url }) } catch (e) { return resolve({ status: 0, error: e.message }) }
    try {
      req.setHeader('User-Agent', 'MTGForgeLab/1.0 (local MTG deck app)')
      req.setHeader('Accept', accept)
    } catch { /* ignore */ }
    const chunks = []
    req.on('response', res => {
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, ct: String(res.headers['content-type'] || ''), buffer: Buffer.concat(chunks) }))
      res.on('error', e => resolve({ status: 0, error: e.message }))
    })
    req.on('error', e => resolve({ status: 0, error: e.message }))
    req.end()
  })
}

async function fetchImage(url, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const r = await httpGet(url, 'image/*')
    if (r.status === 200 && !r.ct.includes('text/html') && r.buffer?.length) {
      try { fs.writeFileSync(cacheFileFor(url), r.buffer) } catch { /* best effort */ }
      return r.buffer
    }
    // ERR_CONNECTION_RESET etc. (status 0) — back off and retry.
    await new Promise(res => setTimeout(res, 500 * (i + 1)))
  }
  return null
}

function registerImageCache() {
  try { fs.mkdirSync(IMG_CACHE_DIR, { recursive: true }) } catch { /* ignore */ }
  protocol.handle('cardimg', async req => {
    let orig
    try { orig = decodeURIComponent(new URL(req.url).pathname.replace(/^\/+/, '')) } catch { orig = '' }
    if (!/^https?:/.test(orig)) return new Response('', { status: 400 })
    const file = cacheFileFor(orig)
    if (fs.existsSync(file)) {
      return new Response(fs.readFileSync(file), { headers: { 'content-type': 'image/jpeg' } })
    }
    const buf = await enqueueFetch(() => fetchImage(orig), true)
    if (!buf) return new Response('', { status: 502 })
    return new Response(buf, { headers: { 'content-type': 'image/jpeg' } })
  })
}

// Art-picker printings lookup, over IPC (the renderer can't fetch the custom
// scheme or Scryfall directly). Uses net.request (sends the User-Agent + Accept
// headers Scryfall requires), parses the printings, returns a compact array.
ipcMain.handle('scryfall:printings', async (_e, name) => {
  if (!name || typeof name !== 'string') return []
  // Disk-cached printings list, so reopening the picker (even across launches)
  // is instant and we don't re-hit Scryfall for the jpeg links each time.
  try { fs.mkdirSync(PRINTS_CACHE_DIR, { recursive: true }) } catch { /* ignore */ }
  const pf = printsFileFor(name)
  if (fs.existsSync(pf)) { try { return JSON.parse(fs.readFileSync(pf, 'utf8')) } catch { /* refetch */ } }
  const q = encodeURIComponent(`!"${name}"`)
  const url = `https://api.scryfall.com/cards/search?order=released&unique=prints&q=${q}`
  const text = await enqueueFetch(async () => {
    for (let i = 0; i < 4; i++) {
      const r = await httpGet(url, 'application/json')
      const body = r.buffer ? r.buffer.toString('utf8') : ''
      if (r.status === 200 && r.ct.includes('json')) { console.log(`[printings] 200 ${name}`); return body }
      // 400 (bad query) / 404 (no cards) are not transient — don't retry.
      if (r.status === 400 || r.status === 404) { console.warn(`[printings] HTTP ${r.status} ${name} :: ${body.slice(0, 200)}`); return '{"data":[]}' }
      if (r.error) console.warn(`[printings] net error ${r.error} ${name}`)
      else console.warn(`[printings] HTTP ${r.status} ${name}`)
      await new Promise(res => setTimeout(res, 500 * (i + 1)))
    }
    return null
  }, true)
  if (!text) return []
  try {
    const j = JSON.parse(text)
    const out = []
    for (const c of (j.data || [])) {
      const faces = c.image_uris || c.card_faces?.[0]?.image_uris
      const front = faces?.normal
      const thumb = faces?.small || faces?.normal
      const back = c.card_faces?.[1]?.image_uris?.normal || ''
      if (front) out.push({ id: c.id, set: c.set_name, setCode: c.set, collector: c.collector_number, image_url: front, image_url_back: back, thumb })
    }
    if (out.length) { try { fs.writeFileSync(printsFileFor(name), JSON.stringify(out)) } catch { /* best effort */ } }
    return out
  } catch { return [] }
})

// Background warmer: grind through the whole catalog one queue-slot at a time so
// the local image cache fills on its own without the user scrolling, and so the
// proxy isn't hit in bursts. Logs the real success rate so we know if the network
// is cooperating. Re-runnable: already-cached images are skipped instantly.
function warmImageCache() {
  let catalog
  for (const p of [path.join(APP_DIR, 'dist', 'data', 'catalog.json'), path.join(APP_DIR, 'public', 'data', 'catalog.json')]) {
    try { catalog = JSON.parse(fs.readFileSync(p, 'utf8')); break } catch { /* try next */ }
  }
  if (!catalog) { console.warn('[warm] catalog not found; skipping pre-cache'); return }
  const arr = Array.isArray(catalog) ? catalog : (catalog.cards || [])
  const urls = []
  for (const c of arr) {
    for (const u of [c.image_url, c.image_url_back]) {
      if (u && /^https?:/.test(u) && !fs.existsSync(cacheFileFor(u))) urls.push(u)
    }
  }
  warmStats = { ok: 0, fail: 0, total: urls.length }
  console.log(`[warm] starting background pre-cache of ${urls.length} uncached images`)
  let done = 0
  for (const u of urls) {
    enqueueFetch(() => fetchImage(u)).then(buf => {
      buf ? warmStats.ok++ : warmStats.fail++
      if (++done % 100 === 0 || done === urls.length) {
        console.log(`[warm] ${done}/${urls.length} ok=${warmStats.ok} fail=${warmStats.fail}`)
      }
    })
  }
}

// MTG Forge Lab desktop shell.
//   - Spawns the Java Forge bridge as a child process (so it's one click, not
//     two terminals), waits until it reports "listening", then opens the window.
//   - Kills the bridge when the app quits.
//
// Paths/behavior are configurable via env vars (with sensible repo-relative
// defaults), so you can point at other decks / pvp without editing code:
//   FORGE_JAVA, FORGE_BRIDGE_JAR, FORGE_GUI_DIR, FORGE_DECK_A, FORGE_DECK_B,
//   FORGE_PORT, FORGE_MODE (ai|pvp), FORGE_NO_SPAWN=1 (connect to an existing bridge)

const APP_DIR = __dirname
const REPO = path.resolve(APP_DIR, '..')            // MTG_Lab
const MTG = path.resolve(REPO, '..')                // parent of MTG_Lab

// Resolve runtime assets from the first location that exists, so the same code
// works when packaged (assets under process.resourcesPath via electron-builder
// extraResources) and in dev (built jar + the referenced Forge engine checkout).
const firstExisting = (...cands) => cands.find(p => p && fs.existsSync(p))
const RES = process.resourcesPath || ''
const isWin = process.platform === 'win32'
const javaExe = isWin ? 'java.exe' : 'java'

const cfg = {
  java: process.env.FORGE_JAVA
    || firstExisting(
         RES && path.join(RES, 'jre', 'bin', javaExe),                 // bundled JRE (packaged)
         '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java',
       )
    || javaExe,                                                        // else system Java on PATH
  jar: process.env.FORGE_BRIDGE_JAR
    || firstExisting(
         RES && path.join(RES, 'bridge.jar'),                          // packaged
         path.join(REPO, 'bridge', 'target', 'bridge.jar'),            // dev build
       ),
  forgeGui: process.env.FORGE_GUI_DIR
    || firstExisting(
         RES && path.join(RES, 'forge-gui'),                           // packaged card data
         path.join(REPO, 'engine', 'forge', 'forge-gui'),             // new engine layout
         path.join(MTG, 'forge-master', 'forge-gui'),                 // legacy location
       ),
  deckA: process.env.FORGE_DECK_A
    || firstExisting(RES && path.join(RES, 'test-decks', 'ca.dck'), path.join(REPO, 'bridge', 'test-decks', 'ca.dck')),
  deckB: process.env.FORGE_DECK_B
    || firstExisting(RES && path.join(RES, 'test-decks', 'cb.dck'), path.join(REPO, 'bridge', 'test-decks', 'cb.dck')),
  port: process.env.FORGE_PORT || '8088',
  mode: process.env.FORGE_MODE || 'menu',
}

let bridge = null
let win = null
let windowOpened = false

function spawnBridge() {
  if (process.env.FORGE_NO_SPAWN || bridge) return
  if (!fs.existsSync(cfg.jar)) {
    console.error('[electron] bridge jar not found:', cfg.jar, '— build it with `mvn -q package` in bridge/')
    return
  }
  // Free the port first: a leftover bridge from a previous run would otherwise
  // keep serving stale code while this fresh jar fails to bind (a recurring
  // "my changes didn't take effect" trap).
  try {
    const out = execSync(`lsof -ti tcp:${cfg.port} || true`, { encoding: 'utf8' }).trim()
    if (out) {
      console.log('[electron] freeing stale bridge on port', cfg.port, '(pids', out.replace(/\n/g, ',') + ')')
      execSync(`lsof -ti tcp:${cfg.port} | xargs kill -9 || true`)
    }
  } catch (e) { /* best effort */ }
  console.log('[electron] starting bridge:', cfg.jar, cfg.mode)
  bridge = spawn(cfg.java, ['-jar', cfg.jar, cfg.forgeGui, cfg.deckA, cfg.deckB, cfg.port, cfg.mode])
  bridge.stdout.on('data', d => process.stdout.write('[bridge] ' + d))
  bridge.stderr.on('data', d => process.stderr.write('[bridge] ' + d))
  bridge.on('exit', code => { console.log('[electron] bridge exited', code); bridge = null })
}

function createWindow() {
  if (windowOpened) return
  windowOpened = true
  win = new BrowserWindow({
    width: 1280, height: 860,
    backgroundColor: '#06060a',
    // webSecurity off so the app (loaded from file://) can fetch() its own
    // bundled data/catalog.json and art. Keeps the file:// origin so saved decks
    // in localStorage persist across launches. Safe for this local, offline app.
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false, preload: path.join(APP_DIR, 'preload.cjs') },
  })
  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5174')
  } else {
    win.loadFile(path.join(APP_DIR, 'dist', 'index.html'))
  }

  // Surface renderer-side problems in the same terminal as the bridge logs.
  // The battle UI is the tricky part, so make crashes loud instead of a black screen.
  if (!process.env.FORGE_NO_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' })
  const LEVELS = ['log', 'info', 'WARN', 'ERROR']
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer:${LEVELS[level] || level}] ${message}  (${sourceId}:${line})`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[electron] renderer gone:', details.reason, details.exitCode)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[electron] did-fail-load:', code, desc, url)
  })
}

app.whenReady().then(() => {
  // Scryfall rejects requests without a descriptive User-Agent (HTTP 400). Set one
  // at the session level so main-process net.fetch (images + printings) sends it,
  // instead of per-request headers (which crash this Electron/undici version).
  try { session.defaultSession.setUserAgent('MTGForgeLab/1.0 (Electron; local MTG deck app)') } catch { /* ignore */ }
  // Serve cached card images via the cardimg:// scheme before anything loads.
  registerImageCache()
  // Open the window immediately so the menu / deck builder are usable right away;
  // the engine bridge warms up in the background for when a game is started.
  createWindow()
  spawnBridge()
  // Fill the image cache in the background (throttled) so art stops depending on
  // live, burst network access. Delayed so it doesn't compete with first paint.
  setTimeout(warmImageCache, 8000)
})
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('quit', () => { if (bridge) bridge.kill() })
