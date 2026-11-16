// Loaded by index.html's first-frame script once the board is on screen: the ETag cache, the router, the board's
// controls and in-place updates, the countdown ticker, and the helpers the lazily imported views share.
// The board painters and formatters are index.html's own, handed over in startApp, so none is written twice.

/** GET with If-None-Match. A 304, or a 200 with the same body (tags turn every minute), reports changed: false. */
async function readCachedWithEtag(path) {
  const cached = responseCache.get(path);
  const headers = cached?.etag ? { 'if-none-match': cached.etag } : {};
  const response = await fetch(MAKEFUN_ORIGIN + path, { headers, cache: 'no-store', signal: AbortSignal.timeout(30_000) }).catch(() => {
    throw new ApiError(0);
  });
  if (response.status === 304 && cached) {
    cached.fetchedAt = Date.now();
    return { data: cached.data, changed: false };
  }
  if (!response.ok) throw new ApiError(response.status);
  const text = await response.text();
  const fresh = { text, etag: response.headers.get('etag'), fetchedAt: Date.now() };
  if (cached?.text === text) {
    Object.assign(cached, fresh);
    return { data: cached.data, changed: false };
  }
  const data = JSON.parse(text);
  responseCache.set(path, { ...fresh, data });
  return { data, changed: true };
}

/** Put the cards in order by moving the existing nodes; a card that drops out is detached, never destroyed. */
function patchBoardCardsInPlace(list, cards) {
  cards.forEach((card, index) => list.children[index] !== card && list.insertBefore(card, list.children[index] || null));
  while (list.children.length > cards.length) list.lastElementChild.remove();
}

/** One 1 s timer for every [data-deadline] node on the page: rewrites its text and urgency, never its element. */
function tickCountdownsInPlace() {
  if (document.hidden) return;
  for (const node of document.querySelectorAll('[data-deadline]')) {
    const ms = new Date(node.dataset.deadline) - Date.now();
    setText(node, formatTimeLeft(node.dataset.deadline));
    const urgency = ms < 3_600_000 ? 'urgent' : ms < 86_400_000 ? 'soon' : '';
    if (node.dataset.urgency !== urgency) node.dataset.urgency = urgency;
  }
}

export function startApp(handoff) {
  ({ formatUsd, formatTimeLeft, livePotUsd, isTakingEntries, setText } = handoff);
  firstFrame = handoff;
  if (handoff.firstRead) responseCache.set(apiPaths.board(), { ...handoff.firstRead, fetchedAt: Date.now() });
  adoptViewStyles(APP_CSS);
  mountProfileSearch(document.querySelector('body>header'));
  viewRoot.addEventListener('pointerover', prefetchBountyOnHover);
  addEventListener('hashchange', renderCurrentRoute);
  tickCountdownsInPlace();
  setInterval(tickCountdownsInPlace, 1000);
  renderCurrentRoute().then(warmLaterViewsWhenIdle);
}

export function revalidateWhileVisible(path, onChange) {
  const revalidate = () => document.visibilityState === 'visible' && revalidateOnce(path).then((r) => r.changed && onChange(r.data), () => {});
  const timer = setInterval(revalidate, REVALIDATE_EVERY_MS);
  document.addEventListener('visibilitychange', revalidate);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', revalidate);
  };
}

/** Stale-while-revalidate: the cached answer at once, a background re-check when it is older than FRESH_FOR_MS. */
export function readCached(path, onChange) {
  const cached = responseCache.get(path);
  if (!cached) return revalidateOnce(path).then((result) => result.data);
  if (Date.now() - cached.fetchedAt > FRESH_FOR_MS) revalidateOnce(path).then((r) => r.changed && onChange?.(r.data), () => {});
  return Promise.resolve(cached.data);
}

