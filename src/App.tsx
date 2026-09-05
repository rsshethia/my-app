import { useEffect, useRef, useState } from 'react'
import { LngLatBounds, Map, Marker, NavigationControl, Popup } from 'mapbox-gl/esm'
import 'mapbox-gl/dist/mapbox-gl.css'
import './App.css'
import { fetchVehiclePositions, type VehiclePositionFeed } from './api/fetchData'
import { fetchStats, fetchTripHistory, type StatsSummary } from './api/history'

type VehiclePoint = {
  id: string
  latitude: number
  longitude: number
  bearing: number
  hasBearing: boolean
  compass: string
  line: string
  routeId: string
  tripId: string
  vehicleLabel: string
  timestampSec: number | null
  speedKmh: number | null
  values: Record<string, string>
}

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

// GTFS-RT bearing: degrees clockwise from North (0=N, 90=E, 180=S, 270=W).
function toCompass(bearing: number) {
  if (!Number.isFinite(bearing)) return '-'
  const normalized = ((bearing % 360) + 360) % 360
  return COMPASS_8[Math.round(normalized / 45) % 8]
}

// Route IDs look like "aus:vic:vic-01-GEL:" — the line code is the last
// dash-segment ("GEL"). Falls back to the raw ID or "Unknown".
function extractLineCode(routeId: string) {
  if (!routeId || routeId === '-') return 'Unknown'
  const colonPart = routeId.split(':').filter(Boolean).pop() ?? routeId
  const dashPart = colonPart.split('-').filter(Boolean).pop() ?? colonPart
  const code = dashPart.trim().toUpperCase()
  return code || 'Unknown'
}

