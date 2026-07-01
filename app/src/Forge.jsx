import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadArtOverrides, setArtOverride, clearArtOverride, fetchPrintings, loadArtCounts, recordArtCount } from './engine/artOverrides.js'
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

const SORT_OPTS = ['name','cmc','price','popularity','decks']
const SORT_MAP = { name:'name', cmc:'cmc', price:'usd_price', popularity:'popularity', decks:'decks' }
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

function RenameInline({ activeDeck, decks, onRename }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState('')
  if (!editing) return (
    <button onClick={()=>{setVal(activeDeck);setEditing(true)}} style={{...btnStyle,fontSize:10}}>Rename</button>
  )
  return (
    <div style={{display:'flex',gap:4}}>
      <input value={val} onChange={e=>setVal(e.target.value)} autoFocus
        style={{flex:1,padding:'3px 6px',background:'#1e1e24',border:`1px solid ${colors.border}`,color:colors.text,borderRadius:4,fontSize:11,outline:'none'}} />
      <button onClick={()=>{onRename(activeDeck,val);setEditing(false)}} style={{...btnStyle,fontSize:10,color:colors.gold}}>✓</button>
      <button onClick={()=>setEditing(false)} style={{...btnStyle,fontSize:10}}>✕</button>
    </div>
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
        {/* Choose alternate art (per-user override). */}
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '7%', display: 'flex', borderRadius: '0 0 8px 8px', overflow: 'hidden' }}>
          <div onClick={e => { e.stopPropagation(); onRemove(card.name) }}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'background 0.12s', background: '#000', borderRight: '1px solid rgba(201,168,76,0.3)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(154,58,58,0.7)'}
            onMouseLeave={e => e.currentTarget.style.background = '#000'}>
            <span style={{ color: '#df7a7a', fontSize: 12, fontWeight: 'bold' }}>−</span>
          </div>
          {card.multi_art && !singleArt && (
            <div onClick={e => { e.stopPropagation(); onArt(card.name) }} title="Change art"
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'background 0.12s', background: artOverride ? 'rgba(201,168,76,0.25)' : '#000', borderRight: '1px solid rgba(201,168,76,0.3)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(201,168,76,0.5)'}
              onMouseLeave={e => e.currentTarget.style.background = artOverride ? 'rgba(201,168,76,0.25)' : '#000'}>
              <span style={{ fontSize: 10 }}>🎨</span>
            </div>
          )}
          <div onClick={e => { e.stopPropagation(); onAdd(card.name) }}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'background 0.12s', background: '#000' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(74,154,74,0.7)'}
            onMouseLeave={e => e.currentTarget.style.background = '#000'}>
            <span style={{ color: '#7adf7a', fontSize: 12, fontWeight: 'bold' }}>+</span>
          </div>
        </div>
        {count && (
          <div style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,0.8)', color: colors.gold, fontWeight: 'bold', fontSize: 11, borderRadius: 3, padding: '1px 5px', fontFamily: 'Cinzel,serif', pointerEvents: 'none' }}>×{count}</div>
        )}
      </div>
      <div style={{ fontSize: 9, color: colors.textMuted }}>{card.rarity} · ${card.usd_price?.toFixed(2)}</div>
      {card.popularity > 0 && <div style={{ fontSize: 9, color: '#7a7060' }}>{card.popularity}% · {card.decks?.toLocaleString()} decks</div>}
    </div>
  )
}

