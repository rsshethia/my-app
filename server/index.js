import 'dotenv/config'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPool, initDb } from './db.js'
import { fetchLiveFeed, startCollector } from './collector.js'

const app = express()
const port = Number(process.env.PORT) || 5173
const host = '0.0.0.0'
const distDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const apiKey = process.env.VLINE_KEY || process.env.VITE_VLINE_KEY
const pollMs = Number(process.env.POLL_MS) || 60000

const db = getPool()
if (db) {
  try {
    await initDb(db)
    const host = db.options?.host ?? 'pool (connection string)'
    console.log(`[db] positions table ready (host: ${host})`)
  } catch (err) {
    console.error('[db] init failed:', describeDbError(err))
  }
} else {
  console.warn('[db] DATABASE_URL not set — history endpoints disabled, /api/live still works if VLINE_KEY is set')
}

// Translate low-level pg errors into actionable messages (no secrets).
function describeDbError(err) {
  const msg = err?.message ?? String(err)
  if (/ENOTFOUND/i.test(msg)) {
    return `${msg} — check PGHOST/DATABASE_URL for stray quotes or spaces; it must be a bare hostname`
  }
  return msg
}

if (db && apiKey) {
  startCollector(db, { pollMs, apiKey })
  console.log(`[collector] polling every ${pollMs}ms, 10-day retention`)
} else if (!apiKey) {
  console.warn('[collector] VLINE_KEY not set — collector disabled')
}

// Live proxy: keeps VLINE_KEY server-side (never expose it as VITE_*).
app.get('/api/live', async (_req, res) => {
  if (!apiKey) return res.status(500).json({ error: 'VLINE_KEY not configured' })
  try {
    res.json(await fetchLiveFeed(apiKey))
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// Range: '24h' (default) or '10d'. All reads honour the 10-day TTL.
app.get('/api/stats', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'history db not configured' })
  const range = req.query.range === '10d' ? '10 days' : '24 hours'
  try {
    const [total, perLine, vehicles, bounds, trips] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS n FROM positions WHERE fetched_at > NOW() - INTERVAL '${range}'`),
      db.query(
        `SELECT line_code, COUNT(*)::int AS sightings, COUNT(DISTINCT trip_id)::int AS trips
         FROM positions WHERE fetched_at > NOW() - INTERVAL '${range}'
         GROUP BY line_code ORDER BY sightings DESC`,
      ),
      db.query(
        `SELECT COUNT(DISTINCT vehicle_label)::int AS n FROM positions
         WHERE fetched_at > NOW() - INTERVAL '${range}' AND vehicle_label IS NOT NULL`,
      ),
      db.query(`SELECT MIN(fetched_at) AS oldest, MAX(fetched_at) AS newest FROM positions`),
      db.query(
        `SELECT trip_id, line_code, COUNT(*)::int AS sightings,
                MIN(fetched_at) AS first_seen, MAX(fetched_at) AS last_seen
         FROM positions WHERE fetched_at > NOW() - INTERVAL '${range}' AND trip_id IS NOT NULL
         GROUP BY trip_id, line_code ORDER BY last_seen DESC LIMIT 50`,
      ),
    ])
    // Coverage: expected polls (1/min) vs distinct poll timestamps seen.
    const hours = range === '10 days' ? 240 : 24
    const polls = await db.query(
      `SELECT COUNT(DISTINCT fetched_at)::int AS n FROM positions
       WHERE fetched_at > NOW() - INTERVAL '${range}'`,
    )
    res.json({
      range,
      totalSightings: total.rows[0].n,
      vehiclesActive: vehicles.rows[0].n,
      pollsSeen: polls.rows[0].n,
      pollsExpected: hours * 60,
      oldest: bounds.rows[0].oldest,
      newest: bounds.rows[0].newest,
      perLine: perLine.rows,
      recentTrips: trips.rows,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/history', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'history db not configured' })
  const tripId = String(req.query.tripId ?? '')
  const limit = Math.min(Number(req.query.limit) || 500, 2000)
  if (!tripId) return res.status(400).json({ error: 'tripId required' })
  try {
    const r = await db.query(
      `SELECT fetched_at, lat, lon, bearing, vehicle_label, line_code
       FROM positions WHERE trip_id = $1 ORDER BY fetched_at ASC LIMIT $2`,
      [tripId, limit],
    )
    res.json({ tripId, points: r.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/health', async (_req, res) => {
  let dbOk = false
  if (db) {
    try {
      await db.query('SELECT 1')
      dbOk = true
    } catch { dbOk = false }
  }
  res.json({ ok: true, db: dbOk, collector: Boolean(db && apiKey) })
})

app.use(express.static(distDirectory))

// SPA fallback (avoids Express 5 wildcard breakage): serve index.html for
// anything that isn't /api/*.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' })
  res.sendFile(path.join(distDirectory, 'index.html'))
})

app.listen(port, host, () => {
  console.log(`Web server listening on http://${host}:${port}`)
})
