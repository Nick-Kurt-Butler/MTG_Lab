import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadArtOverrides, setArtOverride, clearArtOverride, fetchPrintings, loadArtCounts, recordArtCount, loadDefaultCodes, resolveDefaultCode } from './engine/artOverrides.js'
import { cimg } from './engine/img.js'

const MTG_BACK = 'https://backs.scryfall.io/large/59/b/59b15dba-3a0e-4b44-a34e-4e498e494c7c.jpg?1698702067'

// Inlined theme
const colors = {
  bg:         '#040406',
  surface:    '#0a0a10',
  surfaceAlt: '#0e0e16',
  border:     '#c9a84c',
  gold:       '#d4a843',
  goldLight:  '#e8c45a',
  goldDim:    '#8a7030',
  text:       '#d4cabb',
  textMuted:  '#7a7060',
  red:        '#c03030',
  green:      '#50a050',
  blue:       '#5878b0',
}

const btnStyle = {
  background: 'rgba(8,8,14,0.9)',
  border: '1px solid rgba(201,168,76,0.5)',
  color: '#d4a843',
  borderRadius: 4,
  padding: '3px 8px',
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: "'Cinzel', serif",
  transition: 'all 0.15s ease',
}

const globalCSS = `
  @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600&family=Crimson+Text:ital,wght@0,400;0,600;1,400&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; }
  body {
    background: #040406;
    color: #d4cabb;
    font-family: 'Crimson Text', Georgia, serif;
  }
  h1,h2,h3,strong { font-family: 'Cinzel', serif; color: #d4a843; font-weight: 500; }
  button { font-family: 'Cinzel', serif; }
  button:hover { filter: brightness(1.15); }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(201,168,76,0.15); border-radius: 2px; }
`

const DECKS_KEY = 'mtg_decks'
const TRASH_KEY = 'mtg_decks_trash'
// Set to '1' once the fresh-install starter decks have been seeded. Guarantees
// the two starters appear exactly once on a new install and are NEVER re-seeded
// on a version update or after the user deletes them — so updates never disturb
// or resurrect deck data.
const SEEDED_KEY = 'mtg_seeded'
const MAX_TRASH = 10

function saveDecks(d) { localStorage.setItem(DECKS_KEY, JSON.stringify(d)) }
function loadDecksLocal() { try { return JSON.parse(localStorage.getItem(DECKS_KEY)||'{}') } catch { return {} } }
function loadTrash() { try { return JSON.parse(localStorage.getItem(TRASH_KEY)||'[]') } catch { return [] } }
function saveTrash(t) { localStorage.setItem(TRASH_KEY, JSON.stringify(t.slice(0, MAX_TRASH))) }

// Per-deck art assignments (separate from the global default in mtg_card_art, and
// separate from the game deck itself so counts/curve/battle are never touched):
//   { [deckName]: { [cardName]: [ { set, collector, image_url, image_url_back, qty } ] } }
// A card can have several art groups in one deck (e.g. two different Plains arts);
// any copies not covered by a group fall back to the global default art.
const DECK_ARTS_KEY = 'mtg_deck_arts'
function loadDeckArtsLocal() { try { return JSON.parse(localStorage.getItem(DECK_ARTS_KEY) || '{}') } catch { return {} } }
function saveDeckArts(a) { localStorage.setItem(DECK_ARTS_KEY, JSON.stringify(a)) }
// A printing "art code" as the deck sites write it, e.g. { set:'hob', collector:'194' } → "(HOB) 194".
function artCode(a) { return a && a.set && a.collector ? `(${String(a.set).toUpperCase()}) ${a.collector}` : '' }

const SORT_OPTS = ['name','cmc','price','popularity','type']
// "popularity" sorts by how many decks run the card (its real popularity signal).
const SORT_MAP = { name:'name', cmc:'cmc', price:'usd_price', popularity:'decks' }

// Card-type grouping order (shared by the deck list and the "type" sort).
const TYPE_ORDER = ['Creature','Planeswalker','Instant','Sorcery','Enchantment','Artifact','Land','Other']
function typeRankOf(card) {
  const bt = card?.base_type || ''
  for (let i = 0; i < TYPE_ORDER.length; i++) if (bt.includes(TYPE_ORDER[i])) return i
  return TYPE_ORDER.length
}

// Escape a user search term so it's safe inside a RegExp.
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
// Whole-word matcher: "bat" matches the word bat but not "battlefield". Multiple
// terms are AND-ed (each must appear as a whole word somewhere on the card).
function buildSearchMatchers(query) {
  const words = (query || '').toLowerCase().split(/\s+/).filter(Boolean)
  return words.map(w => new RegExp(`\\b${escapeRegex(w)}\\b`))
}
// Formats we expose as a legality filter. The value is the key Forge/Scryfall use
// in each card's `legal` array; the label is what we show on the pill.
const FORMATS = [
  ['standard','Standard'], ['pioneer','Pioneer'], ['modern','Modern'],
  ['legacy','Legacy'], ['vintage','Vintage'], ['pauper','Pauper'],
  ['commander','Commander'], ['brawl','Brawl'], ['historic','Historic'],
]
const COLOR_MAP = {'W':'White','U':'Blue','B':'Black','R':'Red','G':'Green','C':'Colorless'}
const RARITY_MAP = {'C':'Common','U':'Uncommon','R':'Rare','M':'Mythic','S':'Special','L':'Land'}
const TYPE_EXCLUDE = new Set(['Kindred','Snow','Basic'])
const COLOR_ACTIVE = {'W':'#f0ede0','U':'#4a7ab5','B':'#8a8a8a','R':'#c44','G':'#4a8a4a','C':'#888'}

// Small inline pencil (SVG, not an emoji) used for edit affordances.
function PencilIcon({ size = 12, color = colors.gold }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function ColorPill({ code, name, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding:'2px 7px', borderRadius:10, fontSize:10, cursor:'pointer', border:'none',
      background: active ? COLOR_ACTIVE[code] : 'rgba(255,255,255,0.06)',
      color: active ? (code==='W'||code==='C' ? '#222' : '#fff') : colors.textMuted,
      fontWeight: active ? 'bold' : 'normal',
      transition:'all 0.12s',
    }}>{code==='B'?'K':name[0]}</button>
  )
}

function FilterSection({ label, children }) {
  return (
    <div style={{borderTop:`1px solid ${colors.border}`,paddingTop:6}}>
      <div style={{fontSize:9,color:colors.textMuted,fontFamily:'Cinzel,serif',letterSpacing:'1px',marginBottom:4,textTransform:'uppercase'}}>{label}</div>
      {children}
    </div>
  )
}

function Pill({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding:'2px 7px',borderRadius:10,fontSize:10,cursor:'pointer',border:'none',
      background: active ? colors.gold : 'rgba(255,255,255,0.06)',
      color: active ? '#000' : colors.textMuted,
      fontWeight: active ? 'bold' : 'normal',
      transition:'all 0.12s',
    }}>{children}</button>
  )
}

function Toggle({ checked, onChange, children }) {
  return (
    <label style={{display:'flex',alignItems:'center',gap:5,cursor:'pointer',fontSize:10,color:colors.textMuted,marginTop:3}}>
      <input type="checkbox" checked={checked} onChange={onChange} style={{accentColor:colors.gold,width:11,height:11}} />
      {children}
    </label>
  )
}

