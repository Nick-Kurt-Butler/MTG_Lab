// Binomial statistics for win-rate analysis.
//
// We treat each decisive game (a win or a loss) as a Bernoulli trial and ask:
// given `wins` out of `n` decisive games, what's the true win probability, and
// is it distinguishable from a 50/50 coin flip? Draws are set aside — they're
// neither a win nor a loss, so they don't belong in a win/loss proportion.

// Standard normal CDF via the Abramowitz & Stegun erf approximation (err < 1.5e-7).
export function normalCdf(z) {
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return 0.5 * (1 + sign * y)
}

// Wilson score interval for a binomial proportion. Far better than the normal
// (Wald) interval near 0/1 and at small N, and it never escapes [0,1].
export function wilsonInterval(wins, n, z = 1.96) {
  if (n <= 0) return { lo: 0, hi: 1, p: 0 }
  const p = wins / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half), p }
}

// Two-sided test of H0: true win rate = 0.5 (normal approx w/ continuity
// correction). Returns the p-value — the chance of a deviation this large if
// the matchup were truly even.
export function pValueVsEven(wins, n) {
  if (n <= 0) return 1
  const z = Math.max(0, (Math.abs(wins - n / 2) - 0.5) / Math.sqrt(n * 0.25))
  return Math.min(1, 2 * (1 - normalCdf(z)))
}

// Analysis bundle for the UI: the decisive-game win rate, its 95% Wilson
// interval, and whether the deck is a statistically significant favorite/
// underdog (drives the report's color).
export function analyzeMatchup({ wins = 0, losses = 0 } = {}) {
  const decisive = wins + losses
  const rate = decisive > 0 ? wins / decisive : 0
  const ci95 = wilsonInterval(wins, decisive, 1.96)
  let favored = null
  if (decisive >= 1 && pValueVsEven(wins, decisive) < 0.05) favored = rate > 0.5 ? 'main' : 'opp'
  return { decisive, rate, ci95, favored }
}
