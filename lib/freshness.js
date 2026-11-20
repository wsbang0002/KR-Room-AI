// Only a source observation or a collection timestamp can establish listing age.
function sourceDate(value, now) {
  if (typeof value !== 'string') return null;
  const day = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/i.exec(value)?.[1];
  if (!day) return null;
  const midnight = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now ? new Date(time).toISOString() : null;
}

export function listingFreshness(item, now = Date.now(), staleDays = 7) {
  const lastSeenAt = sourceDate(item.lastSeenAt, now);
  const collectedAt = sourceDate(item.collectedAt, now);
  const observed = lastSeenAt || collectedAt;
  let syncStatus = 'unknown';
  if (observed) syncStatus = now - Date.parse(observed) > staleDays * 86_400_000 ? 'stale' : 'current';
  return {lastSeenAt, collectedAt, syncStatus};
}
