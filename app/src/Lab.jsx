import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { connectBridge } from './engine/bridge.js'
import { analyzeMatchup } from './stats.js'

// AI-vs-AI batch simulator (stat engine). Picks a main deck + one opponent + N,
// runs N games headlessly on the bridge, and shows live progress (with an ETA)
// plus a full stats report. The bridge owns all game logic; this page only
// sends a `control:sim` request and renders the streamed `sim` messages.

const T = {
  bg: '#040406', surface: '#0a0a10', surface2: '#0e0e16',
  gold: '#d4a843', goldBr: '#e8c45a', goldDim: '#8a7030',
  text: '#d4cabb', muted: '#7a7060', red: '#c03030', green: '#50a050', blue: '#5878b0',
}

const PRESETS = {
  'Mono Red (preset)': { Mountain: 24, 'Goblin Piker': 36 },
  'Mono Green (preset)': { Forest: 24, 'Grizzly Bears': 36 },
}
function loadDecks() {
  let saved = {}
  try { saved = JSON.parse(localStorage.getItem('mtg_decks') || '{}') } catch {}
  const usable = {}
  for (const [name, cards] of Object.entries(saved)) {
    if (cards && Object.values(cards).reduce((a, b) => a + b, 0) > 0) usable[name] = cards
  }
  return { ...usable, ...PRESETS }
}

// Friendly labels for Forge's GameLossReason enum names.
const REASON_LABEL = {
  LifeReachedZero: 'Reduced to 0 life', Milled: 'Decked out (empty library)',
  Poisoned: 'Poison (10 counters)', CommanderDamage: 'Commander damage',
  SpellEffect: 'Spell/ability effect', OpponentWon: 'Opponent alt-win',
  Conceded: 'Conceded',
}
const reasonLabel = r => REASON_LABEL[r] || r

