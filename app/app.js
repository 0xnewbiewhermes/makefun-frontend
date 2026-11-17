// The shared core, import()ed by index.html's inline router: the response cache (stale-while-revalidate, bound to
// make.fun's minute), the API pill, the hash router with one lazily imported view per surface, the 1 s countdown
// ticker and the helpers every view shares (DOM builder, formatters, stat cards, leaderboard rows, base styles).

/** Cache first: a cached answer is served from memory, and when its minute has turned a re-read runs behind it. */
export function readCached(path, onChange) {
  const cached = responseCache.get(path);
  if (!cached) return revalidateOnce(path).then((result) => result.data);
  countTraffic('cached');
  revalidateIfStale(path, onChange);
  return Promise.resolve(cached.data);
}

/** The header's API pill, per view: network requests, answers served from memory, re-reads and how many found nothing new. */
function countTraffic(kind) {
  apiTraffic[kind]++;
  if (kind === 'revalidated') apiTraffic.requests++;
  paintPill();
}

function paintPill() {
  const { requests, cached, revalidated, unchanged } = apiTraffic;
  const parts = [`${requests} API request${requests === 1 ? '' : 's'}`, `${cached} from memory`, revalidated && `${revalidated} revalidated (${unchanged} unchanged)`];
  setText(apiPill, 'this view: ' + parts.filter(Boolean).join(' · '));
}

/** Re-read `path` once a minute, just after the minute turns, while the tab is visible (and on return to it). */
export function revalidateWhileVisible(path, onChange) {
  const revalidate = revalidateIfStale.bind(null, path, onChange);
  const timer = setInterval(revalidate, 15_000);
  document.addEventListener('visibilitychange', revalidate);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', revalidate);
  };
}

/** One 1 s timer for every [data-deadline] countdown (text, urgency, deadline bar) and [data-checked] node: same elements. */
function tickCountdownsInPlace() {
  if (document.hidden) return;
  for (const node of document.querySelectorAll('[data-deadline]')) {
    const ms = new Date(node.dataset.deadline) - Date.now();
    setText(node, formatTimeLeft(node.dataset.deadline));
    const urgency = ms < 3_600_000 ? 'urgent' : ms < 86_400_000 ? 'soon' : '';
    if (node.dataset.urgency !== urgency) node.dataset.urgency = urgency;
    const opens = node.dataset.opens;
    if (opens) {
      const used = Math.min(100, Math.max(0, Math.round((1 - ms / (new Date(node.dataset.deadline) - new Date(opens))) * 200) / 2));
      if (node.parentNode.dataset.used != used) {
        node.parentNode.dataset.used = used;
        node.parentNode.style.setProperty('--used', used + '%');
      }
    }
  }
  for (const node of document.querySelectorAll('[data-checked]')) {
    const fetchedAt = responseCache.get(node.dataset.checked)?.fetchedAt;
    if (fetchedAt) setText(node, `● Live · checked ${formatTimeAgo(new Date(fetchedAt))}`);
  }
}

export function start() {
  adoptViewStyles(APP_CSS);
  document.querySelector('header output').replaceWith(apiPill);
  document.querySelector('header button').onclick = () => {
    responseCache.clear();
    renderCurrentRoute();
  };
  viewRoot.addEventListener('pointerover', prefetchBountyOnHover);
  addEventListener('hashchange', renderCurrentRoute);
  setInterval(tickCountdownsInPlace, 1000);
  renderCurrentRoute().then(warmLaterViewsWhenIdle);
}

async function renderCurrentRoute() {
  const generation = ++activeRoute.generation;
  window.__shotReady = false;
  activeRoute.unmount?.();
  activeRoute.unmount = null;
  Object.assign(apiTraffic, { requests: 0, cached: 0, revalidated: 0, unchanged: 0 });
  paintPill();
  const route = { isCurrent: () => generation === activeRoute.generation, whenCurrent: (fn) => (...args) => route.isCurrent() && fn(...args) };
  try {
    const { name, params } = parseHashRoute(location.hash);
    markNav(name, params);
    viewRoot.replaceChildren(renderSkeleton(name));
    if (generation > 1) scrollTo(0, 0);
    if (!params.slug && (name === 'bounty' || name === 'leaderboard')) {
      const board = await readCached(apiPaths.board());
      if (!route.isCurrent()) return;
      const live = board.items.filter(isLive);
      const pick = live.find((b) => b.slug === lastSlug) || live.sort(name === 'bounty' ? (a, b) => livePot(b) - livePot(a) : (a, b) => b.submissionCount - a.submissionCount)[0] || board.items[0];
      location.replace(`#/bounty/${encodeURIComponent(pick.slug)}${name === 'leaderboard' ? '/leaderboard' : ''}`);
      return;
    }
    if (params.slug) lastSlug = params.slug;
    if (params.slug) markNav(name, params);
    const unmount = await (await ROUTES[name]())(viewRoot, params, route);
    if (!route.isCurrent()) return unmount?.();
    activeRoute.unmount = unmount || null;
  } catch (error) {
    if (!route.isCurrent()) return;
    viewRoot.replaceChildren(renderErrorState(error, renderCurrentRoute));
  }
  if (generation > 1) viewRoot.querySelector('h1')?.focus({ preventScroll: true });
  tickCountdownsInPlace();
  window.__shotReady = true;
}