/** The board (#/): adopts index.html's first frame when it is on screen, else paints it, then adds the controls. */
async function mountBoardView(container, _params, route) {
  document.title = 'Live bounties · make.fun';
  const onChange = route.whenCurrent((fresh) => applyBoardData(fresh));
  const data = await readCached(apiPaths.board(), onChange);
  if (!route.isCurrent()) return;
  const frame = firstFrame.frame?.list.isConnected ? firstFrame.frame : firstFrame.paintBoardFirstFrame(container, data.items.filter(isTakingEntries));
  firstFrame.frame = null;
  let liveBounties = [];
  const cards = new Map();
  const resultCount = el('p', { className: 'board-result-count', 'aria-live': 'polite' });
  const emptyState = el('p', { className: 'empty-state', hidden: true }, 'No live bounty matches. Clear the search or pick another category.');
  const { toolbar, chips } = buildBoardToolbar(applyBoardFilters);
  frame.list.before(toolbar, chips, resultCount);
  frame.list.after(emptyState);

  function applyBoardFilters() {
    renderCategoryChips(chips, liveBounties);
    const visible = liveBounties.filter((bounty) => (boardFilters.category === 'all' || bounty.category === boardFilters.category) && matchesSearch(bounty, boardFilters.query));
    patchBoardCardsInPlace(frame.list, visible.sort(BOARD_SORTS[boardFilters.sort][1]).map((bounty) => cards.get(bounty.slug)));
    emptyState.hidden = visible.length > 0;
    setText(resultCount, visible.length === liveBounties.length ? '' : `Showing ${visible.length} of ${liveBounties.length}`);
  }

  function applyBoardData(fresh) {
    liveBounties = fresh.items.filter(isTakingEntries);
    for (const bounty of liveBounties) cards.set(bounty.slug, firstFrame.patchBoardCardInPlace(bounty));
    firstFrame.writeBoardTotals(frame, liveBounties);
    applyBoardFilters();
  }

  applyBoardData(data);
  return revalidateWhileVisible(apiPaths.board(), onChange);
}

async function renderCurrentRoute() {
  const generation = ++activeRoute.generation;
  window.__shotReady = false;
  activeRoute.unmount?.();
  activeRoute.unmount = null;
  const { name, params } = parseHashRoute(location.hash);
  const adoptsFirstFrame = generation === 1 && firstFrame.frame;
  if (!adoptsFirstFrame) viewRoot.replaceChildren(renderSkeleton(name));
  if (generation > 1) scrollTo(0, 0);
  const route = { isCurrent: () => generation === activeRoute.generation, whenCurrent: (fn) => (...args) => route.isCurrent() && fn(...args) };
  readCached(apiPaths[name](params)).catch(() => {});
  try {
    const unmount = await (await ROUTES[name]())(viewRoot, params, route);
    if (!route.isCurrent()) return unmount?.();
    activeRoute.unmount = unmount || null;
  } catch (error) {
    if (!route.isCurrent()) return;
    viewRoot.replaceChildren(renderErrorState(error, renderCurrentRoute));
  }
  if (generation > 1) viewRoot.querySelector('h1')?.focus({ preventScroll: true });
  window.__shotReady = true;
}

/** Handed over by index.html in startApp (live bindings, so every view module reads index.html's own functions). */
export let formatUsd, formatTimeLeft, livePotUsd, isTakingEntries, setText;
let firstFrame = {};

export const MAKEFUN_ORIGIN = 'https://make.fun';
const FRESH_FOR_MS = 20_000;
const REVALIDATE_EVERY_MS = 60_000;
const responseCache = new Map();
const inflightRequests = new Map();

class ApiError extends Error {
  constructor(status) {
    super(status === 404 ? 'Not found on make.fun' : `make.fun answered ${status || 'no response'}`);
    this.status = status;
  }
}

function revalidateOnce(path) {
  if (!inflightRequests.has(path)) inflightRequests.set(path, readCachedWithEtag(path).finally(() => inflightRequests.delete(path)));
  return inflightRequests.get(path);
}

export const peekCached = (path) => responseCache.get(path)?.data;

export const apiPaths = {
  board: () => '/api/competitions?status=open&activity=times',
  bounty: ({ slug }) => `/api/competitions/${encodeURIComponent(slug)}?submissions=summary`,
  leaderboard: ({ slug }) => `/api/competitions/${encodeURIComponent(slug)}/leaderboard?rows=first`,
  profile: ({ handle }) => `/api/profiles/${encodeURIComponent(handle)}`,
};

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

