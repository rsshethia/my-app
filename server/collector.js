import gtfs from 'gtfs-realtime-bindings'

const FEED_URL =
  'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/vline/vehicle-positions'
const RETENTION_SQL = `DELETE FROM positions WHERE fetched_at < NOW() - INTERVAL '10 days'`

function extractLineCode(routeId) {
  if (!routeId || routeId === '-') return 'Unknown'
  const colonPart = String(routeId).split(':').filter(Boolean).pop() ?? String(routeId)
  const dashPart = colonPart.split('-').filter(Boolean).pop() ?? colonPart
  return (dashPart.trim().toUpperCase() || 'Unknown')
}

function toVehicleTs(secs) {
  const n = Number(secs)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(Math.floor(n) * 1000).toISOString()
}

export async function collectOnce(db, apiKey) {
  if (!apiKey) throw new Error('VLINE_KEY is not set')
  const response = await fetch(FEED_URL, {
    headers: { KeyId: apiKey, Accept: 'application/x-protobuf, application/octet-stream' },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable>')
    throw new Error(`VLine ${response.status}: ${body.slice(0, 200)}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const feed = gtfs.transit_realtime.FeedMessage.decode(bytes)
  const json = feed.toJSON()
  const entities = Array.isArray(json.entity) ? json.entity : []
  const fetchedAt = new Date().toISOString()

  const rows = []
  for (const e of entities) {
    const v = e?.vehicle
    const lat = Number(v?.position?.latitude)
    const lon = Number(v?.position?.longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const bearingRaw = Number(v?.position?.bearing)
    rows.push([
      fetchedAt,
      String(e.id ?? `${v?.trip?.tripId ?? 'unknown'}`),
      v?.vehicle?.id != null ? String(v.vehicle.id) : null,
      v?.trip?.tripId != null ? String(v.trip.tripId) : null,
      v?.trip?.routeId != null ? String(v.trip.routeId) : null,
      extractLineCode(v?.trip?.routeId),
      lat,
      lon,
      Number.isFinite(bearingRaw) ? bearingRaw : null,
      toVehicleTs(v?.timestamp),
    ])
  }

  if (rows.length) {
    // Bulk insert in one statement; conflicts (same poll+entity) are skipped.
    const cols = '(fetched_at, entity_id, vehicle_label, trip_id, route_id, line_code, lat, lon, bearing, vehicle_ts)'
    const placeholders = rows
      .map((_, i) => `(${Array.from({ length: 10 }, (_, k) => `$${i * 10 + k + 1}`).join(',')})`)
      .join(',')
    await db.query(
      `INSERT INTO positions ${cols} VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      rows.flat(),
    )
  }
  const pruned = await db.query(RETENTION_SQL)
  return { inserted: rows.length, pruned: pruned.rowCount ?? 0, fetchedAt }
}

export function startCollector(db, { pollMs, apiKey }) {
  let failures = 0
  const tick = async () => {
    try {
      const r = await collectOnce(db, apiKey)
      failures = 0
      console.log(`[collector] +${r.inserted} rows, pruned ${r.pruned}`)
    } catch (err) {
      failures += 1
      console.error(`[collector] failed (${failures}x): ${err.message}`)
    }
  }
  tick()
  const timer = setInterval(tick, pollMs)
  return () => clearInterval(timer)
}

// Shared live-fetch for GET /api/live (proxies V/Line without storing).
export async function fetchLiveFeed(apiKey) {
  const response = await fetch(FEED_URL, {
    headers: { KeyId: apiKey, Accept: 'application/x-protobuf, application/octet-stream' },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable>')
    throw new Error(`VLine ${response.status}: ${body.slice(0, 200)}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const feed = gtfs.transit_realtime.FeedMessage.decode(bytes)
  return feed.toJSON()
}