function formatAge(ageSec: number | null) {
  if (ageSec === null || !Number.isFinite(ageSec) || ageSec < 0) return 'unknown age'
  if (ageSec < 60) return `${Math.floor(ageSec)}s ago`
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`
  return `${Math.floor(ageSec / 3600)}h ago`
}

// Fresh <90s, ageing <5m, stale beyond that. Feed has no speed/status
// fields today, so staleness is the main reliability signal.
function freshness(ageSec: number | null) {
  if (ageSec === null) return 'unknown'
  if (ageSec < 90) return 'live'
  if (ageSec < 300) return 'ageing'
  return 'stale'
}

// Flatten nested GTFS entities into table-friendly paths such as
// "vehicle.position.latitude" while preserving arrays as readable values.
function flattenRecord(value: unknown, prefix = '', result: Record<string, string> = {}) {
  if (value === null || value === undefined) {
    result[prefix] = '-'
  } else if (Array.isArray(value)) {
    result[prefix] = value.length ? value.map((item) => formatValue(item)).join(', ') : '-'
  } else if (typeof value === 'object') {
    Object.entries(value).forEach(([key, nestedValue]) => {
      flattenRecord(nestedValue, prefix ? `${prefix}.${key}` : key, result)
    })
  } else if (prefix) {
    result[prefix] = String(value)
  }

  return result
}

function formatValue(value: unknown) {
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] as string)
}

// The feed contains many entity types, so only entities with valid coordinates
// become map rows. Derived fields (line, compass, age) are prepended to the
// flattened values so the table, popup and filters share one source of truth.
function extractVehiclePoints(data: VehiclePositionFeed): VehiclePoint[] {
  const feed = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
  const entities = Array.isArray(feed.entity) ? feed.entity : []

  return entities.flatMap((entity: unknown, index: number) => {
    if (!entity || typeof entity !== 'object') return []

    const record = entity as Record<string, unknown>
    const values = flattenRecord(record)
    const latitude = Number(values['vehicle.position.latitude'])
    const longitude = Number(values['vehicle.position.longitude'])

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return []

    const id = values.id && values.id !== '-' ? values.id : `vehicle-${index + 1}`
    const rawBearing = Number(values['vehicle.position.bearing'])
    const hasBearing = Number.isFinite(rawBearing)
    const bearing = hasBearing ? (((rawBearing % 360) + 360) % 360) : 0
    const routeId = values['vehicle.trip.routeId'] ?? '-'
    const line = extractLineCode(routeId)
    const tripId = values['vehicle.trip.tripId'] ?? '-'
    const vehicleLabel = values['vehicle.vehicle.id'] && values['vehicle.vehicle.id'] !== '-'
      ? values['vehicle.vehicle.id']
      : id
    const rawTimestamp = Number(values['vehicle.timestamp'])
    const timestampSec = Number.isFinite(rawTimestamp) && rawTimestamp > 0 ? Math.floor(rawTimestamp) : null
    // Not present in the current V/Line feed, but handled for when it is.
    // GTFS-RT speed is metres/sec.
    const rawSpeed = Number(values['vehicle.position.speed'])
    const speedKmh = Number.isFinite(rawSpeed) ? Math.round(rawSpeed * 3.6) : null

    const derived: Record<string, string> = {
      line,
      vehicle: vehicleLabel,
      'heading.deg': hasBearing ? `${Math.round(bearing)}°` : '-',
      'heading.compass': hasBearing ? toCompass(bearing) : '-',
      'position.speedKmh': speedKmh !== null ? String(speedKmh) : '-',
    }
    const merged = { ...derived, ...values }

    return [{
      id,
      latitude,
      longitude,
      bearing,
      hasBearing,
      compass: hasBearing ? toCompass(bearing) : '-',
      line,
      routeId,
      tripId,
      vehicleLabel,
      timestampSec,
      speedKmh,
      values: merged,
    }]
  })
}

function VehicleMap({ points, nowMs }: { points: VehiclePoint[]; nowMs: number }) {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<Map | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [mapError, setMapError] = useState<string | null>(null)
  const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined

  // Mapbox owns the canvas and controls, so create it after the container mounts
  // and destroy it on unmount to avoid duplicate canvases in React Strict Mode.
  useEffect(() => {
    if (!mapContainer.current || !token || map.current) return

    setMapError(null)
    const handleError = (event: { error?: { message?: string } }) => {
      if (event.error?.message) setMapError('Mapbox could not load the map style. Check that VITE_MAPBOX_TOKEN is valid.')
    }
    map.current = new Map({
      accessToken: token,
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [145.1, -37.8],
      zoom: 8,
      attributionControl: true,
    })
    // Markers are added only after the style has loaded; before that point the
    // map can exist while its basemap is still unavailable.
    map.current.once('load', () => setMapReady(true))
    map.current.on('error', handleError)
    map.current.addControl(new NavigationControl({ showCompass: false }), 'top-right')

    return () => {
      map.current?.off('error', handleError)
      map.current?.remove()
      map.current = null
      setMapReady(false)
    }
  }, [token])

  // Rebuild markers whenever fresh API data arrives, then fit the camera to the
  // current vehicle extent so vehicles across Victoria remain visible.
  useEffect(() => {
    if (!map.current || !mapReady) return

    const coords: [number, number][] = []
    const mapMarkers = points.map((point) => {
      const ageSec = point.timestampSec === null ? null : Math.max(0, nowMs / 1000 - point.timestampSec)
      const state = freshness(ageSec)
      const element = document.createElement('button')
      element.type = 'button'
      element.className = `vehicle-marker${state === 'stale' ? ' is-stale' : ''}${state === 'ageing' ? ' is-ageing' : ''}`
      element.ariaLabel = point.hasBearing
        ? `${point.vehicleLabel} on ${point.line} line, heading ${Math.round(point.bearing)} degrees ${point.compass}, updated ${formatAge(ageSec)}`
        : `${point.vehicleLabel} on ${point.line} line, updated ${formatAge(ageSec)}`
      element.title = element.ariaLabel
      // Inner arrow rotates; outer button stays unrotated so Mapbox positioning
      // and the circular badge are unaffected.
      element.innerHTML = `<span class="vehicle-arrow" style="transform: rotate(${point.hasBearing ? point.bearing : 0}deg)"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 2.5 19 20l-7-4.2L5 20z"></path></svg>${point.hasBearing ? '' : '<span class="vehicle-dot"></span>'}</span>`

      const heading = point.hasBearing ? `${Math.round(point.bearing)}° ${point.compass}` : 'no bearing'
      const popupHtml = `<strong>${escapeHtml(point.vehicleLabel)}</strong><span class="popup-line">${escapeHtml(point.line)} line · ${escapeHtml(state)}</span><dl><dt>heading</dt><dd>${escapeHtml(heading)}</dd><dt>updated</dt><dd>${escapeHtml(formatAge(ageSec))}</dd><dt>trip</dt><dd>${escapeHtml(point.tripId)}</dd><dt>position</dt><dd>${escapeHtml(`${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`)}</dd>${point.speedKmh !== null ? `<dt>speed</dt><dd>${escapeHtml(`${point.speedKmh} km/h`)}</dd>` : ''}</dl>`
      const marker = new Marker({ element })
        .setLngLat([point.longitude, point.latitude])
        .setPopup(new Popup({ offset: 18, maxWidth: '300px' }).setHTML(popupHtml))
        .addTo(map.current as Map)

      coords.push([point.longitude, point.latitude])
      return marker
    })

    if (coords.length === 1) {
      map.current.setCenter(coords[0])
      map.current.setZoom(11)
    } else if (coords.length > 1) {
      const bounds = coords.reduce((currentBounds, coord) => currentBounds.extend(coord), new LngLatBounds(coords[0], coords[0]))
      map.current.fitBounds(bounds, { padding: 64, maxZoom: 12, duration: 500 })
    }

    return () => mapMarkers.forEach((marker) => marker.remove())
  }, [points, mapReady, nowMs])

  if (!token) {
    return <div className="map-missing">Add <code>VITE_MAPBOX_TOKEN</code> to <code>.env</code> to load the Victoria basemap.</div>
  }

  return (
    <div className="map-wrap">
      <div ref={mapContainer} className="map" role="region" aria-label="Live vehicle positions across Victoria" />
      {mapError && <div className="map-error" role="alert">{mapError}</div>}
    </div>
  )
}