function TypeDropdown({ options, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const toggle = t => onChange(selected.includes(t) ? selected.filter(x=>x!==t) : [...selected,t])
  return (
    <div style={{position:'relative'}}>
      <button onClick={()=>setOpen(o=>!o)} style={{
        width:'100%', padding:'5px 8px', background:'#1e1e24', border:`1px solid ${colors.border}`,
        color:colors.text, borderRadius:5, fontSize:11, textAlign:'left', cursor:'pointer',
        display:'flex', justifyContent:'space-between',
      }}>
        <span>{selected.length ? selected.join(', ') : 'Any type'}</span>
        <span>{open?'▲':'▼'}</span>
      </button>
      {open && (
        <div style={{position:'absolute',top:'100%',left:0,right:0,zIndex:100,
          background:'#1e1e24',border:`1px solid ${colors.border}`,borderRadius:5,
          maxHeight:200,overflowY:'auto',boxShadow:'0 4px 16px rgba(0,0,0,0.8)'}}>
          {selected.length>0 && (
            <div onClick={()=>onChange([])} style={{padding:'4px 8px',fontSize:10,color:'#8b2020',cursor:'pointer',borderBottom:`1px solid ${colors.border}`}}>
              Clear all
            </div>
          )}
          {options.map(t=>(
            <label key={t} style={{display:'flex',alignItems:'center',gap:6,padding:'4px 8px',cursor:'pointer',
              background:selected.includes(t)?`${colors.gold}11`:'transparent',fontSize:11,color:colors.text}}>
              <input type="checkbox" checked={selected.includes(t)} onChange={()=>toggle(t)} style={{accentColor:colors.gold}} />
              {t}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// Card art that survives a flaky network: images are served from Electron's
// on-disk cache (cardimg://), which fetches + retries through the authenticated
// network stack on first miss. If it still can't be had, we fall back to the
// card back so the grid never shows a broken icon.
function CardImg({ src, alt, style }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [src])
  const finalSrc = cimg((!src || failed) ? MTG_BACK : src)
  return (
    <img src={finalSrc} alt={alt} draggable={false} loading="lazy" style={style}
      onError={() => setFailed(true)} />
  )
}

// One card in the virtualized grid: hover-enlarge, +/- to deck, count badge,
// right-click to flip DFCs, 🎨 to choose alternate art (per-user override).
function CardCell({ card, width, count, flipped, artOverride, singleArt, onAdd, onRemove, onFlip, onArt }) {
  const frontUrl = artOverride?.image_url || card.image_url
  const backUrl = artOverride?.image_url_back || card.image_url_back
  return (
    <div style={{ width, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{ position: 'relative', width: '100%', cursor: 'pointer', transition: 'transform 0.15s ease, z-index 0s' }}
        onMouseEnter={e => {
          const el = e.currentTarget
          const rect = el.getBoundingClientRect()
          const box = (el.closest('.cards-viewport') || el).getBoundingClientRect()
          let ox = 'center', oy = 'center'
          if (rect.left - box.left < 80) ox = 'left'
          else if (box.right - rect.right < 80) ox = 'right'
          if (rect.top - box.top < 100) oy = 'top'
          else if (box.bottom - rect.bottom < 100) oy = 'bottom'
          el.style.transformOrigin = `${oy} ${ox}`
          el.style.transform = 'scale(2)'
          el.style.zIndex = '9999'
        }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.zIndex = '0' }}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onFlip(card.name) }}>
        <CardImg src={flipped ? (backUrl || MTG_BACK) : (frontUrl || MTG_BACK)} alt={card.name}
          style={{ width: '100%', borderRadius: 8, display: 'block', boxShadow: '0 2px 8px rgba(0,0,0,0.6)' }} />
        {/* Action bar along the bottom edge: −, flip (DFC), art, +. Kept off the
            top corners so the card's mana cost stays visible. */}
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '7%', display: 'flex', borderRadius: '0 0 8px 8px', overflow: 'hidden' }}>
          {count > 0 && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', borderRight: '1px solid rgba(201,168,76,0.3)', color: colors.gold, fontSize: 11, fontWeight: 'bold', fontFamily: 'Cinzel,serif', pointerEvents: 'none' }}>×{count}</div>
          )}
          <div onClick={e => { e.stopPropagation(); onRemove(card.name) }}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'background 0.12s', background: '#000', borderRight: '1px solid rgba(201,168,76,0.3)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(154,58,58,0.7)'}
            onMouseLeave={e => e.currentTarget.style.background = '#000'}>
            <span style={{ color: '#df7a7a', fontSize: 12, fontWeight: 'bold' }}>−</span>
          </div>
          {backUrl && (
            <div onClick={e => { e.stopPropagation(); onFlip(card.name) }} title="Flip card"
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'background 0.12s', background: flipped ? 'rgba(201,168,76,0.35)' : '#000', borderRight: '1px solid rgba(201,168,76,0.3)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(201,168,76,0.5)'}
              onMouseLeave={e => e.currentTarget.style.background = flipped ? 'rgba(201,168,76,0.35)' : '#000'}>
              <span style={{ color: colors.gold, fontSize: 12 }}>⟳</span>
            </div>
          )}
          {card.multi_art && !singleArt && (
            <div onClick={e => { e.stopPropagation(); onArt(card.name) }} title="Change art"
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'background 0.12s', background: '#000', borderRight: '1px solid rgba(201,168,76,0.3)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(201,168,76,0.5)'}
              onMouseLeave={e => e.currentTarget.style.background = '#000'}>
              <span style={{ fontSize: 10, opacity: artOverride ? 1 : 0.55 }}>🎨</span>
            </div>
          )}
          <div onClick={e => { e.stopPropagation(); onAdd(card.name) }}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'background 0.12s', background: '#000' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(74,154,74,0.7)'}
            onMouseLeave={e => e.currentTarget.style.background = '#000'}>
            <span style={{ color: '#7adf7a', fontSize: 12, fontWeight: 'bold' }}>+</span>
          </div>
        </div>
      </div>
      <div style={{ fontSize: 9, color: colors.textMuted }}>{card.rarity} · ${card.usd_price?.toFixed(2)}</div>
      {card.decks > 0 && <div style={{ fontSize: 9, color: '#7a7060' }}>{card.popularity > 0 ? `${card.popularity}% · ` : ''}{card.decks?.toLocaleString()} decks</div>}
    </div>
  )
}