export const formatCount = (n) => (Number(n) || 0).toLocaleString('en-US');
export const entryFeeUsd = (bounty) => Number(bounty.entryFeeUsd || 0);
export const formatEntryFee = (bounty) => (entryFeeUsd(bounty) > 0 ? formatUsd(bounty.entryFeeUsd) : 'Free');
export const paidPlaces = (bounty) => bounty.rewardsNow?.length || Object.keys(bounty.rewards || {}).length;
export const bountyHref = (slug) => `#/bounty/${encodeURIComponent(slug)}`;
export const leaderboardHref = (slug) => `#/bounty/${encodeURIComponent(slug)}/leaderboard`;
export const profileHref = (handle) => `#/u/${encodeURIComponent(handle)}`;

/** A stat: a label above a prominent value. */
export function statBlock(label, value, className = '') {
  const valueNode = el('dd', { className: 'stat-value' }, value);
  return { node: el('div', { className: `stat ${className}` }, el('dt', { className: 'stat-label' }, label), valueNode), valueNode };
}

/** 'Bounties / <crumb> / <crumb>': the way back to the board from any page. */
export function breadcrumb(...crumbs) {
  return el('nav', { className: 'breadcrumb', 'aria-label': 'Breadcrumb' }, el('a', { href: '#/' }, 'Bounties'), crumbs.flatMap((crumb) => [' / ', crumb]));
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

export const formatDateTime = (iso) => (iso ? `${new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC` : '—');
export const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' }) : '—');

export function formatTimeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
}

/** A score as its column means it: *_micro rates as a percentage, else the API's own display string. */
export function formatScore(value, display, column) {
  if (value == null && display == null) return '—';
  if (column?.source?.endsWith('_micro') && Number.isFinite(Number(value))) return `${(Number(value) / 10_000).toFixed(1)}%`;
  return display ?? String(value);
}

const BOARD_SORTS = {
  pot: ['Biggest pot', (a, b) => livePotUsd(b) - livePotUsd(a)],
  ending: ['Ending soonest', (a, b) => new Date(a.deadline) - new Date(b.deadline)],
  odds: ['Fewest entries per place', (a, b) => a.submissionCount / paidPlaces(a) - b.submissionCount / paidPlaces(b)],
  entries: ['Most entries', (a, b) => b.submissionCount - a.submissionCount],
  newest: ['Newest', (a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)],
};
const boardFilters = { sort: 'pot', category: 'all', query: '' };

function matchesSearch(bounty, query) {
  const haystack = [bounty.title, bounty.summary, bounty.category, bounty.sponsor?.name, ...(bounty.skills || [])].join(' ').toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

function buildBoardToolbar(onChange) {
  const search = el('input', { type: 'search', className: 'input', placeholder: 'Search bounties, skills…', 'aria-label': 'Search bounties', value: boardFilters.query });
  const sort = el('select', { className: 'input', 'aria-label': 'Sort bounties' }, Object.entries(BOARD_SORTS).map(([key, [label]]) => el('option', { value: key }, label)));
  sort.value = boardFilters.sort;
  search.addEventListener('input', () => onChange((boardFilters.query = search.value.trim().toLowerCase())));
  sort.addEventListener('change', () => onChange((boardFilters.sort = sort.value)));
  const chips = el('div', { className: 'category-chips', role: 'group', 'aria-label': 'Filter by category' });
  chips.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-category]');
    if (chip) onChange((boardFilters.category = chip.dataset.category));
  });
  return { toolbar: el('div', { className: 'board-toolbar' }, search, sort), chips };
}

function renderCategoryChips(container, bounties) {
  const counts = new Map();
  for (const bounty of bounties) counts.set(bounty.category, (counts.get(bounty.category) || 0) + 1);
  if (!counts.has(boardFilters.category)) boardFilters.category = 'all';
  const chip = (key, count) => el('button', { type: 'button', className: 'chip', dataset: { category: key }, 'aria-pressed': String(boardFilters.category === key) }, key === 'all' ? 'All' : key, el('span', { className: 'chip-count' }, count));
  container.replaceChildren(chip('all', bounties.length), ...[...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => chip(name, count)));
}