/** Header tabs: the active one is marked, and Bounty / Leaderboard point at the bounty last opened. */
function markNav(name, { slug }) {
  const tab = { board: 0, bounty: 1, leaderboard: 2, profile: 3, profiles: 3 }[name];
  const links = document.querySelectorAll('header nav a');
  if (slug) {
    links[1].href = bountyHref(slug);
    links[2].href = leaderboardHref(slug);
  }
  links.forEach((link, index) => (index === tab ? link.setAttribute('aria-current', 'page') : link.removeAttribute('aria-current')));
}

/** The API reads, one per surface. */
export const apiPaths = {
  board: () => '/api/competitions?status=open&activity=times',
  ended: () => '/api/competitions?status=resolved',
  bounty: ({ slug }) => `/api/competitions/${encodeURIComponent(slug)}?submissions=summary`,
  leaderboard: ({ slug }) => `/api/competitions/${encodeURIComponent(slug)}/leaderboard?rows=first`,
  profile: ({ handle }) => `/api/profiles/${encodeURIComponent(handle)}`,
};

/** One view per route, each import()ed on first use. */
const ROUTES = {
  board: async () => (await import('./board.js')).mountBoardView,
  bounty: async () => (await import('./bounty.js')).mountBountyView,
  leaderboard: async () => (await import('./leaderboard.js')).mountLeaderboardView,
  profile: async () => (await import('./profile.js')).mountProfileView,
  profiles: async () => (await import('./profile.js')).mountProfilesView,
};

export const MAKEFUN_ORIGIN = 'https://make.fun';
const responseCache = new Map(),
  inflightRequests = new Map(),
  apiTraffic = { requests: 0, cached: 0, revalidated: 0, unchanged: 0 },
  apiPill = el('output', { className: 'api-pill', title: 'Counted live by fetchIntoCache and readCached in app.js' });
let lastSlug = '';

class ApiError extends Error {
  constructor(status) {
    super(status === 404 ? 'Not found on make.fun' : `make.fun answered ${status || 'no response'}`);
    this.status = status;
  }
}

/** Re-read when the tab is visible and the cached answer's minute has turned; onChange only when the answer changed. */
function revalidateIfStale(path, onChange) {
  const minute = (time) => Math.floor(time / 60_000);
  if (document.hidden || minute(responseCache.get(path)?.fetchedAt) === minute(Date.now())) return;
  revalidateOnce(path).then((r) => r.changed && onChange?.(r.data), () => {});
}

/** GET into the cache, counted in the API pill. No If-None-Match: make.fun's 304 carries no CORS header, so a browser could
 * not read it (and the header costs a preflight). An answer that matches the cached one reports changed: false. */
async function fetchIntoCache(path) {
  const cached = responseCache.get(path);
  countTraffic(cached ? 'revalidated' : 'requests');
  const response = await fetch(MAKEFUN_ORIGIN + path, { cache: 'no-store', signal: AbortSignal.timeout(30_000) }).catch(() => {
    throw new ApiError(0);
  });
  if (!response.ok) throw new ApiError(response.status);
  const data = await response.json();
  const signature = JSON.stringify(data);
  if (cached?.signature === signature) {
    cached.fetchedAt = Date.now();
    countTraffic('unchanged');
    return { data: cached.data, changed: false };
  }
  responseCache.set(path, { data, signature, fetchedAt: Date.now() });
  return { data, changed: true };
}

function revalidateOnce(path) {
  if (!inflightRequests.has(path)) inflightRequests.set(path, fetchIntoCache(path).finally(() => inflightRequests.delete(path)));
  return inflightRequests.get(path);
}