// Alternate-art picker: fetches every printing of a card from Scryfall and lets
// the user set one as their per-user default. Modeled on the zone-viewer modal.
function ArtPicker({ name, current, deckMode, onPick, onReset, onClose, onCount }) {
  const [prints, setPrints] = useState(null)
  // In the deck view: "change" swaps just this printing's art; "add" adds a new
  // copy with the picked printing (a distinct art group) without touching others.
  const [addMode, setAddMode] = useState(false)
  useEffect(() => {
    let alive = true
    setPrints(null)
    fetchPrintings(name).then(p => { if (alive) { setPrints(p); onCount?.(name, p.length) } })
    return () => { alive = false }
  }, [name])
  const modeBtn = (on, label, sub) => ({
    fontSize: 10, padding: '4px 10px', borderRadius: 5, cursor: 'pointer', fontFamily: 'Cinzel,serif',
    background: on ? 'rgba(201,168,76,0.25)' : 'rgba(255,255,255,0.04)',
    border: `1px solid ${on ? colors.gold : colors.goldDim}`, color: on ? colors.gold : colors.textMuted,
  })
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(3px)' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: colors.surface, border: `1px solid ${colors.gold}`, borderRadius: 8, padding: 18, width: '85vw', maxWidth: 1400, maxHeight: '88vh', overflow: 'auto', minWidth: 360, boxShadow: `0 0 40px ${colors.gold}25` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid ${colors.border}` }}>
          <span style={{ fontSize: 14, color: colors.gold, fontFamily: 'Cinzel,serif', letterSpacing: 1 }}>Choose Art — {name}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {deckMode && (
              <div style={{ display: 'flex', gap: 4, marginRight: 4 }}>
                <button onClick={() => setAddMode(false)} style={modeBtn(!addMode)} title="Replace this printing's art">Change art</button>
                <button onClick={() => setAddMode(true)} style={modeBtn(addMode)} title="Add a new copy with the chosen art">Add new copy</button>
              </div>
            )}
            {current && <button onClick={onReset} style={{ ...btnStyle, fontSize: 10 }}>Reset to default</button>}
            <button onClick={onClose} style={{ ...btnStyle, fontSize: 10 }}>✕</button>
          </div>
        </div>
        {prints === null ? (
          <div style={{ color: colors.textMuted, padding: 30, textAlign: 'center', fontFamily: 'Cinzel,serif' }}>Loading printings…</div>
        ) : prints.length === 0 ? (
          <div style={{ color: colors.textMuted, padding: 30, textAlign: 'center' }}>No alternate printings found.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
            {prints.map(p => {
              const sel = current?.image_url === p.image_url
              return (
                <div key={p.id} onClick={() => onPick({ image_url: p.image_url, image_url_back: p.image_url_back, set: p.setCode, collector: p.collector }, addMode)}
                  style={{ cursor: 'pointer', textAlign: 'center', border: `2px solid ${sel ? colors.gold : 'transparent'}`, borderRadius: 8, padding: 4, transition: 'border-color 0.12s' }}>
                  <img src={cimg(p.image_url)} alt="" draggable={false} loading="lazy" style={{ width: '100%', borderRadius: 6, display: 'block', boxShadow: sel ? `0 0 10px ${colors.gold}` : '0 2px 8px rgba(0,0,0,0.6)' }} />
                  <div style={{ fontSize: 8, color: colors.textMuted, marginTop: 3 }}>{p.set} · #{p.collector}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default function Forge() {
  const nav = useNavigate()

  const [cards, setCards] = useState([])
  const [decks, setDecks] = useState({})
  const [activeDeck, setActiveDeck] = useState('')
  const [newDeckName, setNewDeckName] = useState('')
  const [vp, setVp] = useState({ w: 0, h: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const viewportRef = useRef(null)
  const obsRef = useRef(null)
  // Callback ref: measure the scroll viewport (re)attaching a ResizeObserver.
  const setViewport = useCallback(node => {
    viewportRef.current = node
    if (obsRef.current) { obsRef.current.disconnect(); obsRef.current = null }
    if (node) {
      const ro = new ResizeObserver(() => setVp({ w: node.clientWidth, h: node.clientHeight }))
      ro.observe(node); obsRef.current = ro
      setVp({ w: node.clientWidth, h: node.clientHeight })
    }
  }, [])
  function resetScroll() { setScrollTop(0); if (viewportRef.current) viewportRef.current.scrollTop = 0 }

  // Filters
  const [search, setSearch] = useState('')
  const [selColors, setSelColors] = useState([])
  const [colorOp, setColorOp] = useState('OR')       // OR | AND | XOR over the selected colors
  const [colorOnly, setColorOnly] = useState(false)  // card has ONLY the selected colors (no others)
  const [colorNot, setColorNot] = useState(false)    // invert the whole color match
  const [selRarities, setSelRarities] = useState([])
  const [selTypes, setSelTypes] = useState([])
  const [cmcRange, setCmcRange] = useState([0,20])
  const [priceRange, setPriceRange] = useState([0,500])
  const [sortBy, setSortBy] = useState('popularity')
  const [sortAsc, setSortAsc] = useState(false)
  const [selFormat, setSelFormat] = useState('')
  const [staplesOnly, setStaplesOnly] = useState(true)
  const [deckView, setDeckView] = useState(false)   // "Show deck": render the active deck's cards (with per-art duplicates) instead of the catalog
  const [flippedCards, setFlippedCards] = useState(new Set())
  const [overrides, setOverrides] = useState(loadArtOverrides)
  const [deckArts, setDeckArts] = useState(loadDeckArtsLocal)
  const [defaultCodes, setDefaultCodes] = useState(loadDefaultCodes)
  const [artCounts, setArtCounts] = useState(loadArtCounts)
  const [artPickerCard, setArtPickerCard] = useState(null)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/catalog.json`)
      .then(r => r.json())
      .then(arr => {
        arr.forEach(c => {
          c.all_types = new Set((c.type_line||'').split('//').flatMap(p=>p.split('—')[0].trim().split(' ')).filter(Boolean))
          c.base_type = (c.type_line||'').split('—')[0].trim()
          c.popularity = parseFloat(String(c.popularity||'0').replace('%','')) || 0
          c.cmc = c.cmc || 0
          c.usd_price = c.usd_price || 0
          c.multi_art = c.multi_art !== false
          c.color_identity = c.color_identity || 'C'
          c.colors = c.colors || 'C'
          // One lowercased haystack of every word on the card (name, both faces,
          // type line, rules text) for whole-word search.
          c._search = `${c.name||''} ${c.name_2||''} ${c.type_line||''} ${c.oracle_text||''}`.toLowerCase()
        })
        setCards(arr)
        setLoading(false)
      })
      .catch(e => { setLoadError(e.message); setLoading(false) })
    // User decks live in localStorage (in Electron's userData dir, separate from
    // the replaceable app bundle), so a version update never loses them.
    // Starter decks are seeded only on a true fresh install — exactly once.
    const local = loadDecksLocal()
    const seeded = localStorage.getItem(SEEDED_KEY) === '1'
    if (Object.keys(local).length) {
      setDecks(local)
      setActiveDeck(Object.keys(local)[0] || '')
      // Existing data present → mark as seeded so starters never reappear later.
      if (!seeded) localStorage.setItem(SEEDED_KEY, '1')
    } else if (!seeded) {
      // Fresh install: seed the starter decks once, then record that we did.
      fetch(`${import.meta.env.BASE_URL}data/decks.json`)
        .then(r => r.json())
        .then(d => {
          setDecks(d)
          const keys = Object.keys(d)
          if (keys.length) setActiveDeck(keys[0])
          localStorage.setItem(DECKS_KEY, JSON.stringify(d))
          localStorage.setItem(SEEDED_KEY, '1')
        })
    }
    // else: already seeded and the user has no decks → respect that, don't re-seed.
  }, [])

  // Resolve default-printing codes for the active deck's cards in the background
  // (cached permanently), so the text view shows an art code on every line.
  useEffect(() => {
    const names = Object.keys(decks[activeDeck] || {})
    if (!names.length || !cards.length) return
    let cancelled = false
    ;(async () => {
      let any = false
      for (const name of names) {
        if (cancelled) return
        if (loadDefaultCodes()[name]) continue
        const card = cards.find(x => x.name === name)
        const dc = await resolveDefaultCode(name, card?.image_url)
        if (dc) any = true
      }
      if (any && !cancelled) setDefaultCodes(loadDefaultCodes())
    })()
    return () => { cancelled = true }
  }, [activeDeck, cards, decks])

  const rarities = [...new Set(cards.map(c=>c.rarity).filter(Boolean))].sort()
  const allTypes = [...new Set(cards.flatMap(c=>[...c.all_types]).filter(t=>!TYPE_EXCLUDE.has(t)))].sort()

  const searchMatchers = buildSearchMatchers(search)
  // Left-panel filters (color/format/type/cmc/price/search/staples). Applied in
  // both catalog browse AND the deck view.
  const passesFilters = c => {
    if (staplesOnly && !c.decks) return false
    // Whole-word search across name/type/rules text; every term must match.
    if (searchMatchers.length && !searchMatchers.every(re => re.test(c._search || ''))) return false
    if (selColors.length) {
      // color_identity is a concatenated string like "BG" / "WUB", so split by char.
      const sel = new Set(selColors)
      const ci = (c.color_identity||'C').split('')
      const hits = ci.filter(x => sel.has(x)).length
      let base
      if (colorOp === 'AND') base = hits === selColors.length   // has all selected
      else if (colorOp === 'XOR') base = hits === 1             // exactly one selected
      else base = hits >= 1                                     // OR: at least one selected
      const subset = ci.every(x => sel.has(x))                  // no colors outside selection
      let res = colorOnly ? (base && subset) : base
      if (colorNot) res = !res
      if (!res) return false
    }
    if (selFormat && !(c.legal||[]).includes(selFormat)) return false
    if (selTypes.length && !selTypes.some(t=>c.all_types.has(t))) return false
    if (c.cmc < cmcRange[0] || c.cmc > cmcRange[1]) return false
    if (c.usd_price < priceRange[0] || c.usd_price > priceRange[1]) return false
    return true
  }
  const sortCmp = (a,b) => {
    // "type" groups exactly like the deck's right-panel list (Creature, PW,
    // Instant, …), then alphabetically within a type. The asc/desc toggle flips
    // the whole ordering.
    if (sortBy === 'type') {
      const ra = typeRankOf(a), rb = typeRankOf(b)
      const cmp = ra !== rb ? ra - rb : a.name.localeCompare(b.name)
      return sortAsc ? -cmp : cmp
    }
    const key = SORT_MAP[sortBy] || sortBy
    const av = a[key]||0, bv = b[key]||0
    if (typeof av === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av)
    return sortAsc ? av-bv : bv-av
  }
  const filteredCards = cards.filter(passesFilters).sort(sortCmp)
  // name -> catalog card (for the deck view to pull metadata/filtering).
  const cardMap = {}
  for (const c of cards) cardMap[c.name] = c

  const toggleFlip = name => setFlippedCards(s => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n })

  function addToDeck(name) {
    if (!activeDeck) return
    setDecks(d => {
      const nd = {...d, [activeDeck]: {...(d[activeDeck]||{}), [name]: (d[activeDeck]?.[name]||0)+1}}
      saveDecks(nd); return nd
    })
  }
  function removeFromDeck(name) {
    if (!activeDeck) return
    setDecks(d => {
      const deck = {...(d[activeDeck]||{})}
      deck[name] = (deck[name]||1)-1
      if (deck[name]<=0) delete deck[name]
      const nd = {...d,[activeDeck]:deck}
      saveDecks(nd); return nd
    })
  }
  // Deck-view +/-: add or remove a copy of the SPECIFIC printing shown on the
  // cell (matched by set/collector), keeping the total count and the per-art
  // group in sync so the shown artwork is what actually gets added.
  const sameArt = (g, art) => (g.set || '') === (art.set || '') && String(g.collector || '') === String(art.collector || '')
  function addDeckArtCopy(name, art) {
    if (!activeDeck) return
    setDecks(d => { const nd = { ...d, [activeDeck]: { ...(d[activeDeck] || {}), [name]: (d[activeDeck]?.[name] || 0) + 1 } }; saveDecks(nd); return nd })
    setDeckArts(prev => {
      const nd = { ...prev, [activeDeck]: { ...(prev[activeDeck] || {}) } }
      const groups = nd[activeDeck][name] ? nd[activeDeck][name].map(g => ({ ...g })) : []
      const g = groups.find(x => sameArt(x, art))
      if (g) g.qty = (g.qty || 0) + 1
      else groups.push({ set: art.set || '', collector: art.collector || '', image_url: art.image_url, image_url_back: art.image_url_back || '', qty: 1 })
      nd[activeDeck][name] = groups; saveDeckArts(nd); return nd
    })
  }
  function removeDeckArtCopy(name, art) {
    if (!activeDeck) return
    setDecks(d => { const deck = { ...(d[activeDeck] || {}) }; deck[name] = (deck[name] || 1) - 1; if (deck[name] <= 0) delete deck[name]; const nd = { ...d, [activeDeck]: deck }; saveDecks(nd); return nd })
    setDeckArts(prev => {
      const nd = { ...prev, [activeDeck]: { ...(prev[activeDeck] || {}) } }
      let groups = nd[activeDeck][name] ? nd[activeDeck][name].map(g => ({ ...g })) : []
      const g = groups.find(x => sameArt(x, art))
      if (g) { g.qty = (g.qty || 0) - 1; if (g.qty <= 0) groups = groups.filter(x => x !== g) }
      if (groups.length) nd[activeDeck][name] = groups; else delete nd[activeDeck][name]
      saveDeckArts(nd); return nd
    })
  }
  // Deck LIST +/-: one row per card. + adds a copy of the art with the FEWEST
  // copies; − removes from the art with the MOST. A code-less default copy just
  // adjusts the total.
  function addSmallest(name, total) {
    const entries = deckEntriesFor(name, total)
    if (!entries.length) return addToDeck(name)
    const e = entries.reduce((a, b) => (b.qty < a.qty ? b : a))
    if (e.set) addDeckArtCopy(name, e); else addToDeck(name)
  }
  function removeLargest(name, total) {
    const entries = deckEntriesFor(name, total)
    if (!entries.length) return removeFromDeck(name)
    const e = entries.reduce((a, b) => (b.qty > a.qty ? b : a))
    if (e.set) removeDeckArtCopy(name, e); else removeFromDeck(name)
  }
  // Re-art just ONE printing: move its `qty` copies from `fromArt` (a group, or
  // the unassigned default pool) to `newArt`. Total unchanged, other art groups
  // of the same card are untouched (so mixed art no longer collapses).
  function setGroupArt(name, fromArt, qty, newArt) {
    if (!activeDeck || qty <= 0) return
    setDeckArts(prev => {
      const nd = { ...prev, [activeDeck]: { ...(prev[activeDeck] || {}) } }
      let groups = nd[activeDeck][name] ? nd[activeDeck][name].map(g => ({ ...g })) : []
      const from = groups.find(g => sameArt(g, fromArt))
      if (from) { from.qty = (from.qty || 0) - qty; if (from.qty <= 0) groups = groups.filter(g => g !== from) }
      const to = groups.find(g => sameArt(g, newArt))
      if (to) to.qty = (to.qty || 0) + qty
      else groups.push({ set: newArt.set || '', collector: newArt.collector || '', image_url: newArt.image_url, image_url_back: newArt.image_url_back || '', qty })
      if (groups.length) nd[activeDeck][name] = groups; else delete nd[activeDeck][name]
      saveDeckArts(nd); return nd
    })
  }
  function createDeck() {
    if (!newDeckName || decks[newDeckName]) return
    setDecks(d => { const nd={...d,[newDeckName]:{}}; saveDecks(nd); return nd })
    setActiveDeck(newDeckName); setNewDeckName('')
  }
  function deleteDeck() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    const deckData = decks[activeDeck]
    const trashEntry = { name: activeDeck, cards: deckData, deletedAt: Date.now() }
    const newTrash = [trashEntry, ...trash].slice(0, MAX_TRASH)
    setTrash(newTrash); saveTrash(newTrash)
    setDecks(d => { const nd={...d}; delete nd[activeDeck]; saveDecks(nd); setActiveDeck(Object.keys(nd)[0]||''); return nd })
    setConfirmDelete(false)
  }
  function restoreDeck(idx) {
    const entry = trash[idx]
    if (!entry) return
    const name = decks[entry.name] ? `${entry.name} (restored)` : entry.name
    setDecks(d => { const nd = { ...d, [name]: entry.cards }; saveDecks(nd); return nd })
    setActiveDeck(name)
    const newTrash = trash.filter((_, i) => i !== idx)
    setTrash(newTrash); saveTrash(newTrash)
  }

  const deck = decks[activeDeck]||{}
  const deckTotal = Object.values(deck).reduce((s,v)=>s+v,0)

  // The art to show for a card right now: the active deck's chosen art when a
  // deck filter is on (its primary group), otherwise the global default. Picking
  // art on the main view (no filter) edits the global default.
  function effectiveArt(name) {
    if (deckView) {
      const g = deckArts[activeDeck]?.[name]?.[0]
      if (g) return { image_url: g.image_url, image_url_back: g.image_url_back }
    }
    return overrides[name] || null
  }
  function clearDeckArt(deckName, name) {
    setDeckArts(prev => { const nd = { ...prev, [deckName]: { ...(prev[deckName] || {}) } }; delete nd[deckName][name]; saveDeckArts(nd); return nd })
  }
  // Split a card's copies into display entries: one per art group (capped to the
  // real count) plus a default-art remainder. Drives the deck list (duplicates
  // for mixed art) and the text export.
  function deckEntriesFor(name, total) {
    const groups = deckArts[activeDeck]?.[name] || []
    const out = []
    let assigned = 0
    for (const g of groups) {
      const q = Math.min(g.qty || 0, total - assigned)
      if (q > 0) { out.push({ qty: q, code: artCode(g), set: g.set, collector: g.collector, image_url: g.image_url, image_url_back: g.image_url_back }); assigned += q }
    }
    const rem = total - assigned
    // Default copies carry the global-default override's code, else the card's
    // resolved default-printing code, so every line ends up with an art code.
    const dOv = overrides[name]
    const dc = dOv?.set ? dOv : defaultCodes[name]
    const defEntry = { code: artCode(dOv) || artCode(defaultCodes[name]), set: dc?.set || '', collector: dc?.collector || '', image_url: dOv?.image_url, image_url_back: dOv?.image_url_back, isDefault: true }
    if (out.length === 0) out.push({ qty: total, ...defEntry })
    else if (rem > 0) out.push({ qty: rem, ...defEntry })
    return out
  }

  // "Show deck" view: one grid cell per art group (so mixed art duplicates, e.g.
  // two different Plains), each with its own art + count, filtered by the left
  // panel and sorted like the catalog. Off = normal catalog browse.
  function buildDeckViewCells() {
    const out = []
    for (const [name, total] of Object.entries(deck)) {
      const c = cardMap[name]
      if (!c || !passesFilters(c)) continue
      deckEntriesFor(name, total).forEach((e, i) => {
        out.push({ card: c, qty: e.qty, art: { image_url: e.image_url, image_url_back: e.image_url_back, set: e.set, collector: e.collector }, key: `${name}#${i}` })
      })
    }
    return out.sort((a, b) => sortCmp(a.card, b.card))
  }
  const displayList = deckView
    ? buildDeckViewCells()
    : filteredCards.map(c => ({ card: c, qty: deck[c.name], art: effectiveArt(c.name), key: c.name }))

  // ── Virtualized grid geometry (only the visible rows are rendered) ──
  const GAP = 12, PAD = 12, CARD_MIN = 110, CARD_RATIO = 0.715, LABEL_H = 32, OVERSCAN = 3
  const innerW = Math.max(0, vp.w - PAD * 2)
  const cols = Math.max(1, Math.floor((innerW + GAP) / (CARD_MIN + GAP)))
  const cardW = (innerW - GAP * (cols - 1)) / cols
  const rowH = cardW / CARD_RATIO + LABEL_H + GAP
  const totalRows = Math.ceil(displayList.length / cols)
  const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN)
  const lastRow = Math.min(totalRows, Math.ceil((scrollTop + vp.h) / rowH) + OVERSCAN)
  const deckCost = Object.entries(deck).reduce((s,[n,q])=>{const c=cards.find(x=>x.name===n);return s+(c?.usd_price||0)*q},0)

  // Mana curve data
  const manaCurve = {}
  Object.entries(deck).forEach(([name,qty])=>{
    const c=cards.find(x=>x.name===name); const cmc=Math.min(c?.cmc||0,7)
    manaCurve[cmc]=(manaCurve[cmc]||0)+qty
  })
  const maxCurve = Math.max(1,...Object.values(manaCurve))

  // Color distribution
  const colorDist = {}
  Object.entries(deck).forEach(([name,qty])=>{
    const c=cards.find(x=>x.name===name)
    ;(c?.color_identity||'C').split('').forEach(col=>{ colorDist[col]=(colorDist[col]||0)+qty })
  })
  const totalColorPips = Math.max(1,Object.values(colorDist).reduce((s,v)=>s+v,0))

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [trash, setTrash] = useState(() => loadTrash())
  const [showTrash, setShowTrash] = useState(false)
  // Deck-name rename (pencil in the deck picker) + edit-as-text (pencil on the
  // Deck section) state.
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [deckEdit, setDeckEdit] = useState(false)
  const [deckText, setDeckText] = useState('')

  function commitRename() {
    const newName = renameVal.trim()
    if (!newName || newName === activeDeck || decks[newName]) { setRenaming(false); return }
    setDecks(d => { const nd = { ...d }; nd[newName] = nd[activeDeck]; delete nd[activeDeck]; saveDecks(nd); return nd })
    setActiveDeck(newName); setRenaming(false)
  }

  // Deck ⇄ text. Each line is "qty Name", plus an optional [set:collector] art
  // code when the card has a chosen printing, so art survives copy/paste/import.
  // Every line carries the printing art code "(SET) COLLECTOR" when known; mixed
  // art shows as multiple lines for the same card (e.g. two different Plains).
  function deckToText() {
    const lines = []
    for (const [name, total] of Object.entries(deck)) {
      for (const e of deckEntriesFor(name, total)) lines.push(`${e.qty} ${name}${e.code ? ' ' + e.code : ''}`)
    }
    return lines.join('\n')
  }
  function applyDeckText(text) {
    const newDeck = {}
    const linesByName = {}   // name -> [{ set?, collector?, qty }] in order
    text.split('\n').forEach(line => {
      const t = line.trim()
      if (!t) return
      // "N Name (SET) COLLECTOR" (deck-site style) or legacy "N Name [set:collector]".
      const m = t.match(/^(\d+)\s+(.+?)(?:\s+\(([^)]+)\)\s*(\S+)|\s+\[([^:\]]+):([^\]]+)\])?$/)
      if (!m) return
      const qty = parseInt(m[1]); if (!(qty > 0)) return
      const name = m[2].trim()
      newDeck[name] = (newDeck[name] || 0) + qty
      const set = m[3] || m[5], collector = m[4] || m[6]
      ;(linesByName[name] = linesByName[name] || []).push({ set: set && set.trim(), collector: collector && collector.trim(), qty })
    })
    if (!Object.keys(newDeck).length) return
    setDecks(d => { const nd = { ...d, [activeDeck]: newDeck }; saveDecks(nd); return nd })
    // Resolve every line to a printing and store as this deck's per-card art. A
    // line with an explicit (SET) code uses that printing; a line with NO code
    // gets the card's default printing code attached, so every copy is art-coded.
    ;(async () => {
      const resolved = {}
      for (const [name, lines] of Object.entries(linesByName)) {
        const card = cards.find(x => x.name === name)
        let prints = null
        const arr = []
        for (const ln of lines) {
          let code = (ln.set && ln.collector) ? { set: ln.set, collector: ln.collector } : null
          if (!code) code = await resolveDefaultCode(name, card?.image_url)   // backfill default
          let art = { set: '', collector: '', image_url: card?.image_url, image_url_back: card?.image_url_back || '' }
          if (code) {
            try { prints = prints || await fetchPrintings(name) } catch { prints = [] }
            const p = (prints || []).find(x => (x.setCode || '').toLowerCase() === code.set.toLowerCase() && String(x.collector) === String(code.collector))
            art = { set: code.set, collector: code.collector, image_url: p ? p.image_url : card?.image_url, image_url_back: p ? p.image_url_back : (card?.image_url_back || '') }
          }
          arr.push({ ...art, qty: ln.qty })
        }
        resolved[name] = arr
      }
      setDeckArts(prev => {
        const nd = { ...prev, [activeDeck]: { ...(prev[activeDeck] || {}) } }
        for (const [name, arr] of Object.entries(resolved)) nd[activeDeck][name] = arr
        saveDeckArts(nd); return nd
      })
      setDefaultCodes(loadDefaultCodes())
    })()
  }

  // Type order for deck display (TYPE_ORDER is defined at module scope).
  function getBaseType(name) {
    const c = cards.find(x=>x.name===name)
    if (!c) return 'Other'
    for (const t of TYPE_ORDER) if ((c.base_type||'').includes(t)) return t
    return 'Other'
  }
  const grouped = {}
  Object.entries(deck).forEach(([name,qty]) => {
    const t = getBaseType(name)
    if (!grouped[t]) grouped[t]=[]
    grouped[t].push({name,qty})
  })

  const [showFilters, setShowFilters] = useState(true)
  const [showDeckPanel, setShowDeckPanel] = useState(true)

  if (loading) return (
    <><style>{globalCSS}</style>
    <div style={{minHeight:'100vh',background:'#0d0d0f',display:'flex',alignItems:'center',justifyContent:'center',color:colors.gold,fontFamily:'Cinzel,serif',fontSize:16}}>Loading cards...</div></>
  )
  if (loadError) return (
    <><style>{globalCSS}</style>
    <div style={{minHeight:'100vh',background:'#0d0d0f',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:12,color:'#8b2020',fontFamily:'Cinzel,serif'}}>
      <div style={{fontSize:16}}>Failed to load cards</div>
      <div style={{fontSize:12,color:colors.textMuted}}>{loadError}</div>
      <button onClick={()=>nav('/')} style={{...btnStyle,marginTop:8}}>← Home</button>
    </div></>
  )

  return (
    <>
      <style>{globalCSS}</style>
      {artPickerCard && (
        <ArtPicker name={artPickerCard.name} deckMode={deckView}
          current={deckView ? artPickerCard.art : overrides[artPickerCard.name]}
          onPick={(art, addMode) => {
            const nm = artPickerCard.name
            if (!deckView) { setArtOverride(nm, art); setOverrides(loadArtOverrides()) }        // catalog: global default
            else if (addMode) { addDeckArtCopy(nm, art) }                                        // deck: add a new copy with this art
            else { setGroupArt(nm, artPickerCard.art || {}, artPickerCard.qty || 0, art) }       // deck: re-art just this printing
            setArtPickerCard(null)
          }}
          onReset={() => {
            const nm = artPickerCard.name
            if (deckView) clearDeckArt(activeDeck, nm)
            else { clearArtOverride(nm); setOverrides(loadArtOverrides()) }
            setArtPickerCard(null)
          }}
          onCount={(name, n) => { if (recordArtCount(name, n)) setArtCounts(loadArtCounts()) }}
          onClose={() => setArtPickerCard(null)} />
      )}
      <div style={{display:'flex',height:'100vh',background:'#0a0a0e',position:'relative'}}>

        {/* Sidebar filters — collapsible */}
        {showFilters ? (
        <div style={{display:'flex',flexShrink:0}}>
          <div className="sidebar-filters" style={{width:200,padding:'10px 8px',overflowY:'auto',
            borderRight:`1px solid ${colors.border}`,display:'flex',flexDirection:'column',gap:8,
            background:'#0a0a0e',position:'relative',zIndex:1}}>

          <input value={search} onChange={e=>{setSearch(e.target.value);resetScroll()}} placeholder="Search cards..."
            style={{padding:'5px 8px',background:'#1a1a20',border:`1px solid ${colors.border}`,
              color:colors.text,borderRadius:6,fontSize:11,outline:'none',width:'100%'}} />

          <FilterSection label="Color">
            <div style={{display:'flex',flexWrap:'wrap',gap:3}}>
              {Object.entries(COLOR_MAP).map(([code,name])=>(
                <ColorPill key={code} code={code} name={name} active={selColors.includes(code)}
                  onClick={()=>{setSelColors(s=>s.includes(code)?s.filter(x=>x!==code):[...s,code]);resetScroll()}} />
              ))}
            </div>
            <div style={{display:'flex',flexWrap:'wrap',gap:3,marginTop:5}}>
              {['OR','AND','XOR'].map(op=>(
                <Pill key={op} active={colorOp===op} onClick={()=>{setColorOp(op);resetScroll()}}>{op}</Pill>
              ))}
            </div>
            <div style={{display:'flex',flexWrap:'wrap',gap:3,marginTop:4}}>
              <Pill active={colorOnly} onClick={()=>{setColorOnly(o=>!o);resetScroll()}}>Only</Pill>
              <Pill active={colorNot} onClick={()=>{setColorNot(n=>!n);resetScroll()}}>Not</Pill>
            </div>
          </FilterSection>

          <FilterSection label="Format Legality">
            <div style={{display:'flex',flexWrap:'wrap',gap:3}}>
              {FORMATS.map(([key,label])=>(
                <Pill key={key} active={selFormat===key}
                  onClick={()=>{setSelFormat(f=>f===key?'':key);resetScroll()}}>{label}</Pill>
              ))}
            </div>
          </FilterSection>

          <FilterSection label="Type">
            <TypeDropdown options={allTypes} selected={selTypes} onChange={v=>{setSelTypes(v);resetScroll()}} />
          </FilterSection>

          <FilterSection label="Sort">
            <div style={{display:'flex',flexWrap:'wrap',gap:3}}>
              {SORT_OPTS.map(o=>(
                <Pill key={o} active={sortBy===o} onClick={()=>{
                  if(sortBy===o) setSortAsc(a=>!a)
                  else { setSortBy(o); setSortAsc(false) }
                }}>{o}{sortBy===o ? (sortAsc?' ↑':' ↓') : ''}</Pill>
              ))}
            </div>
          </FilterSection>

          <Toggle checked={staplesOnly} onChange={e=>{setStaplesOnly(e.target.checked);resetScroll()}}>Staples only</Toggle>
        </div>
          <div style={{width:20,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',
            borderRight:`1px solid ${colors.border}`,background:'#0a0a0e',cursor:'pointer'}}
            onClick={()=>setShowFilters(false)} title="Collapse Filters">
            <span style={{writingMode:'vertical-rl',fontSize:9,color:colors.textMuted,fontFamily:'Cinzel,serif',letterSpacing:'1px'}}>◀ Filters</span>
          </div>
        </div>
        ) : (
          <div style={{width:20,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',
            borderRight:`1px solid ${colors.border}`,background:'#0a0a0e',cursor:'pointer'}}
            onClick={()=>setShowFilters(true)} title="Show Filters">
            <span style={{writingMode:'vertical-rl',fontSize:9,color:colors.textMuted,fontFamily:'Cinzel,serif',letterSpacing:'1px'}}>▶ Filters</span>
          </div>
        )}

        {/* Card grid (virtualized) */}
        <div className="card-grid" style={{flex:1,display:'flex',flexDirection:'column',height:'100vh',maxHeight:'100vh',position:'relative',zIndex:10}}>
          <div style={{display:'flex',alignItems:'center',gap:8,padding:'12px 12px 8px'}}>
            <button onClick={()=>nav('/')} style={{...btnStyle,fontSize:10}}>← Home</button>
            <span style={{color:colors.textMuted,fontSize:12}}>{displayList.length.toLocaleString()} cards{deckView ? ` · ${activeDeck}` : ''}</span>
          </div>
          <div ref={setViewport} className="cards-viewport"
            onScroll={e=>setScrollTop(e.currentTarget.scrollTop)}
            style={{flex:1,overflowY:'auto',overflowX:'hidden',position:'relative',padding:`0 ${PAD}px ${PAD}px`}}>
            <div style={{height: totalRows * rowH, position:'relative'}}>
              {vp.w > 0 && Array.from({length: Math.max(0, lastRow - firstRow)}, (_, k) => {
                const row = firstRow + k
                const items = displayList.slice(row * cols, row * cols + cols)
                return (
                  <div key={row} style={{position:'absolute', top: row * rowH, left:0, right:0, display:'flex', gap:GAP}}>
                    {items.map(it => {
                      // In the deck view, +/- act on the exact printing shown on
                      // the cell. In catalog browse (or a code-less default cell)
                      // they just change the count.
                      const artAdd = deckView && it.art?.set
                      return (
                        <CardCell key={it.key} card={it.card} width={cardW}
                          count={it.qty} flipped={flippedCards.has(it.card.name)}
                          artOverride={it.art}
                          singleArt={artCounts[it.card.name] === 1}
                          onAdd={artAdd ? () => addDeckArtCopy(it.card.name, it.art) : addToDeck}
                          onRemove={artAdd ? () => removeDeckArtCopy(it.card.name, it.art) : removeFromDeck}
                          onFlip={toggleFlip}
                          onArt={() => setArtPickerCard(deckView ? { name: it.card.name, art: it.art, qty: it.qty } : { name: it.card.name })} />
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Deck panel — collapsible */}
        {showDeckPanel ? (
        <div style={{display:'flex',flexShrink:0}}>
          <div style={{width:20,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',
            borderLeft:`1px solid ${colors.border}`,background:'#0a0a0e',cursor:'pointer'}}
            onClick={()=>setShowDeckPanel(false)} title="Collapse Deck">
            <span style={{writingMode:'vertical-rl',fontSize:9,color:colors.textMuted,fontFamily:'Cinzel,serif',letterSpacing:'1px'}}>Deck ▶</span>
          </div>
        <div className="deck-panel" style={{width:240,padding:'12px 10px',overflowY:'auto',borderLeft:`1px solid ${colors.border}`,
          display:'flex',flexDirection:'column',gap:8,background:'#0a0a0e',height:'100vh',maxHeight:'100vh',position:'relative',zIndex:1}}>
          <h3 style={{fontSize:13,letterSpacing:'2px'}}>Decks</h3>
          <div style={{display:'flex',gap:4}}>
            <input value={newDeckName} onChange={e=>setNewDeckName(e.target.value)} placeholder="New deck..."
              onKeyDown={e=>e.key==='Enter'&&createDeck()}
              style={{flex:1,padding:'4px 6px',background:'#1e1e24',border:`1px solid ${colors.border}`,color:colors.text,borderRadius:5,fontSize:11,outline:'none'}} />
            <button onClick={createDeck} style={{...btnStyle,fontSize:11}}>+</button>
          </div>
          {renaming ? (
            <div style={{display:'flex',gap:4}}>
              <input value={renameVal} onChange={e=>setRenameVal(e.target.value)} autoFocus
                onKeyDown={e=>{if(e.key==='Enter')commitRename();if(e.key==='Escape')setRenaming(false)}}
                style={{flex:1,padding:'4px 6px',background:'#1e1e24',border:`1px solid ${colors.border}`,color:colors.text,borderRadius:5,fontSize:11,outline:'none'}} />
              <button onClick={commitRename} style={{...btnStyle,fontSize:10,color:colors.gold}}>✓</button>
              <button onClick={()=>setRenaming(false)} style={{...btnStyle,fontSize:10}}>✕</button>
            </div>
          ) : (
            <div style={{display:'flex',gap:4,alignItems:'center'}}>
              <select value={activeDeck} onChange={e=>{setActiveDeck(e.target.value);setConfirmDelete(false)}}
                style={{flex:1,padding:'4px',background:'#1e1e24',border:`1px solid ${colors.border}`,color:colors.text,borderRadius:5,fontSize:11}}>
                {Object.keys(decks).map(d=><option key={d}>{d}</option>)}
              </select>
              {activeDeck && (
                <button onClick={()=>{setRenameVal(activeDeck);setRenaming(true)}} title="Rename deck"
                  style={{...btnStyle,padding:'4px 7px',display:'flex',alignItems:'center'}}><PencilIcon /></button>
              )}
            </div>
          )}
          {activeDeck && (
            <>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                <span style={{fontSize:11,color:colors.textMuted}}>{deckTotal} cards · ${deckCost.toFixed(2)}</span>
                <Toggle checked={deckView} onChange={e => {
                  // Show the deck's actual cards (with per-art duplicates + chosen
                  // art). Left-panel filters still apply; staples-only is dropped
                  // so every deck card shows regardless of staple status.
                  if (e.target.checked) { setDeckView(true); setStaplesOnly(false); resetScroll() }
                  else { setDeckView(false); resetScroll() }
                }}>Show deck</Toggle>
              </div>
              {showTrash && trash.length > 0 && (
                <div style={{background:'#1a1a20',border:`1px solid ${colors.border}`,borderRadius:6,padding:8}}>
                  <div style={{fontSize:9,color:colors.textMuted,fontFamily:'Cinzel,serif',letterSpacing:'1px',marginBottom:6}}>Recently Deleted</div>
                  {trash.map((entry, i) => (
                    <div key={i} style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:6,
                      padding:'3px 4px',borderRadius:4,background:'rgba(255,255,255,0.02)',marginBottom:2}}>
                      <span style={{fontSize:10,color:colors.text,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                        {entry.name} ({Object.values(entry.cards||{}).reduce((s,v)=>s+v,0)})
                      </span>
                      <button onClick={()=>restoreDeck(i)} style={{...btnStyle,fontSize:9,padding:'1px 6px',color:colors.gold}}>Restore</button>
                    </div>
                  ))}
                </div>
              )}

              {deckTotal > 0 && (
                <>
                  {/* Mana Curve */}
                  <div style={{borderTop:`1px solid ${colors.border}`,paddingTop:6}}>
                    <div style={{fontSize:9,color:colors.textMuted,fontFamily:'Cinzel,serif',letterSpacing:'1px',marginBottom:8,textTransform:'uppercase'}}>Mana Curve</div>
                    <div style={{display:'flex',alignItems:'flex-end',gap:3,height:50}}>
                      {[0,1,2,3,4,5,6,7].map(cmc=>{
                        const count=manaCurve[cmc]||0
                        return (
                          <div key={cmc} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center'}}>
                            {count>0 && <span style={{fontSize:8,color:colors.gold,marginBottom:2}}>{count}</span>}
                            <div style={{width:'100%',background:count?colors.gold:'transparent',borderRadius:2,
                              height:`${count/maxCurve*36}px`,minHeight:count?3:0,transition:'height 0.2s'}} />
                            <span style={{fontSize:8,color:colors.textMuted,marginTop:2}}>{cmc===7?'7+':cmc}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* Color Distribution */}
                  <div style={{borderTop:`1px solid ${colors.border}`,paddingTop:6}}>
                    <div style={{fontSize:9,color:colors.textMuted,fontFamily:'Cinzel,serif',letterSpacing:'1px',marginBottom:4}}>COLORS</div>
                    <div style={{display:'flex',gap:2,height:8,borderRadius:4,overflow:'hidden'}}>
                      {Object.entries(colorDist).sort((a,b)=>b[1]-a[1]).map(([col,count])=>(
                        <div key={col} style={{flex:count,background:COLOR_ACTIVE[col]||'#888',transition:'flex 0.2s'}}
                          title={`${COLOR_MAP[col]||col}: ${count} (${Math.round(count/totalColorPips*100)}%)`} />
                      ))}
                    </div>
                    <div style={{display:'flex',gap:6,marginTop:4,flexWrap:'wrap'}}>
                      {Object.entries(colorDist).sort((a,b)=>b[1]-a[1]).map(([col,count])=>(
                        <span key={col} style={{fontSize:9,color:COLOR_ACTIVE[col]||'#888'}}>{COLOR_MAP[col]||col}: {count}</span>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* Deck — card list, or (pencil) an editable text version with art codes */}
              <div style={{borderTop:`1px solid ${colors.border}`,paddingTop:6}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6}}>
                  <div style={{fontSize:9,color:colors.textMuted,fontFamily:'Cinzel,serif',letterSpacing:'1px',textTransform:'uppercase'}}>Deck</div>
                  <button onClick={()=>{ if(!deckEdit) setDeckText(deckToText()); setDeckEdit(e=>!e) }} title="Edit as text (copy / paste / import)"
                    style={{...btnStyle,padding:'3px 7px',display:'flex',alignItems:'center',background:deckEdit?'rgba(201,168,76,0.2)':btnStyle.background}}><PencilIcon /></button>
                </div>
                {deckEdit ? (
                  <div>
                    <textarea value={deckText} onChange={e=>setDeckText(e.target.value)}
                      style={{width:'100%',height:200,background:'#0d0d0f',border:`1px solid ${colors.border}`,color:colors.text,borderRadius:4,fontSize:10,padding:6,outline:'none',resize:'vertical',fontFamily:'monospace'}} />
                    <div style={{display:'flex',gap:4,marginTop:6}}>
                      <button onClick={()=>{applyDeckText(deckText);setDeckEdit(false)}} style={{...btnStyle,fontSize:10,color:colors.gold}}>Apply</button>
                      <button onClick={()=>navigator.clipboard.writeText(deckText)} style={{...btnStyle,fontSize:10}}>Copy</button>
                      <button onClick={()=>setDeckEdit(false)} style={{...btnStyle,fontSize:10}}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div style={{fontSize:10,color:colors.textMuted,fontFamily:'Cinzel,serif'}}>
                    {deckTotal === 0 && <div style={{fontStyle:'italic'}}>Empty — add cards from the grid.</div>}
                    {TYPE_ORDER.filter(t=>grouped[t]).map(t=>(
                      <div key={t} style={{marginBottom:6}}>
                        <div style={{color:colors.gold,marginBottom:2}}>{t} ({grouped[t].reduce((s,x)=>s+x.qty,0)})</div>
                        {grouped[t].sort((a,b)=>a.name.localeCompare(b.name)).map(({name,qty})=>(
                          // One row per card (total count). + adds a copy of the
                          // art with the fewest copies; − removes from the art with
                          // the most. Per-art splits are managed in the text editor.
                          <div key={name} style={{display:'flex',alignItems:'center',gap:4,marginBottom:1}}>
                            <span style={{flex:1,fontSize:10,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{name}</span>
                            <span style={{fontSize:10,color:colors.gold,minWidth:20,textAlign:'right'}}>×{qty}</span>
                            <button onClick={()=>addSmallest(name,qty)} style={{background:'none',border:'none',color:'#4a9a4a',cursor:'pointer',fontSize:12,padding:'0 2px'}}>+</button>
                            <button onClick={()=>removeLargest(name,qty)} style={{background:'none',border:'none',color:'#9a3a3a',cursor:'pointer',fontSize:12,padding:'0 2px'}}>−</button>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Bottom actions — delete sits below the card names */}
              <div style={{borderTop:`1px solid ${colors.border}`,paddingTop:8,display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                {trash.length > 0 && <button onClick={()=>setShowTrash(s=>!s)} style={{...btnStyle,fontSize:10,color:colors.textMuted}}>Trash ({trash.length})</button>}
                {!confirmDelete
                  ? <button onClick={deleteDeck} style={{...btnStyle,fontSize:10,color:colors.red,borderColor:'rgba(180,40,40,0.4)',marginLeft:'auto'}}>Delete Deck</button>
                  : <span style={{marginLeft:'auto',display:'flex',gap:6,alignItems:'center'}}>
                      <span style={{fontSize:10,color:colors.red,fontFamily:'Cinzel,serif'}}>Sure?</span>
                      <button onClick={deleteDeck} style={{...btnStyle,fontSize:10,color:colors.red,borderColor:'rgba(180,40,40,0.4)'}}>Yes</button>
                      <button onClick={()=>setConfirmDelete(false)} style={{...btnStyle,fontSize:10}}>No</button>
                    </span>
                }
              </div>
            </>
          )}
        </div>
        </div>
        ) : (
          <div style={{width:20,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',
            borderLeft:`1px solid ${colors.border}`,background:'#0a0a0e',cursor:'pointer'}}
            onClick={()=>setShowDeckPanel(true)} title="Show Deck">
            <span style={{writingMode:'vertical-rl',fontSize:9,color:colors.textMuted,fontFamily:'Cinzel,serif',letterSpacing:'1px'}}>◀ Deck</span>
          </div>
        )}
      </div>
    </>
  )
}
