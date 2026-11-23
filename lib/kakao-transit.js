const endpoint = 'https://dapi.kakao.com/v2/routing/publictraffic';
const noRoute = new Set(['NO_RESULTS', 'STARTNODES_NULL', 'ENDNODES_NULL', 'EQUAL_POINTS']);

function busSummary(data) {
  if (noRoute.has(data?.status)) return { reason: 'route-not-found' };
  if (data?.status === 'INVALID_REQUEST') return { reason: 'upstream-request' };
  if (data?.status !== 'OK' || !Array.isArray(data.routes)) return { reason: 'invalid-response' };

  let fastest;
  let malformed = false;
  for (const route of data.routes) {
    const properties = route?.properties;
    if (properties?.type === 'SUBWAY' || properties?.type === 'BUS_AND_SUBWAY') continue;
    const seconds = properties?.totalTime;
    const meters = properties?.totalDistance;
    if (properties?.type !== 'BUS' || !Number.isSafeInteger(seconds) || seconds <= 0 ||
        !Number.isSafeInteger(meters) || meters <= 0) {
      malformed = true;
      continue;
    }
    if (!fastest || seconds < fastest.durationSeconds) fastest = { durationSeconds: seconds, distanceMeters: meters };
  }
  return fastest ?? { reason: malformed ? 'invalid-response' : 'route-not-found' };
}

export async function requestKakaoBus(listing, destination, { env, fetcher, signal }) {
  const key = env.KAKAO_REST_API_KEY;
  if (!key) return { reason: 'missing-key' };
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    start_x: listing.lng, start_y: listing.lat,
    end_x: destination.lng, end_y: destination.lat, input_coord: 'WGS84'
  }).toString();
  const requestSignal = signal ?? AbortSignal.timeout(4500);
  try {
    const response = await fetcher(url.toString(), {
      method: 'GET', signal: requestSignal, redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json', Authorization: 'KakaoAK ' + key }
    });
    // Kakao returns a JSON error code for quota exhaustion, including on HTTP 400.
    let data;
    try { data = await response.json(); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (String(data?.code) === '-10' || response.status === 429) return { reason: 'upstream-rate-limit' };
    if (response.status === 401 || response.status === 403) return { reason: 'authentication' };
    if (response.status >= 500) return { reason: 'upstream-server' };
    if (!response.ok) return { reason: 'upstream-request' };
    return busSummary(data);
  } catch (error) {
    if (requestSignal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      return { reason: 'timeout' };
    }
    return { reason: 'network' };
  }
}