function fmtDuration(ms) {
  if (!ms || ms < 0) ms = 0
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

const btn = (primary, disabled) => ({
  fontFamily: 'Cinzel, serif', fontSize: 12, letterSpacing: 1, padding: '8px 18px',
  borderRadius: 6, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
  background: primary ? 'rgba(212,168,67,0.18)' : 'rgba(255,255,255,0.04)',
  border: `1px solid ${primary ? T.gold : T.goldDim}`, color: primary ? T.gold : T.text,
})

export default function Lab() {
  const nav = useNavigate()
  const decks = useMemo(loadDecks, [])
  const names = Object.keys(decks)

  const [main, setMain] = useState(names[0] || '')
  const [opp, setOpp] = useState(names.length > 1 ? names[1] : (names[0] || ''))
  const [n, setN] = useState(50)
  const [status, setStatus] = useState('idle') // idle | connecting | running | done | error
  const [progress, setProgress] = useState({ done: 0, total: 0, etaMs: 0, elapsedMs: 0, wins: 0, losses: 0, draws: 0 })
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const connRef = useRef(null)

  useEffect(() => () => { connRef.current?.close() }, [])

  function run() {
    if (!main || !opp || status === 'running' || status === 'connecting') return
    setError(''); setReport(null); setStatus('connecting')
    setProgress({ done: 0, total: n, etaMs: 0, elapsedMs: 0, wins: 0, losses: 0, draws: 0 })
    const conn = connectBridge('ws://127.0.0.1:8088', {
      onOpen: () => {},
      onWelcome: () => {
        setStatus('running')
        conn.send({
          type: 'control', action: 'sim', n,
          main: { name: main, cards: decks[main] },
          opponent: { name: opp, cards: decks[opp] },
        })
      },
      onError: () => { setStatus('error'); setError('Could not reach the engine. Is the app bridge running?') },
      onSim: msg => {
        if (msg.kind === 'progress') setProgress(msg)
        else if (msg.kind === 'done') { setReport(msg); setStatus('done'); conn.close() }
        else if (msg.kind === 'cancelled') { setStatus('idle'); conn.close() }
        else if (msg.kind === 'error') { setStatus('error'); setError(msg.message || 'Simulation error'); conn.close() }
      },
    })
    connRef.current = conn
  }

  function cancel() {
    connRef.current?.send({ type: 'control', action: 'simCancel' })
    setStatus('idle')
    connRef.current?.close()
  }

  const busy = status === 'running' || status === 'connecting'
  const pct = progress.total ? Math.round(progress.done / progress.total * 100) : 0

  return (
    <div style={{ minHeight: '100vh', background: `radial-gradient(ellipse at 50% 0%, ${T.surface2}, ${T.bg} 70%)`, color: T.text, fontFamily: "'Crimson Text', Georgia, serif", padding: '20px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 18 }}>
        <button onClick={() => nav('/')} style={btn(false, false)}>← Menu</button>
        <h1 style={{ fontFamily: 'Cinzel, serif', color: T.gold, letterSpacing: 4, fontSize: 22, margin: 0 }}>SIMULATOR LAB</h1>
        <span style={{ color: T.muted, fontStyle: 'italic', fontSize: 12 }}>head-to-head AI testing</span>
      </div>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* ── Setup ── */}
        <div style={{ flex: '0 0 300px', background: T.surface, border: `1px solid ${T.gold}33`, borderRadius: 10, padding: 18 }}>
          <Section label="Your deck">
            <select value={main} onChange={e => setMain(e.target.value)} disabled={busy} style={selStyle}>
              {names.map(nm => <option key={nm} value={nm}>{nm}</option>)}
            </select>
          </Section>

          <div style={{ textAlign: 'center', color: T.goldDim, fontFamily: 'Cinzel,serif', fontSize: 13, margin: '2px 0 10px' }}>versus</div>

          <Section label="Opponent deck">
            <select value={opp} onChange={e => setOpp(e.target.value)} disabled={busy} style={selStyle}>
              {names.map(nm => <option key={nm} value={nm}>{nm}</option>)}
            </select>
          </Section>

          <Section label="Number of games">
            <input type="number" min={1} max={2000} value={n} disabled={busy}
              onChange={e => setN(Math.max(1, Math.min(2000, parseInt(e.target.value) || 1)))} style={selStyle} />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              {[20, 50, 100, 250].map(v => (
                <button key={v} disabled={busy} onClick={() => setN(v)}
                  style={{ ...btn(n === v, busy), padding: '4px 8px', fontSize: 10, flex: 1 }}>{v}</button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: T.muted, marginTop: 6 }}>
              Full AI games take a few seconds each (run in parallel across cores).
              {n >= 250 && <span style={{ color: T.goldDim }}> Large N — this will take a while.</span>}
            </div>
          </Section>

          {main === opp && <div style={{ fontSize: 10, color: T.goldDim, fontStyle: 'italic', marginBottom: 10 }}>Mirror match (same deck both sides).</div>}

          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            {!busy
              ? <button onClick={run} disabled={!main || !opp} style={btn(true, !main || !opp)}>▶ Run {n} games</button>
              : <button onClick={cancel} style={btn(false, false)}>■ Stop</button>}
          </div>
        </div>

        {/* ── Progress + Results ── */}
        <div style={{ flex: 1, minWidth: 380 }}>
          {status === 'idle' && !report && (
            <div style={{ color: T.muted, fontStyle: 'italic', padding: 30 }}>Pick your deck and an opponent, set how many games, and hit Run.</div>
          )}
          {error && <div style={{ color: T.red, padding: 12, border: `1px solid ${T.red}55`, borderRadius: 8 }}>{error}</div>}

          {busy && (
            <div style={{ background: T.surface, border: `1px solid ${T.gold}33`, borderRadius: 10, padding: 18, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}>
                <span style={{ color: T.gold, fontFamily: 'Cinzel,serif' }}>
                  {status === 'connecting' ? 'Connecting…' : `Running — ${progress.done}/${progress.total}`}
                </span>
                <span style={{ color: T.muted }}>
                  {status === 'running' && <span style={{ marginRight: 10 }}>{progress.wins}W · {progress.losses}L{progress.draws ? ` · ${progress.draws}D` : ''}</span>}
                  elapsed {fmtDuration(progress.elapsedMs)} · ETA {fmtDuration(progress.etaMs)}
                </span>
              </div>
              <Bar pct={pct} />
            </div>
          )}

          {report && <Report report={report} />}
        </div>
      </div>
    </div>
  )
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, color: T.goldDim, fontFamily: 'Cinzel,serif', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  )
}

const selStyle = {
  width: '100%', padding: '6px 8px', background: '#1a1a20', border: `1px solid ${T.goldDim}`,
  color: T.text, borderRadius: 6, fontSize: 12, outline: 'none', fontFamily: "'Crimson Text', serif",
}

function Bar({ pct }) {
  return (
    <div style={{ height: 10, background: 'rgba(255,255,255,0.06)', borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: `linear-gradient(90deg, ${T.goldDim}, ${T.goldBr})`, transition: 'width 0.2s' }} />
    </div>
  )
}

function Report({ report }) {
  const stats = analyzeMatchup(report)
  const t = report.turns || {}
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ fontFamily: 'Cinzel,serif', color: T.gold, fontSize: 18, letterSpacing: 1, margin: 0 }}>
          {report.main} <span style={{ color: T.muted, fontSize: 13 }}>vs</span> {report.opponent}
        </h2>
        <span style={{ color: T.muted, fontSize: 11 }}>{report.games} games · {fmtDuration(report.elapsedMs)} · {report.threads} threads</span>
      </div>

      <ResultsPanel report={report} stats={stats} />

      {/* Play/draw + game length */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Panel title="On the play vs on the draw" style={{ flex: '1 1 280px' }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <SplitStat label="On the play" wr={report.onPlay} />
            <SplitStat label="On the draw" wr={report.onDraw} />
          </div>
          <div style={{ fontSize: 10, color: T.muted, marginTop: 10, fontStyle: 'italic' }}>
            A big gap means going first matters a lot in this matchup.
          </div>
        </Panel>

        <Panel title="Game length" style={{ flex: '2 1 380px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginBottom: 14 }}>
            <Stat label="Avg turns" value={(t.avg || 0).toFixed(1)} />
            <Stat label="Median" value={t.median != null ? t.median : '—'} />
            <Stat label="Range" value={`${t.min || '—'}–${t.max || '—'}`} />
            <Stat label="Fastest win" value={report.fastestWin ? `T${report.fastestWin}` : '—'} />
          </div>
          <BarChart hist={t.hist} color={T.blue} xUnit="turn" />
        </Panel>
      </div>

      {/* How games ended */}
      {(hasEntries(report.winReasons) || hasEntries(report.lossReasons)) && (
        <Panel title="How games ended">
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
            <ReasonList title="Your wins came from" reasons={report.winReasons} total={report.wins} color={T.green} />
            <ReasonList title="Your losses came from" reasons={report.lossReasons} total={report.losses} color={T.red} />
          </div>
        </Panel>
      )}

      {/* Mulligans + margins */}
      <Panel title="Mulligans & life margins">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginBottom: 14 }}>
          <Stat label="Avg win margin" value={`${(report.avgWinMargin || 0).toFixed(1)} life`} />
          <Stat label="Avg loss margin" value={`${(report.avgLossMargin || 0).toFixed(1)} life`} />
        </div>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          <BarChart title={`You · avg ${(report.mainMulligans?.avg || 0).toFixed(2)}`} hist={report.mainMulligans?.hist} color={T.gold} xUnit="mull" />
          <BarChart title={`Opponent · avg ${(report.oppMulligans?.avg || 0).toFixed(2)}`} hist={report.oppMulligans?.hist} color={T.goldDim} xUnit="mull" />
        </div>
      </Panel>
    </div>
  )
}

function hasEntries(o) { return o && Object.keys(o).length > 0 }

function Panel({ title, children, style, accent }) {
  return (
    <div style={{ background: T.surface, border: `1px solid ${accent || T.gold}33`, borderRadius: 10, padding: 16, ...style }}>
      {title && <CardTitle>{title}</CardTitle>}
      {children}
    </div>
  )
}

function CardTitle({ children }) {
  return <div style={{ fontSize: 10, color: T.goldDim, fontFamily: 'Cinzel,serif', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 }}>{children}</div>
}

function Stat({ label, value }) {
  return (
    <div style={{ minWidth: 64 }}>
      <div style={{ fontFamily: 'Cinzel,serif', color: T.text, fontSize: 20 }}>{value}</div>
      <div style={{ fontSize: 10, color: T.muted }}>{label}</div>
    </div>
  )
}

function SplitStat({ label, wr }) {
  const rate = wr?.winRate || 0
  const pct = Math.round(rate * 100)
  const color = pct >= 55 ? T.green : pct <= 45 ? T.red : T.gold
  return (
    <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'Cinzel,serif', color, fontSize: 24, fontWeight: 700, lineHeight: 1 }}>{pct}%</div>
      <div style={{ height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden', margin: '6px 0 4px' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color }} />
      </div>
      <div style={{ fontSize: 10, color: T.muted }}>{wr?.wins || 0} / {wr?.games || 0} games</div>
    </div>
  )
}

function ReasonList({ title, reasons, total, color }) {
  const entries = Object.entries(reasons || {}).sort((a, b) => b[1] - a[1])
  if (!entries.length) return null
  return (
    <div style={{ flex: '1 1 240px', minWidth: 220 }}>
      <div style={{ fontSize: 11, color: T.muted, marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {entries.map(([reason, count]) => {
          const pct = total ? Math.round(count / total * 100) : 0
          return (
            <div key={reason}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
                <span style={{ color: T.text }}>{reasonLabel(reason)}</span>
                <span style={{ color: T.muted }}>{count} ({pct}%)</span>
              </div>
              <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: color }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function BarChart({ title, hist, color, xUnit }) {
  const entries = Object.entries(hist || {}).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0])
  if (!entries.length) return <div style={{ flex: '1 1 240px', color: T.muted, fontSize: 11 }}>{title}<div style={{ marginTop: 8, fontStyle: 'italic' }}>no data</div></div>
  const max = Math.max(...entries.map(e => e[1]))
  const total = entries.reduce((a, e) => a + e[1], 0)
  // Sparse x-axis ticks so labels don't crowd.
  const tickEvery = Math.max(1, Math.ceil(entries.length / 8))
  return (
    <div style={{ flex: '1 1 260px', minWidth: 240 }}>
      {title && <div style={{ fontSize: 10, color: T.goldDim, fontFamily: 'Cinzel,serif', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>{title}</div>}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 96, borderBottom: `1px solid ${T.gold}22`, paddingBottom: 2 }}>
        {entries.map(([k, v]) => (
          <div key={k} title={`${k} ${xUnit || ''}: ${v} (${Math.round(v / total * 100)}%)`}
            style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}>
            <div style={{ width: '100%', height: `${max ? v / max * 100 : 0}%`, minHeight: v ? 2 : 0,
              background: `linear-gradient(180deg, ${color}, ${color}99)`, borderRadius: '2px 2px 0 0' }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 2, marginTop: 3 }}>
        {entries.map(([k], i) => (
          <span key={k} style={{ flex: 1, textAlign: 'center', fontSize: 8, color: T.muted }}>{i % tickEvery === 0 ? k : ''}</span>
        ))}
      </div>
    </div>
  )
}

// Combined results: donut of W/D/L + the win-rate confidence interval, one panel.
function ResultsPanel({ report, stats }) {
  const accent = stats.favored === 'main' ? T.green : stats.favored === 'opp' ? T.red : T.gold
  return (
    <Panel title="Match results" accent={accent}>
      <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
        <Donut wins={report.wins} draws={report.draws} losses={report.losses} rate={stats.rate} color={accent} />
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ display: 'flex', gap: 18, marginBottom: 16, fontSize: 12 }}>
            <Legend color={T.green} label="Wins" value={report.wins} />
            {report.draws > 0 && <Legend color={T.goldDim} label="Draws" value={report.draws} />}
            <Legend color={T.red} label="Losses" value={report.losses} />
            {report.errors > 0 && <Legend color={T.muted} label="Errored" value={report.errors} />}
          </div>
          {stats.decisive >= 1 && <CIStrip stats={stats} color={accent} />}
        </div>
      </div>
    </Panel>
  )
}

function Legend({ color, label, value }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 9, height: 9, borderRadius: 2, background: color, display: 'inline-block' }} />
        <span style={{ fontFamily: 'Cinzel,serif', color: T.text, fontSize: 18 }}>{value}</span>
      </div>
      <div style={{ fontSize: 10, color: T.muted, marginLeft: 15 }}>{label}</div>
    </div>
  )
}

function Donut({ wins, draws, losses, rate, color }) {
  const total = (wins + draws + losses) || 1
  const r = 52, sw = 16, C = 2 * Math.PI * r
  const segs = [[wins, T.green], [draws, T.goldDim], [losses, T.red]]
  let offset = 0
  return (
    <svg width="132" height="132" viewBox="0 0 132 132" style={{ flex: '0 0 auto' }}>
      <g transform="rotate(-90 66 66)">
        <circle cx="66" cy="66" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={sw} />
        {segs.map(([v, c], i) => {
          if (!v) return null
          const len = C * (v / total)
          const el = <circle key={i} cx="66" cy="66" r={r} fill="none" stroke={c} strokeWidth={sw}
            strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} />
          offset += len
          return el
        })}
      </g>
      <text x="66" y="62" textAnchor="middle" fill={color} fontSize="28" fontFamily="Cinzel, serif" fontWeight="700">{Math.round(rate * 100)}%</text>
      <text x="66" y="80" textAnchor="middle" fill={T.muted} fontSize="10">win rate</text>
    </svg>
  )
}

// Win-rate point estimate sitting on its 95% confidence interval, vs the 50% line.
function CIStrip({ stats, color }) {
  const pct = x => `${(x * 100).toFixed(1)}%`
  const lo = stats.ci95.lo * 100, hi = stats.ci95.hi * 100, p = stats.rate * 100
  return (
    <div>
      <div style={{ fontSize: 10, color: T.goldDim, fontFamily: 'Cinzel,serif', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>
        95% confidence interval <span style={{ color: T.muted, textTransform: 'none', letterSpacing: 0 }}>· {stats.decisive} decisive games</span>
      </div>
      <div style={{ position: 'relative', height: 50 }}>
        <div style={{ position: 'absolute', top: 24, left: 0, right: 0, height: 10, background: 'rgba(255,255,255,0.05)', borderRadius: 5 }} />
        <div style={{ position: 'absolute', top: 24, left: `${lo}%`, width: `${Math.max(0.5, hi - lo)}%`, height: 10, background: `${color}66`, borderRadius: 5 }} />
        <div style={{ position: 'absolute', top: 19, left: `${p}%`, width: 3, height: 20, background: color, transform: 'translateX(-1.5px)', borderRadius: 2 }} />
        <div style={{ position: 'absolute', top: 2, left: `${p}%`, fontSize: 13, fontFamily: 'Cinzel,serif', color, transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>{pct(stats.rate)}</div>
        <div style={{ position: 'absolute', top: 18, left: '50%', width: 1, height: 22, background: T.muted, transform: 'translateX(-0.5px)' }} />
        <div style={{ position: 'absolute', top: 40, left: '50%', fontSize: 9, color: T.muted, transform: 'translateX(-50%)' }}>50%</div>
        <div style={{ position: 'absolute', top: 40, left: `${lo}%`, fontSize: 10, color: T.text, transform: 'translateX(-50%)' }}>{pct(stats.ci95.lo)}</div>
        <div style={{ position: 'absolute', top: 40, left: `${hi}%`, fontSize: 10, color: T.text, transform: 'translateX(-50%)' }}>{pct(stats.ci95.hi)}</div>
      </div>
    </div>
  )
}
