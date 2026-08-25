import { useEffect, useRef, useState } from 'react'
import { LngLatBounds, Map, Marker, NavigationControl, Popup } from 'mapbox-gl/esm'
import 'mapbox-gl/dist/mapbox-gl.css'
import './App.css'
import { fetchVehiclePositions, type VehiclePositionFeed } from './api/fetchData'

type VehiclePoint = {
  id: string
  latitude: number
  longitude: number
  bearing?: number
  values: Record<string, string>
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
// become map rows. The flattened values remain attached for the full data table
// and marker popup rather than discarding fields during normalization.
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
    const bearingValue = Number(values['vehicle.position.bearing'])

    return [{
      id,
      latitude,
      longitude,
      bearing: Number.isFinite(bearingValue) ? bearingValue : undefined,
      values,
    }]
  })
}

function VehicleMap({ points }: { points: VehiclePoint[] }) {
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
    map.current.on('error', (event) => {
      if (event.error?.message) setMapError('Mapbox could not load the map style. Check that VITE_MAPBOX_TOKEN is valid.')
    })
    map.current.addControl(new NavigationControl({ showCompass: false }), 'top-right')

    return () => {
      map.current?.remove()
      map.current = null
      setMapReady(false)
    }
  }, [token])

  // Rebuild markers whenever fresh API data arrives, then fit the camera to the
  // current vehicle extent so vehicles across Victoria remain visible.
  useEffect(() => {
    if (!map.current) return

    const markers: [number, number][] = []
    const mapMarkers = points.map((point) => {
      const element = document.createElement('button')
      element.type = 'button'
      element.className = 'vehicle-marker'
      element.ariaLabel = `Show details for ${point.id}`
      element.style.setProperty('--bearing', `${point.bearing ?? 0}deg`)

      const popupContent = Object.entries(point.values)
        .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
        .join('')
      const marker = new Marker({ element })
        .setLngLat([point.longitude, point.latitude])
        .setPopup(new Popup({ offset: 14, maxWidth: '320px' }).setHTML(`<strong>${escapeHtml(point.id)}</strong><dl>${popupContent}</dl>`))
        .addTo(map.current as Map)

      markers.push([point.longitude, point.latitude])
      return marker
    })

    if (markers.length === 1) {
      map.current.setCenter(markers[0])
      map.current.setZoom(11)
    } else if (markers.length > 1) {
      const bounds = markers.reduce((currentBounds, marker) => currentBounds.extend(marker), new LngLatBounds(markers[0], markers[0]))
      map.current.fitBounds(bounds, { padding: 64, maxZoom: 12, duration: 500 })
    }

    return () => mapMarkers.forEach((marker) => marker.remove())
  }, [points, mapReady])

  if (!token) {
    return <div className="map-missing">Add <code>VITE_MAPBOX_TOKEN</code> to <code>.env</code> to load the Victoria basemap.</div>
  }

  return (
    <div className="map-wrap">
      <div ref={mapContainer} className="map" role="img" aria-label="Live vehicle positions across Victoria" />
      {mapError && <div className="map-error" role="alert">{mapError}</div>}
    </div>
  )
}

function App() {
  const [data, setData] = useState<VehiclePositionFeed | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      const apiKey = import.meta.env.VITE_VLINE_KEY as string | undefined
      if (!apiKey) {
        setError('Missing VLINE API key. Set VITE_VLINE_KEY in .env (do NOT commit the key).')
        setLoading(false)
        return
      }

      try {
        const result = await fetchVehiclePositions(apiKey)
        setData(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load vehicle positions')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [])

  const points = data ? extractVehiclePoints(data) : []
  const columns = Array.from(new Set(points.flatMap((point) => Object.keys(point.values))))

  return (
    <main className="app-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">V/Line live operations</p>
          <h1>Vehicle positions</h1>
          <p className="subtitle">Where is my train dude? A live view of every vehicle position returned by the feed.</p>
        </div>
        {!loading && !error && <div className="feed-stat"><strong>{points.length}</strong><span>vehicles plotted</span></div>}
      </header>

      {loading && <p>Loading data...</p>}
      {error && <p role="alert">{error}</p>}

      {!loading && !error && (
        <div className="dashboard-grid">
          <section className="panel map-panel">
            <div className="section-heading"><div><p className="eyebrow">Geographic overview</p><h2>Live map</h2></div><span className="map-badge">VICTORIA</span></div>
            <VehicleMap points={points} />
            <div className="map-footer"><span><i className="legend-dot" /> Vehicle position</span><span>Click a marker for full details</span></div>
          </section>

          <section className="panel table-panel">
            <div className="section-heading"><div><p className="eyebrow">Complete feed data</p><h2>Vehicle table</h2></div><span className="column-count">{columns.length} fields</span></div>
            <div className="table-scroll"><table>
              <thead>
                <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
              </thead>
              <tbody>
                {points.map((point, index) => (
                  <tr key={`${point.id}-${index}`}>{columns.map((column) => <td key={column} title={point.values[column]}>{point.values[column] ?? '-'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table></div>
            {!points.length && <p className="empty-state">No vehicle entities with coordinates were returned by the API.</p>}
            {data !== null && <details className="raw-feed"><summary>Inspect raw API response</summary><pre>{JSON.stringify(data, null, 2)}</pre></details>}
          </section>
        </div>
      )}
    </main>
  )
}

export default App