/** The cached answer if there is one (no request): counted as served from memory when it is. */
export function peekCached(path) {
  const data = responseCache.get(path)?.data;
  if (data) countTraffic('cached');
  return data;
}

function prefetchBountyOnHover(event) {
  const slug = event.target.closest?.('a[href^="#/bounty/"]')?.hash.split('/')[2];
  const path = slug && apiPaths.bounty({ slug: decodeURIComponent(slug) });
  if (path && !responseCache.has(path)) revalidateOnce(path).catch(() => {});
}

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
  return node;
}

export function adoptViewStyles(cssText) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(cssText);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

export const setText = (node, text) => node.textContent != text && (node.textContent = text);

export const formatUsd = (value) => '$' + Number(value).toLocaleString('en', { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 2 }),
  livePot = (bounty) => +(bounty.potUsd ?? bounty.rewardAmount),
  isLive = (bounty) => new Date(bounty.deadline) > Date.now(),
  formatCount = (n) => (Number(n) || 0).toLocaleString('en-US'),
  entryFeeUsd = (bounty) => Number(bounty.entryFeeUsd || 0),
  formatEntryFee = (bounty) => (entryFeeUsd(bounty) > 0 ? formatUsd(bounty.entryFeeUsd) : 'Free'),
  paidPlaces = (bounty) => bounty.rewardsNow?.length || Object.keys(bounty.rewards || {}).length,
  bountyHref = (slug) => `#/bounty/${encodeURIComponent(slug)}`,
  leaderboardHref = (slug) => `#/bounty/${encodeURIComponent(slug)}/leaderboard`,
  profileHref = (handle) => `#/u/${encodeURIComponent(handle)}`;

