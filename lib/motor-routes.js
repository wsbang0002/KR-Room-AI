const CAR_URL = 'https://apis.openapi.sk.com/tmap/routes?version=1';
const BUS_URL = 'https://apis.openapi.sk.com/transit/routes/sub';

function totals(route, samePoint) {
  const distanceMeters = route?.totalDistance;
  const durationSeconds = route?.totalTime;
  if (!Number.isSafeInteger(distanceMeters) || !Number.isSafeInteger(durationSeconds)) return null;
  if (distanceMeters > 0 && durationSeconds > 0) return { distanceMeters, durationSeconds };
  if (samePoint && distanceMeters === 0 && durationSeconds === 0) return { distanceMeters, durationSeconds };
  return null;
}

function carSummary(data, samePoint) {
  if (!Array.isArray(data?.features)) return { reason: 'invalid-response' };
  if (!data.features.length) return { reason: 'route-not-found' };
  // totalValue=2 returns one feature with route totals and no geometry.
  return totals(data.features[0]?.properties, samePoint) ?? { reason: 'invalid-response' };
}

function busSummary(data) {
  const itineraries = data?.metaData?.plan?.itineraries;
  if (!Array.isArray(itineraries)) return { reason: 'invalid-response' };
  let fastest;
  let invalid = false;
  for (const route of itineraries) {
    if (!Number.isInteger(route?.pathType) || route.pathType < 1 || route.pathType > 7) {
      invalid = true;
      continue;
    }
    if (route.pathType !== 2) continue;
    const summary = totals(route, false);
    if (!summary) invalid = true;
    else if (!fastest || summary.durationSeconds < fastest.durationSeconds) fastest = summary;
  }
  return fastest ?? { reason: invalid ? 'invalid-response' : 'route-not-found' };
}

export async function requestMotorSummary(mode, listing, destination, { env, fetcher, signal }) {
  if (mode !== 'bus' && mode !== 'car') return { reason: 'unsupported-mode' };
  const bus = mode === 'bus';
  const appKey = bus ? env.TMAP_TRANSIT_APP_KEY : env.TMAP_APP_KEY;
  if (!appKey) return { reason: 'missing-key' };
  const body = bus ? {
    startX: String(listing.lng), startY: String(listing.lat),
    endX: String(destination.lng), endY: String(destination.lat), count: 10
  } : {
    startX: listing.lng, startY: listing.lat, endX: destination.lng, endY: destination.lat,
    reqCoordType: 'WGS84GEO', resCoordType: 'WGS84GEO', totalValue: 2
  };
  try {
    const response = await fetcher(bus ? BUS_URL : CAR_URL, {
      method: 'POST', redirect: 'error', signal: signal ?? AbortSignal.timeout(4500),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', appKey },
      body: JSON.stringify(body)
    });
    if (response.status === 204) return { reason: 'route-not-found' };
    if (response.status === 429) return { reason: 'upstream-rate-limit' };
    if (response.status === 401 || response.status === 403) return { reason: 'authentication' };
    if (response.status >= 500) return { reason: 'upstream-server' };
    if (!response.ok && response.status !== 400) return { reason: 'upstream-request' };
    const data = await response.json();
    if (bus && data?.result?.status !== undefined) {
      const status = Number(data.result.status);
      if ([11, 12, 13, 14, 23].includes(status)) return { reason: 'route-not-found' };
      if (status === 31) return { reason: 'timeout' };
      if (status === 32) return { reason: 'upstream-server' };
      return { reason: 'upstream-request' };
    }
    if (!response.ok) {
      if (!bus && String(data?.error?.code) === '3002') return { reason: 'route-not-found' };
      return { reason: 'upstream-request' };
    }
    return bus ? busSummary(data) : carSummary(data, listing.lng === destination.lng && listing.lat === destination.lat);
  } catch (error) {
    if (signal?.aborted || ['TimeoutError', 'AbortError'].includes(error?.name)) return { reason: 'timeout' };
    return { reason: error instanceof SyntaxError ? 'invalid-response' : 'network' };
  }
}