function App() {
  const [data, setData] = useState<VehiclePositionFeed | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedLine, setSelectedLine] = useState<string>('all')
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [stats, setStats] = useState<StatsSummary | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [statsRange, setStatsRange] = useState<'24h' | '10d'>('24h')
  const [trailTripId, setTrailTripId] = useState<string>('')
  const [trailInfo, setTrailInfo] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      const apiKey = import.meta.env.VITE_VLINE_KEY as string | undefined

      try {
        const result = await fetchVehiclePositions(apiKey ?? '')
        setData(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load vehicle positions')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [])

  // 10-day history stats (independent of live load; degrades gracefully when
  // the server runs without DATABASE_URL, e.g. plain `vite dev`).
  useEffect(() => {
    let cancelled = false
    fetchStats(statsRange)
      .then((s) => { if (!cancelled) { setStats(s); setStatsError(null) } })
      .catch((err: unknown) => { if (!cancelled) setStatsError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [statsRange])

  // Tick so "Xs ago" ages and stale states stay truthful without refetching.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 10000)
    return () => window.clearInterval(timer)
  }, [])

  const points = data ? extractVehiclePoints(data) : []
  const lineCounts = points.reduce<Record<string, number>>((acc, point) => {
    acc[point.line] = (acc[point.line] ?? 0) + 1
    return acc
  }, {})
  const lines = Object.keys(lineCounts).sort()
  // Reset a stale filter if a refetch no longer contains that line.
  const effectiveLine = selectedLine === 'all' || lineCounts[selectedLine] ? selectedLine : 'all'
  const filteredPoints = effectiveLine === 'all' ? points : points.filter((point) => point.line === effectiveLine)
  const staleCount = points.filter((point) => {
    const age = point.timestampSec === null ? null : Math.max(0, nowMs / 1000 - point.timestampSec)
    return freshness(age) === 'stale'
  }).length
  const columns = Array.from(new Set(filteredPoints.flatMap((point) => Object.keys(point.values))))

  return (
    <main className="app-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">V/Line live operations</p>
          <h1>Vehicle positions</h1>
          <p className="subtitle">Where is my train dude? A live view of every vehicle position returned by the feed.</p>
        </div>
        {!loading && !error && (
          <div className="feed-stats">
            <div className="feed-stat"><strong>{filteredPoints.length}</strong><span>vehicles plotted</span></div>
            <div className="feed-stat"><strong>{lines.length}</strong><span>lines active</span></div>
            <div className="feed-stat"><strong>{staleCount}</strong><span>stale &gt;5m</span></div>
          </div>
        )}
      </header>

      {loading && <p>Loading data...</p>}
      {error && <p role="alert">{error}</p>}

      {!loading && !error && (
        <div className="dashboard-grid">
          <section className="panel map-panel">
            <div className="section-heading"><div><p className="eyebrow">Geographic overview</p><h2>Live map</h2></div><span className="map-badge">VICTORIA</span></div>
            <div className="line-filters" role="group" aria-label="Filter by line">
              <button type="button" className={effectiveLine === 'all' ? 'line-chip is-active' : 'line-chip'} onClick={() => setSelectedLine('all')}>All · {points.length}</button>
              {lines.map((line) => (
                <button key={line} type="button" className={effectiveLine === line ? 'line-chip is-active' : 'line-chip'} onClick={() => setSelectedLine(line)} title={`Show only ${line} line vehicles`}>{line} · {lineCounts[line]}</button>
              ))}
            </div>
            <VehicleMap points={filteredPoints} nowMs={nowMs} />
            <div className="map-footer"><span><i className="legend-dot" /> Arrow points travel direction (0° N, 90° E)</span><span>Grey ring = stale &gt;5m · Click a marker for details</span></div>
          </section>

          <section className="panel table-panel">
            <div className="section-heading"><div><p className="eyebrow">Complete feed data</p><h2>Vehicle table</h2></div><span className="column-count">{columns.length} fields</span></div>
            <div className="table-scroll"><table>
              <thead>
                <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
              </thead>
              <tbody>
                {filteredPoints.map((point, index) => (
                  <tr key={`${point.id}-${index}`}>{columns.map((column) => <td key={column} title={point.values[column]}>{point.values[column] ?? '-'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table></div>
            {!filteredPoints.length && <p className="empty-state">No vehicle entities with coordinates were returned by the API.</p>}
            {data !== null && <details className="raw-feed"><summary>Inspect raw API response</summary><pre>{JSON.stringify(data, null, 2)}</pre></details>}
          </section>

          <section className="panel analytics-panel">
            <div className="section-heading">
              <div><p className="eyebrow">10-day history</p><h2>Analytics</h2></div>
              <div className="range-toggle" role="group" aria-label="Analytics range">
                {(['24h', '10d'] as const).map((r) => (
                  <button key={r} type="button" className={statsRange === r ? 'line-chip is-active' : 'line-chip'} onClick={() => setStatsRange(r)}>{r}</button>
                ))}
              </div>
            </div>
            {statsError && <p className="analytics-note">History unavailable ({statsError}). Start the server with DATABASE_URL to enable it.</p>}
            {!statsError && !stats && <p className="analytics-note">Loading history…</p>}
            {stats && (
              <>
                <div className="analytics-grid">
                  <div className="feed-stat"><strong>{stats.totalSightings}</strong><span>sightings</span></div>
                  <div className="feed-stat"><strong>{stats.vehiclesActive}</strong><span>vehicles</span></div>
                  <div className="feed-stat"><strong>{stats.pollsSeen}/{stats.pollsExpected}</strong><span>polls (coverage)</span></div>
                </div>
                <div className="line-bars">
                  {stats.perLine.map((row) => {
                    const max = Math.max(1, ...stats.perLine.map((r) => r.sightings))
                    return (
                      <div key={row.line_code} className="line-bar-row">
                        <span className="line-bar-code">{row.line_code}</span>
                        <span className="line-bar-track"><span className="line-bar-fill" style={{ width: `${Math.round((row.sightings / max) * 100)}%` }} /></span>
                        <span className="line-bar-num">{row.sightings} · {row.trips} trips</span>
                      </div>
                    )
                  })}
                  {!stats.perLine.length && <p className="analytics-note">No history yet — the collector writes its first rows within a minute of server start.</p>}
                </div>
                <div className="trail-lookup">
                  <label htmlFor="trail-trip">Trip trail</label>
                  <div className="trail-row">
                    <select
                      id="trail-trip"
                      value={trailTripId}
                      onChange={(e) => { setTrailTripId(e.target.value); setTrailInfo(null) }}
                    >
                      <option value="">Select a trip…</option>
                      {stats.recentTrips.map((t) => (
                        <option key={t.trip_id} value={t.trip_id}>{t.trip_id} ({t.line_code}, {t.sightings}x)</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="line-chip"
                      disabled={!trailTripId}
                      onClick={async () => {
                        try {
                          const h = await fetchTripHistory(trailTripId)
                          const first = h.points[0]?.fetched_at ?? '?'
                          const last = h.points[h.points.length - 1]?.fetched_at ?? '?'
                          setTrailInfo(`${h.points.length} points · ${first} → ${last}`)
                        } catch (err) {
                          setTrailInfo(err instanceof Error ? err.message : String(err))
                        }
                      }}
                    >
                      Load trail
                    </button>
                  </div>
                  {trailInfo && <p className="analytics-note">{trailInfo}</p>}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </main>
  )
}

export default App
