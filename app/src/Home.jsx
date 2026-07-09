import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadUsername, saveUsername } from './profile.js'

// Landing menu. No engine/network connection happens here — the deck builder
// works fully offline; only the WLAN option asks about networking.
export default function Home() {
  const nav = useNavigate()
  // Auto-creates and persists a username on first run; remembered across updates.
  const [name, setName] = useState(loadUsername)
  const cards = [
    { to: '/forge', icon: '⚒', title: 'DECK BUILDER', sub: 'Build and manage your decks' },
    { to: '/battle', icon: '⚔', title: 'PLAY VS AI', sub: 'Local game against the Forge AI' },
    { to: '/wlan', icon: '📡', title: 'WLAN GAME', sub: 'Play another person on your network' },
    { to: '/lab', icon: '📊', title: 'SIMULATOR LAB', sub: 'Batch AI-vs-AI testing and stats' },
  ]
  return (
    <div className="home-bg">
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>⚗</div>
        <h1 style={{ fontSize: 34, letterSpacing: '6px' }}>MTG LAB</h1>
        <p style={{ color: '#7a7060', fontStyle: 'italic', letterSpacing: '2px' }}>
          The Forge engine. Your table.
        </p>
      </div>

      <PlayerBadge name={name} onChange={setName} />

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
        {cards.map(c => (
          <div key={c.to} className="home-card" onClick={() => nav(c.to)}>
            <div style={{ fontSize: 30, marginBottom: 12 }}>{c.icon}</div>
            <h3 style={{ fontSize: 15, letterSpacing: '3px', marginBottom: 6 }}>{c.title}</h3>
            <p style={{ color: '#7a7060', fontSize: 12 }}>{c.sub}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

const GOLD = '#d4a843'

// Shows "Playing as <name>" with an inline editor to change it.
function PlayerBadge({ name, onChange }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  function open() { setDraft(name); setEditing(true) }
  function commit() {
    const saved = saveUsername(draft)
    onChange(saved)
    setEditing(false)
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 22, minHeight: 34 }}>
      {!editing ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#9a8c6a' }}>
          <span>Playing as</span>
          <span style={{ fontFamily: 'Cinzel, serif', color: GOLD, letterSpacing: 1 }}>{name}</span>
          <button onClick={open} title="Change username" style={{
            background: 'transparent', border: `1px solid ${GOLD}55`, color: GOLD,
            borderRadius: 6, cursor: 'pointer', fontSize: 11, padding: '3px 9px',
          }}>✎ Change</button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            autoFocus value={draft} maxLength={24}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
            placeholder="Your name"
            style={{
              padding: '6px 10px', background: '#1a1a20', border: `1px solid ${GOLD}88`,
              color: '#d4cabb', borderRadius: 6, fontSize: 13, outline: 'none', fontFamily: "'Crimson Text', serif", width: 200,
            }} />
          <button onClick={commit} style={{
            background: 'rgba(212,168,67,0.18)', border: `1px solid ${GOLD}`, color: GOLD,
            borderRadius: 6, cursor: 'pointer', fontSize: 12, padding: '6px 14px', fontFamily: 'Cinzel, serif',
          }}>Save</button>
          <button onClick={() => setEditing(false)} style={{
            background: 'transparent', border: '1px solid #8a7030', color: '#d4cabb',
            borderRadius: 6, cursor: 'pointer', fontSize: 12, padding: '6px 12px', fontFamily: 'Cinzel, serif',
          }}>Cancel</button>
        </div>
      )}
    </div>
  )
}