function mountProfileSearch(header) {
  const input = el('input', { className: 'input', name: 'handle', 'aria-label': 'Find a profile by handle', placeholder: 'Find @handle', autocomplete: 'off', spellcheck: 'false' });
  const form = el('form', { className: 'profile-search', role: 'search' }, input, el('button', { type: 'submit', className: 'button' }, 'Go'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const handle = input.value.trim().replace(/^@/, '');
    if (handle) location.hash = profileHref(handle);
  });
  header.append(form);
}

const ROUTES = {
  board: async () => mountBoardView,
  bounty: async () => (await import('./bounty-view.js')).mountBountyView,
  leaderboard: async () => (await import('./leaderboard-view.js')).mountLeaderboardView,
  profile: async () => (await import('./profile-view.js')).mountProfileView,
};
const viewRoot = document.querySelector('main');
const activeRoute = { generation: 0, unmount: null };

function parseHashRoute(hash) {
  const parts = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'bounty' && parts[1]) return { name: parts[2] === 'leaderboard' ? 'leaderboard' : 'bounty', params: { slug: parts[1] } };
  if (parts[0] === 'u' && parts[1]) return { name: 'profile', params: { handle: parts[1].replace(/^@/, '') } };
  return { name: 'board', params: {} };
}

function renderSkeleton(routeName) {
  const bar = (className) => el('div', { className: `skeleton ${className}` });
  const blocks = routeName === 'board' ? [bar(''), el('div', { className: 'grid' }, Array.from({ length: 6 }, () => bar('skeleton-block')))] : [bar(''), bar('skeleton-block'), bar('skeleton-block')];
  return el('div', { className: 'skeleton-view', 'aria-busy': 'true', 'aria-label': 'Loading' }, bar('skeleton-title'), blocks);
}

function renderErrorState(error, retry) {
  const notFound = error?.status === 404;
  return el(
    'section',
    { className: 'error-state', role: 'alert' },
    el('h1', { tabIndex: -1 }, notFound ? 'Not found' : 'Could not load this page'),
    el('p', null, notFound ? 'make.fun has nothing at this address.' : `${error?.message || 'Network error'}. Check your connection and try again.`),
    el('div', { className: 'error-actions' }, el('button', { type: 'button', className: 'button button-primary', onclick: retry }, 'Retry'), el('a', { href: '#/', className: 'button' }, 'Back to bounties')),
  );
}

function warmLaterViewsWhenIdle() {
  const warm = () => Promise.all([ROUTES.bounty(), ROUTES.leaderboard(), ROUTES.profile()]).catch(() => {});
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 2500);
}

