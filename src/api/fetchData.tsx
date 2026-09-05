import gtfsRealtimeBindings from 'gtfs-realtime-bindings';

// The protobuf library returns a deeply nested JSON object whose entity shape
// can vary by feed version. Keeping this boundary JSON-friendly lets the UI
// normalize the fields it needs without coupling to generated protobuf types.
export type VehiclePositionFeed = unknown

// Fetch the binary GTFS-Realtime feed, decode its protobuf payload, and expose
// the result as plain JSON for the map, table, and raw-response inspector.
export async function fetchVehiclePositions(apiKey: string): Promise<VehiclePositionFeed> {
  // Prefer the server proxy (keeps VLINE_KEY off the client, enables history).
  // Falls back to direct fetch for local `vite dev` without the server running.
  try {
    const proxied = await fetch('/api/live')
    if (proxied.ok) return (await proxied.json()) as VehiclePositionFeed
  } catch {
    // ignore and fall through to direct fetch
  }

  if (!apiKey) throw new Error('Live backend unavailable and no VLINE API key. Start the server (npm run start:server) or set VITE_VLINE_KEY in .env.');

  const response = await fetch(
    'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/vline/vehicle-positions',
    {
      headers: {
        KeyId: apiKey,
        Accept: 'application/x-protobuf, application/octet-stream',
      },
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable body>');
    throw new Error(`VLine API error ${response.status}: ${response.statusText} - ${body}`);
  }

  // The endpoint returns protobuf bytes rather than JSON, so arrayBuffer is
  // required before the generated FeedMessage decoder can read the response.
  const buffer = await response.arrayBuffer();
  const feed = gtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

  return feed.toJSON() as VehiclePositionFeed;
}
