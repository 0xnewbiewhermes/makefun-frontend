// make.fun's public, read-only API with one in-memory cache in front of it.
//
// Every answer is kept by its path with its ETag. A read within FRESH_FOR_MS of the last one is answered from memory
// with no request. A later read is answered from memory at once too (stale-while-revalidate) while a conditional GET
// (If-None-Match) runs in the background; a 304, or a 200 whose body is byte for byte the one we hold (make.fun's tags
// turn every minute), changes nothing, and only a real change reaches the view's onUpdate to be patched in place.
// Concurrent reads of one path share one request.

export const MAKEFUN_ORIGIN = 'https://make.fun';
const FRESH_FOR_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** path -> { data, text, etag, fetchedAt } */
const responseCache = new Map();
/** path -> Promise of an in-flight revalidation */
const inflightRequests = new Map();

export class ApiError extends Error {
  constructor(status, path) {
    super(status === 404 ? 'Not found on make.fun' : `make.fun answered ${status || 'no response'}`);
    this.status = status;
    this.path = path;
  }
}

async function fetchWithEtag(path) {
  const cached = responseCache.get(path);
  const headers = { accept: 'application/json' };
  if (cached?.etag) headers['if-none-match'] = cached.etag;
  let response;
  try {
    response = await fetch(MAKEFUN_ORIGIN + path, { headers, cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new ApiError(0, path);
  }
  if (response.status === 304 && cached) {
    cached.fetchedAt = Date.now();
    return { data: cached.data, changed: false };
  }
  if (!response.ok) throw new ApiError(response.status, path);
  const text = await response.text();
  const etag = response.headers.get('etag');
  if (cached && cached.text === text) {
    Object.assign(cached, { etag, fetchedAt: Date.now() });
    return { data: cached.data, changed: false };
  }
  const data = JSON.parse(text);
  responseCache.set(path, { data, text, etag, fetchedAt: Date.now() });
  return { data, changed: true };
}

function revalidatePath(path) {
  let pending = inflightRequests.get(path);
  if (!pending) {
    pending = fetchWithEtag(path).finally(() => inflightRequests.delete(path));
    inflightRequests.set(path, pending);
  }
  return pending;
}

/** Read a path: from memory when fresh, from memory then revalidated when stale, from the network when absent. */
export function readCached(path, onUpdate) {
  const cached = responseCache.get(path);
  if (!cached) return revalidatePath(path).then((result) => result.data);
  if (Date.now() - cached.fetchedAt > FRESH_FOR_MS) {
    revalidatePath(path)
      .then((result) => result.changed && onUpdate?.(result.data))
      .catch(() => {});
  }
  return Promise.resolve(cached.data);
}

/** Revalidate now (polling); resolves to the new data when it changed, else null. */
export async function refreshCached(path) {
  const result = await revalidatePath(path);
  return result.changed ? result.data : null;
}

/** What memory holds for a path, without any request. */
export const peekCached = (path) => responseCache.get(path)?.data;

export const boardPath = () => '/api/competitions?status=open&activity=times';
export const bountyPath = (slug) => `/api/competitions/${encodeURIComponent(slug)}?submissions=summary`;
export const leaderboardPath = (slug) => `/api/competitions/${encodeURIComponent(slug)}/leaderboard?rows=first`;
export const profilePath = (handle) => `/api/profiles/${encodeURIComponent(handle)}`;

/** An API-relative asset (avatar, artifact) as an absolute make.fun URL; other origins only over https. */
export function absoluteAssetUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('/')) return MAKEFUN_ORIGIN + url;
  return /^https:\/\//i.test(url) ? url : null;
}

/** Warm the cache for a bounty page before the click lands (hover / focus on its link). */
export function prefetchBounty(slug) {
  if (!responseCache.has(bountyPath(slug))) revalidatePath(bountyPath(slug)).catch(() => {});
}