// The palette as variables (index.html's first frame paints the light one in literals), dark mode, the board's
// controls and everything the later views share.
const APP_CSS = `
:root{--bg:#f3f4f7;--surface:#fff;--surface-2:#eceef3;--border:#d8dce4;--text:#11131a;--muted:#555c6a;--accent:#5b3df5;--on-accent:#fff;--accent-soft:#ece8ff;--money:#067a3e;--money-soft:#e2f4e9;--soon:#a35400;--urgent:#c4252c;--gold:#a87b05;--focus:#1f6feb;--radius:12px;--mono:ui-monospace,Consolas,monospace;background:var(--bg);color:var(--text)}
@media (prefers-color-scheme:dark){:root{--bg:#0d0f14;--surface:#171a21;--surface-2:#21252e;--border:#2d323d;--text:#eef0f4;--muted:#a3aab8;--accent:#9d8cff;--on-accent:#0d0f14;--accent-soft:#272046;--money:#4fd890;--money-soft:#14301f;--soon:#ffb054;--urgent:#ff7070;--gold:#f0c24c;--focus:#6ea8ff;color-scheme:dark}}
a{color:var(--accent);text-underline-offset:2px}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
h1:focus{outline:none}
body>header{flex-wrap:wrap}
.card{position:relative;background:var(--surface);border-color:var(--border)}
.title::after{content:"";position:absolute;inset:0}
.card:hover,.card:focus-within{border-color:var(--accent)}
.title:focus-visible{outline:none}
.title:focus-visible::after{outline:3px solid var(--focus);border-radius:12px}
.grid{grid-template-columns:repeat(auto-fill,minmax(min(340px,100%),1fr))}
small,.totals,.meta{color:var(--muted)}
.cat{color:var(--accent)}
.money .pot{color:var(--money)}
.meta{border-color:var(--border)}
[data-urgency=soon]{color:var(--soon)}
[data-urgency=urgent]{color:var(--urgent)}
.muted{color:var(--muted)}
.small{font-size:.85rem}
.visually-hidden{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.input,.button,.chip{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border)}
.input{min-height:38px;padding:6px 10px;border-radius:8px;font-size:.95rem}
.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:6px 14px;border-radius:8px;font-size:.95rem;font-weight:600;text-decoration:none;cursor:pointer}
.button:hover{border-color:var(--accent)}
.button:disabled{opacity:.45;cursor:default}
.button-primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.profile-search{margin-left:auto;display:flex;gap:6px}
.profile-search .input{width:11rem;background:#fff2;border-color:#fff4;color:#fff}
.profile-search .input::placeholder{color:#fffa}
.profile-search .button{background:#fff;color:#14121f;border-color:#fff}
.board-toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.board-toolbar [type=search]{flex:1 1 240px}
.category-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-size:.88rem;font-weight:600;cursor:pointer}
.chip[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.chip-count{opacity:.75}
.board-result-count{margin:0 0 8px;color:var(--muted)}
.board-result-count:empty{display:none}
.empty-state{padding:32px 16px;border:1px dashed var(--border);border-radius:var(--radius);background:var(--surface);color:var(--muted);text-align:center}
.error-state{max-width:560px;margin:40px auto;padding:32px 24px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);text-align:center}
.error-actions{display:flex;justify-content:center;gap:8px;margin-top:16px}
.skeleton-view{display:grid;gap:14px}
.skeleton{min-height:38px;border-radius:var(--radius);background:linear-gradient(90deg,var(--surface-2) 25%,var(--surface) 50%,var(--surface-2) 75%) 0 0/200% 100%;animation:shimmer 1.3s linear infinite}
.skeleton-title{width:min(420px,70%)}
.skeleton-block{height:180px}
@keyframes shimmer{to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.skeleton{animation:none}}
.breadcrumb{margin-bottom:10px;color:var(--muted);font-size:.9rem;overflow-wrap:anywhere}
.view-heading{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 16px;margin-bottom:12px}
.stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 16px}
.stat,.panel{min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
.stat{padding:10px 14px}
.stat-label{color:var(--muted);font-size:.75rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.stat-value{margin:2px 0 0;font-size:1.6rem;font-weight:800;font-variant-numeric:tabular-nums}
.stat-pot .stat-value{color:var(--money);font-size:2rem}
.stat-note{display:block;color:var(--muted);font-size:.8rem;font-weight:500}
.panel{padding:16px 18px;line-height:1.5}
.panel h2{font-size:1.1rem;margin:0 0 8px}
.table-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
th[scope=col]{background:var(--surface-2);color:var(--muted);font-size:.75rem;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
.chip-static{cursor:default;font-weight:500;background:var(--surface-2);border-color:transparent}
.avatar{--avatar-size:32px;flex:none;width:var(--avatar-size);height:var(--avatar-size);border-radius:50%;object-fit:cover;background:var(--surface-2)}
.avatar-initials{display:inline-grid;place-items:center;color:var(--accent);background:var(--accent-soft);font-size:calc(var(--avatar-size)*.4);font-weight:700}
@media (max-width:640px){.stat-row>:last-child:nth-child(odd){grid-column:1/-1}.profile-search{flex:1 1 100%}.profile-search .input{flex:1;width:auto}.stat-row{grid-template-columns:repeat(2,minmax(0,1fr))}.stat-value{font-size:1.3rem}.panel{padding:14px}}
`;
