import pg from 'pg'

const { Pool } = pg

let pool = null

export function getPool() {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (connectionString) {
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
    })
  } else if (process.env.PGHOST && process.env.PGUSER) {
    // Fallback for split PG* vars (Neon "parameters" style .env).
    pool = new Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT) || 5432,
      database: process.env.PGDATABASE || 'neondb',
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
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