// Alternate-art picker: fetches every printing of a card from Scryfall and lets
// the user set one as their per-user default. Modeled on the zone-viewer modal.
function ArtPicker({ name, current, onPick, onReset, onClose, onCount }) {
  const [prints, setPrints] = useState(null)
  useEffect(() => {
    let alive = true
    setPrints(null)
    fetchPrintings(name).then(p => { if (alive) { setPrints(p); onCount?.(name, p.length) } })
    return () => { alive = false }
  }, [name])
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(3px)' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: colors.surface, border: `1px solid ${colors.gold}`, borderRadius: 8, padding: 18, width: '85vw', maxWidth: 1400, maxHeight: '88vh', overflow: 'auto', minWidth: 360, boxShadow: `0 0 40px ${colors.gold}25` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid ${colors.border}` }}>
          <span style={{ fontSize: 14, color: colors.gold, fontFamily: 'Cinzel,serif', letterSpacing: 1 }}>Choose Art — {name}</span>
          <div style={{ display: 'flex', gap: 6 }}>
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
                <div key={p.id} onClick={() => onPick({ image_url: p.image_url, image_url_back: p.image_url_back })}
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
  const [filterDeck, setFilterDeck] = useState('(all)')
  const [flippedCards, setFlippedCards] = useState(new Set())
  const [overrides, setOverrides] = useState(loadArtOverrides)
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

  const rarities = [...new Set(cards.map(c=>c.rarity).filter(Boolean))].sort()
  const allTypes = [...new Set(cards.flatMap(c=>[...c.all_types]).filter(t=>!TYPE_EXCLUDE.has(t)))].sort()

  const filtered = cards.filter(c => {
    if (staplesOnly && !c.decks) return false
    if (search) {
      const q = search.toLowerCase()
      const words = q.split(' ')
      if (!words.every(w =>
        (c.name||'').toLowerCase().includes(w) ||
        (c.name_2||'').toLowerCase().includes(w) ||
        (c.oracle_text||'').toLowerCase().includes(w) ||
        (c.type_line||'').toLowerCase().includes(w)
      )) return false
    }
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
    if (filterDeck !== '(all)' && decks[filterDeck]) {
      if (!decks[filterDeck][c.name]) return false
    }
    return true
  }).sort((a,b) => {
    const key = SORT_MAP[sortBy] || sortBy
    const av = a[key]||0, bv = b[key]||0
    if (typeof av === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av)
    return sortAsc ? av-bv : bv-av
  })

  const toggleFlip = name => setFlippedCards(s => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n })

  // ── Virtualized grid geometry (only the visible rows are rendered) ──
  const GAP = 12, PAD = 12, CARD_MIN = 110, CARD_RATIO = 0.715, LABEL_H = 32, OVERSCAN = 3
  const innerW = Math.max(0, vp.w - PAD * 2)
  const cols = Math.max(1, Math.floor((innerW + GAP) / (CARD_MIN + GAP)))
  const cardW = (innerW - GAP * (cols - 1)) / cols
  const rowH = cardW / CARD_RATIO + LABEL_H + GAP
  const totalRows = Math.ceil(filtered.length / cols)
  const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN)
  const lastRow = Math.min(totalRows, Math.ceil((scrollTop + vp.h) / rowH) + OVERSCAN)

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

  // Import/Export
  const [showImportExport, setShowImportExport] = useState(false)
  const [importText, setImportText] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [trash, setTrash] = useState(() => loadTrash())
  const [showTrash, setShowTrash] = useState(false)

  function exportDeck() {
    const lines = Object.entries(deck).map(([name,qty])=>`${qty} ${name}`)
    navigator.clipboard.writeText(lines.join('\n'))
    setImportText('Copied to clipboard!')
    setTimeout(()=>setImportText(''),2000)
  }
  function importDeck() {
    const newDeck = {}
    importText.split('\n').forEach(line=>{
      const m = line.trim().match(/^(\d+)\s+(.+)$/)
      if (m) { const qty=parseInt(m[1]); const name=m[2].trim(); if(qty>0) newDeck[name]=(newDeck[name]||0)+qty }
    })
    if (Object.keys(newDeck).length) {
      setDecks(d=>{const nd={...d,[activeDeck]:newDeck};saveDecks(nd);return nd})
      setShowImportExport(false); setImportText('')
    }
  }

  // Type order for deck display
  const TYPE_ORDER = ['Creature','Planeswalker','Instant','Sorcery','Enchantment','Artifact','Land','Other']
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
        <ArtPicker name={artPickerCard} current={overrides[artPickerCard]}
          onPick={art => { setArtOverride(artPickerCard, art); setOverrides(loadArtOverrides()); setArtPickerCard(null) }}
          onReset={() => { clearArtOverride(artPickerCard); setOverrides(loadArtOverrides()); setArtPickerCard(null) }}
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
            <span style={{color:colors.textMuted,fontSize:12}}>{filtered.length.toLocaleString()} cards</span>
          </div>
          <div ref={setViewport} className="cards-viewport"
            onScroll={e=>setScrollTop(e.currentTarget.scrollTop)}
            style={{flex:1,overflowY:'auto',overflowX:'hidden',position:'relative',padding:`0 ${PAD}px ${PAD}px`}}>
            <div style={{height: totalRows * rowH, position:'relative'}}>
              {vp.w > 0 && Array.from({length: Math.max(0, lastRow - firstRow)}, (_, k) => {
                const row = firstRow + k
                const items = filtered.slice(row * cols, row * cols + cols)
                return (
                  <div key={row} style={{position:'absolute', top: row * rowH, left:0, right:0, display:'flex', gap:GAP}}>
                    {items.map(card => (
                      <CardCell key={card.name} card={card} width={cardW}
                        count={deck[card.name]} flipped={flippedCards.has(card.name)}
                        artOverride={overrides[card.name]}
                        singleArt={artCounts[card.name] === 1}
                        onAdd={addToDeck} onRemove={removeFromDeck} onFlip={toggleFlip} onArt={setArtPickerCard} />
                    ))}
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
          <select value={activeDeck} onChange={e=>{setActiveDeck(e.target.value);setConfirmDelete(false)}}
            style={{padding:'4px',background:'#1e1e24',border:`1px solid ${colors.border}`,color:colors.text,borderRadius:5,fontSize:11}}>
            {Object.keys(decks).map(d=><option key={d}>{d}</option>)}
          </select>
          {activeDeck && (
            <>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                <span style={{fontSize:11,color:colors.textMuted}}>{deckTotal} cards · ${deckCost.toFixed(2)}</span>
                <Toggle checked={filterDeck === activeDeck} onChange={e => {
                  if (e.target.checked) {
                    setFilterDeck(activeDeck)
                    setSelColors([]); setSelRarities([]); setSelTypes([]); setSearch('')
                    setCmcRange([0,20]); setPriceRange([0,500]); setStaplesOnly(false); resetScroll()
                  } else {
                    setFilterDeck('(all)'); resetScroll()
                  }
                }}>Show only</Toggle>
              </div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                <RenameInline activeDeck={activeDeck} decks={decks} onRename={(oldName,newName)=>{
                  if (!newName||newName===oldName||decks[newName]) return
                  setDecks(d=>{const nd={...d};nd[newName]=nd[oldName];delete nd[oldName];saveDecks(nd);return nd})
                  setActiveDeck(newName)
                }} />
                {!confirmDelete
                  ? <button onClick={deleteDeck} style={{...btnStyle,fontSize:10,color:colors.red,borderColor:'rgba(180,40,40,0.4)'}}>Delete</button>
                  : <>
                    <span style={{fontSize:10,color:colors.red,fontFamily:'Cinzel,serif'}}>Sure?</span>
                    <button onClick={deleteDeck} style={{...btnStyle,fontSize:10,color:colors.red,borderColor:'rgba(180,40,40,0.4)'}}>Yes</button>
                    <button onClick={()=>setConfirmDelete(false)} style={{...btnStyle,fontSize:10}}>No</button>
                  </>
                }
                <button onClick={()=>setShowImportExport(s=>!s)} style={{...btnStyle,fontSize:10}}>Import/Export</button>
                {trash.length > 0 && <button onClick={()=>setShowTrash(s=>!s)} style={{...btnStyle,fontSize:10,color:colors.textMuted}}>Trash ({trash.length})</button>}
              </div>

              {showImportExport && (
                <div style={{background:'#1a1a20',border:`1px solid ${colors.border}`,borderRadius:6,padding:8}}>
                  <textarea value={importText} onChange={e=>setImportText(e.target.value)} placeholder={"Paste decklist:\n4 Lightning Bolt\n2 Scalding Tarn\n..."}
                    style={{width:'100%',height:80,background:'#0d0d0f',border:`1px solid ${colors.border}`,color:colors.text,borderRadius:4,fontSize:10,padding:6,outline:'none',resize:'vertical',fontFamily:'monospace'}} />
                  <div style={{display:'flex',gap:4,marginTop:4}}>
                    <button onClick={importDeck} style={{...btnStyle,fontSize:10,color:colors.gold}}>Import</button>
                    <button onClick={exportDeck} style={{...btnStyle,fontSize:10}}>Copy to Clipboard</button>
                  </div>
                </div>
              )}

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

              <div style={{fontSize:10,color:colors.textMuted,fontFamily:'Cinzel,serif',marginTop:4}}>
                {TYPE_ORDER.filter(t=>grouped[t]).map(t=>(
                  <div key={t} style={{marginBottom:6}}>
                    <div style={{color:colors.gold,marginBottom:2}}>{t} ({grouped[t].reduce((s,x)=>s+x.qty,0)})</div>
                    {grouped[t].sort((a,b)=>a.name.localeCompare(b.name)).map(({name,qty})=>(
                      <div key={name} style={{display:'flex',alignItems:'center',gap:4,marginBottom:1}}>
                        <span style={{flex:1,fontSize:10,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{name}</span>
                        <span style={{fontSize:10,color:colors.gold}}>×{qty}</span>
                        <button onClick={()=>addToDeck(name)} style={{background:'none',border:'none',color:'#4a9a4a',cursor:'pointer',fontSize:12,padding:'0 2px'}}>+</button>
                        <button onClick={()=>removeFromDeck(name)} style={{background:'none',border:'none',color:'#9a3a3a',cursor:'pointer',fontSize:12,padding:'0 2px'}}>−</button>
                      </div>
                    ))}
                  </div>
                ))}
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