export function formatTimeLeft(deadline) {
  const s = (new Date(deadline) - Date.now()) / 1e3;
  const [d, h, m] = [s / 864e2, (s % 864e2) / 3600, (s % 3600) / 60].map(Math.floor);
  return s < 1 ? 'Closed' : d ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${Math.floor(s % 60)}s`;
}

export const formatDateTime = (iso) => (iso ? `${new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC` : '—'),
  formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' }) : '—');

export function formatTimeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
}

/** A score as its column means it: *_micro rates as a percentage, else the API's own display string. */
export function formatScore(value, display, column) {
  if (value == null && display == null) return '—';
  if (column?.source?.endsWith('_micro') && Number.isFinite(Number(value))) return `${(Number(value) / 10_000).toFixed(1)}%`;
  return display ?? String(value);
}

/** A stat card: a label above a prominent value, an optional note beneath. Text is written into the same nodes. */
export function statCard(label, className = '') {
  const value = el('dd', { className: 'stat-value' }), note = el('span', { className: 'stat-note' });
  return { node: el('div', { className: `stat ${className}` }, el('dt', { className: 'stat-label' }, label), value, note), value, note };
}

/** What a place pays now: the live pot's share from rewardsNow (base + fee share), else the fixed reward table. */
export function prizeNow(bounty, place) {
  const live = bounty?.rewardsNow?.find((reward) => reward.place === place);
  return live ? Number(live.amountUsd) : Number(bounty?.rewards?.[place] || 0);
}

/** Both leaderboard row shapes the API sends (whole and light) as one list sorted by rank. */
export function normalizeLeaderboardRows(board) {
  const rankColumn = board.columns?.find((column) => column.key === board.rank_key) || null;
  const row = (entry, value, display, image) => ({ rank: entry.rank, prizeRank: entry.prize_rank ?? entry.rank, handle: entry.handle, title: entry.title, image, value, display, interval: entry.interval, receivedAt: entry.received_at, house: entry.house || entry.baseline });
  const rows = [
    ...(board.entries || []).map((entry) => row(entry, entry.values?.[board.rank_key], entry.display?.[board.rank_key], entry.image)),
    ...(board.rest || []).map((entry) => row(entry, entry.value, entry.display, null)),
  ];
  return { rankColumn, rows: rows.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity)) };
}

/** A profile picture: crossorigin set before src (make.fun sends CORP same-origin), initials when there is none. */
export function avatarImage(url, handle, size) {
  if (!url) return el('span', { className: 'avatar avatar-initials', style: `--avatar-size:${size}px`, 'aria-hidden': 'true' }, (handle || '?').slice(0, 2).toUpperCase());
  const image = el('img', { className: 'avatar', crossOrigin: 'anonymous', width: size, height: size, alt: '', loading: 'lazy', decoding: 'async', style: `--avatar-size:${size}px` });
  image.src = url;
  return image;
}

/** An API-relative asset (avatar, image) as an absolute make.fun URL; other origins only over https. */
export function absoluteAssetUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  if (url.startsWith('/')) return MAKEFUN_ORIGIN + url;
  return /^https:\/\//i.test(url) ? url : null;
}

/** Put children in order by moving the existing nodes; one that drops out is detached, never destroyed. */
export function patchChildrenInPlace(parent, nodes) {
  nodes.forEach((node, index) => parent.children[index] !== node && parent.insertBefore(node, parent.children[index] || null));
  while (parent.children.length > nodes.length) parent.lastElementChild.remove();
}

const viewRoot = document.querySelector('main'),
  activeRoute = { generation: 0, unmount: null };

function parseHashRoute(hash) {
  const parts = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'bounty') return { name: parts[2] === 'leaderboard' ? 'leaderboard' : 'bounty', params: { slug: parts[1] } };
  if (parts[0] === 'leaderboard') return { name: 'leaderboard', params: {} };
  if (parts[0] === 'u') return parts[1] ? { name: 'profile', params: { handle: parts[1].replace(/^@/, '') } } : { name: 'profiles', params: {} };
  return { name: 'board', params: {} };
}

function renderSkeleton(routeName) {
  const bar = (className) => el('div', { className: `skeleton ${className}` });
  return el('div', { className: 'skeleton-view', 'aria-busy': 'true', 'aria-label': 'Loading' }, bar('skeleton-title'), bar('skeleton-block'), bar('skeleton-block'));
}

function renderErrorState(error, retry) {
  const notFound = error?.status === 404;
  return el(
    'section',
    { className: 'error-state', role: 'alert' },
    el('h1', { tabIndex: -1 }, notFound ? 'Not found' : 'Could not load this page'),
    el('p', null, notFound ? 'make.fun has nothing at this address.' : `${error?.message || 'Network error'}. Check your connection and try again.`),
    el('div', { className: 'error-actions' }, el('button', { type: 'button', className: 'button button-primary', onclick: retry }, 'Retry'), el('a', { href: '#/', className: 'button' }, 'Back to the board')),
  );
}

function warmLaterViewsWhenIdle() {
  const warm = () => Promise.all([ROUTES.board(), ROUTES.bounty(), ROUTES.leaderboard(), ROUTES.profile()]).catch(() => {});
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 2500);
}

// The base styles every view shares; index.html carries only the header, footer and page frame.
const APP_CSS = `
:root{--surface-2:#e8ebf2;--on-accent:#fff;--accent-soft:#e9e5ff;--money-soft:#dcf2e5;--soon:#9a4d00;--urgent:#bf1f27;--urgent-soft:#fde4e5;--gold:#9a6f00;--focus:#1f6feb;--radius:10px;--mono:ui-monospace,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0d0f14;--surface:#171a21;--border:#323845;--text:#eef0f4;--muted:#adb4c2;--accent:#a395ff;--money:#4fd890;--surface-2:#232733;--on-accent:#0d0f14;--accent-soft:#2a2350;--money-soft:#14301f;--soon:#ffb054;--urgent:#ff8a8a;--urgent-soft:#3a1c1f;--gold:#f0c24c;--focus:#6ea8ff}}
[hidden]{display:none!important}
a{color:var(--accent);text-underline-offset:2px}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
h1,h2{margin:0}
h1{font-size:1.6rem;line-height:1.2}
h1:focus{outline:none}
body>header button{margin-left:6px;font:inherit;font-size:.85rem;color:#fff;background:#fff2;border:1px solid #fff4;border-radius:6px;padding:3px 10px;cursor:pointer}
[data-urgency=soon]{color:var(--soon)}
[data-urgency=urgent]{color:var(--urgent)}
.muted{color:var(--muted)}
.small{font-size:.85rem}
.visually-hidden{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.input,.button,.chip{box-sizing:border-box;font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border)}
.input{min-height:36px;padding:5px 10px;border-radius:8px;font-size:.92rem}
.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:5px 14px;border-radius:8px;font-size:.92rem;font-weight:600;text-decoration:none;cursor:pointer}
.button:hover{border-color:var(--accent)}
.button-primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.chip{display:inline-flex;align-items:center;gap:5px;min-height:30px;padding:2px 11px;border-radius:999px;font-size:.84rem;font-weight:600;cursor:pointer}
.chip:hover{border-color:var(--accent)}
.chip[aria-pressed=true],.chip[aria-selected=true]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.chip-count{opacity:.8}
.chip-static{cursor:default;font-weight:500;background:var(--surface-2);border-color:transparent;min-height:0;padding:1px 9px}
.api-pill{padding:3px 11px;border-radius:999px;background:#fff;color:#14121f;font-size:.82rem;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.empty-state{padding:28px 16px;border:1px dashed var(--border);border-radius:var(--radius);background:var(--surface);color:var(--muted);text-align:center}
.error-state{max-width:560px;margin:40px auto;padding:32px 24px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);text-align:center}
.error-actions{display:flex;justify-content:center;gap:8px;margin-top:16px}
.skeleton-view{display:grid;gap:14px}
.skeleton{min-height:38px;border-radius:var(--radius);background:linear-gradient(90deg,var(--surface-2) 25%,var(--surface) 50%,var(--surface-2) 75%) 0 0/200% 100%;animation:shimmer 1.3s linear infinite}
.skeleton-title{width:min(420px,70%)}
.skeleton-block{height:160px}
@keyframes shimmer{to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.skeleton{animation:none}}
.view-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 16px;margin-bottom:10px}
.subtabs{display:flex;gap:4px;padding:3px;border-radius:9px;background:var(--surface-2)}
.subtabs a{padding:5px 14px;border-radius:7px;color:var(--text);font-weight:600;font-size:.9rem;text-decoration:none}
.subtabs [aria-current]{background:var(--surface);color:var(--accent);box-shadow:0 1px 2px #0003}
.stat-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 12px}
.stat,.panel{min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
.stat{padding:8px 12px}
.stat-label{color:var(--muted);font-size:.72rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.stat-value{margin:1px 0 0;font-size:1.5rem;font-weight:800;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;line-height:1.2}
.stat-pot .stat-value{color:var(--money);font-size:1.8rem}
.stat-fee .stat-value{color:var(--accent)}
.stat-note{display:block;min-height:1.1em;color:var(--muted);font-size:.78rem}
.panel{padding:12px 16px;line-height:1.5}
.panel h2{font-size:1rem;margin:0 0 6px}
.table-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:7px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:middle}
th[scope=col]{background:var(--surface-2);color:var(--muted);font-size:.72rem;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
.tag{display:inline-block;padding:1px 7px;border-radius:5px;background:var(--accent-soft);color:var(--accent);font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.02em}
.status-badge{padding:2px 10px;border-radius:999px;background:var(--surface-2);font-size:.78rem;font-weight:700}
.status-badge[data-tone=live]{background:var(--money-soft);color:var(--money)}
.status-badge[data-tone=live]::before{content:"● "}
.avatar{--avatar-size:32px;flex:none;width:var(--avatar-size);height:var(--avatar-size);border-radius:50%;object-fit:cover;background:var(--surface-2)}
.avatar-initials{display:inline-grid;place-items:center;color:var(--accent);background:var(--accent-soft);font-size:calc(var(--avatar-size)*.4);font-weight:700}
.tl{min-width:6.5rem}
.tl .t{font-weight:700}
.bar{display:block;height:4px;margin-top:3px;border-radius:2px;background:var(--surface-2);overflow:hidden}
.bar::after{content:"";display:block;height:100%;width:var(--used,0%);background:var(--accent)}
.tl:has([data-urgency=soon]) .bar::after{background:var(--soon)}
.tl:has([data-urgency=urgent]) .bar::after{background:var(--urgent)}
.badge{display:none;margin-left:4px;padding:0 6px;border-radius:5px;background:var(--urgent-soft);color:var(--urgent);font-size:.68rem;font-style:normal;font-weight:800;text-transform:uppercase;vertical-align:1px}
.tl:has([data-urgency=urgent]) .badge{display:inline-block}
@media (max-width:640px){body>header{flex-wrap:wrap;row-gap:4px;font-size:14px}body>header b{margin-right:2px}@media (max-width:430px){body>header b{display:none}}nav a{padding:5px 7px}.api-pill{font-size:.7rem;padding:2px 8px}.stat-row{grid-template-columns:repeat(2,minmax(0,1fr))}.stat-value{font-size:1.3rem}.stat-pot .stat-value{font-size:1.5rem}.panel{padding:12px}h1{font-size:1.35rem}}
`;
