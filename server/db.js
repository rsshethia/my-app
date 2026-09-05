import pg from 'pg'

const { Pool } = pg

let pool = null

// Render/dotenv values sometimes arrive with surrounding quotes or whitespace
// (e.g. PGHOST='ep-....neon.tech'), which makes DNS fail with
// "getaddrinfo ENOTFOUND 'host'". Strip those before connecting.
function clean(value, fallback = undefined) {
  if (value === undefined || value === null) return fallback
  const s = String(value).trim().replace(/^['"]+|['"]+$/g, '').trim()
  return s === '' ? fallback : s
}

export function getPool() {
  if (pool) return pool
  const connectionString = clean(process.env.DATABASE_URL)
  if (connectionString) {
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
    })
  } else if (clean(process.env.PGHOST) && clean(process.env.PGUSER)) {
    // Fallback for split PG* vars (Neon "parameters" style .env).
    pool = new Pool({
      host: clean(process.env.PGHOST),
      port: Number(clean(process.env.PGPORT, '5432')) || 5432,
      database: clean(process.env.PGDATABASE, 'neondb'),
      user: clean(process.env.PGUSER),
      password: clean(process.env.PGPASSWORD),
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
    })
  } else {
    return null
  }
  pool.on('error', (err) => {
    console.error('[db] pool error', err.message)
  })
  return pool
}

// Single table, 10-day TTL enforced by collector after each poll.
// ~14 vehicles x 1 poll/min x 10 days ~= 200k rows (<15 MB).
export async function initDb(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS positions (
      fetched_at TIMESTAMPTZ NOT NULL,
      entity_id TEXT NOT NULL,
      vehicle_label TEXT,
      trip_id TEXT,
      route_id TEXT,
      line_code TEXT,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      bearing REAL,
      vehicle_ts TIMESTAMPTZ,
      PRIMARY KEY (fetched_at, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pos_trip_time ON positions (trip_id, fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pos_line_time ON positions (line_code, fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pos_fetched ON positions (fetched_at DESC);
  `)
}
