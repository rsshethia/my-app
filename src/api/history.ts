export type StatsSummary = {
  range: string
  totalSightings: number
  vehiclesActive: number
  pollsSeen: number
  pollsExpected: number
  oldest: string | null
  newest: string | null
  perLine: { line_code: string; sightings: number; trips: number }[]
  recentTrips: {
    trip_id: string
    line_code: string
    sightings: number
    first_seen: string
    last_seen: string
  }[]
}

export type HistoryResponse = {
  tripId: string
  points: {
    fetched_at: string
    lat: number
    lon: number
    bearing: number | null
    vehicle_label: string | null
    line_code: string | null
  }[]
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${url} → ${res.status}: ${body.slice(0, 160)}`)
  }
  return res.json() as Promise<T>
}

export function fetchStats(range: '24h' | '10d' = '24h') {
  return getJson<StatsSummary>(`/api/stats?range=${range}`)
}

export function fetchTripHistory(tripId: string, limit = 500) {
  return getJson<HistoryResponse>(`/api/history?tripId=${encodeURIComponent(tripId)}&limit=${limit}`)
}
