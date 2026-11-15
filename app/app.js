// First load: make.fun API behind an ETag cache, the board (#/), the router; other views are import()ed on demand.

export const MAKEFUN_ORIGIN = 'https://make.fun';
const FRESH_FOR_MS = 20_000;
const REVALIDATE_EVERY_MS = 60_000;

const responseCache = new Map();
const inflightRequests = new Map();

export class ApiError extends Error {
  constructor(status) {
    super(status === 404 ? 'Not found on make.fun' : `make.fun answered ${status || 'no response'}`);
    this.status = status;
  }
}

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

function revalidateOnce(path) {
  if (!inflightRequests.has(path)) inflightRequests.set(path, readCachedWithEtag(path).finally(() => inflightRequests.delete(path)));
  return inflightRequests.get(path);
}

export function readCached(path, onChange) {
  const cached = responseCache.get(path);
  if (!cached) return revalidateOnce(path).then((result) => result.data);
  if (Date.now() - cached.fetchedAt > FRESH_FOR_MS) revalidateOnce(path).then((r) => r.changed && onChange?.(r.data), () => {});
  return Promise.resolve(cached.data);
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

export const peekCached = (path) => responseCache.get(path)?.data;

export const apiPaths = {
  board: () => '/api/competitions?status=open&activity=times',
  bounty: ({ slug }) => `/api/competitions/${encodeURIComponent(slug)}?submissions=summary`,
  leaderboard: ({ slug }) => `/api/competitions/${encodeURIComponent(slug)}/leaderboard?rows=first`,
  profile: ({ handle }) => `/api/profiles/${encodeURIComponent(handle)}`,
};

function prefetchBounty(slug) {
  const path = apiPaths.bounty({ slug });
  if (!responseCache.has(path)) revalidateOnce(path).catch(() => {});
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

export function setText(node, text) {
  const value = String(text ?? '');
  if (node.textContent !== value) node.textContent = value;
}

export function adoptViewStyles(cssText) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(cssText);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

const usd = (digits) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
const usdWhole = usd(0);
const usdCents = usd(2);

export function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return (Number.isInteger(amount) ? usdWhole : usdCents).format(amount);
}

export const formatCount = (n) => (Number(n) || 0).toLocaleString('en-US');
const pluralize = (n, one, many) => `${formatCount(n)} ${Number(n) === 1 ? one : many}`;
export const livePotUsd = (bounty) => Number(bounty.potUsd ?? bounty.rewardAmount ?? 0);
export const entryFeeUsd = (bounty) => Number(bounty.entryFeeUsd || 0);
export const formatEntryFee = (bounty) => (entryFeeUsd(bounty) > 0 ? formatUsd(bounty.entryFeeUsd) : 'Free');

export function isTakingEntries(bounty) {
  return bounty.status !== 'resolved' && bounty.status !== 'closed' && new Date(bounty.deadline) > Date.now();
}

export function formatTimeLeft(deadline) {
  const s = Math.floor((new Date(deadline) - Date.now()) / 1000);
  if (!(s > 0)) return 'Closed';
  const pad = (n) => String(n).padStart(2, '0');
  const [days, hours, minutes] = [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60)];
  return days > 0 ? `${days}d ${hours}h ${pad(minutes)}m` : `${hours}h ${pad(minutes)}m ${pad(s % 60)}s`;
}

function deadlineUrgency(deadline) {
  const ms = new Date(deadline) - Date.now();
  return ms <= 0 ? 'is-closed' : ms < 3_600_000 ? 'is-urgent' : ms < 86_400_000 ? 'is-soon' : '';
}

const liveCountdowns = new Map();
let countdownTimer = 0;

function tickCountdownsInPlace() {
  for (const [node, deadline] of liveCountdowns) {
    if (!node.isConnected) continue;
    setText(node, formatTimeLeft(deadline));
    const urgency = deadlineUrgency(deadline);
    if (node.dataset.urgency !== urgency) node.dataset.urgency = urgency;
  }
}

export function trackCountdown(node, deadline) {
  liveCountdowns.set(node, deadline);
  setText(node, formatTimeLeft(deadline));
  node.dataset.urgency = deadlineUrgency(deadline);
  countdownTimer ||= setInterval(tickCountdownsInPlace, 1000);
}

function stopAllCountdowns() {
  liveCountdowns.clear();
  clearInterval(countdownTimer);
  countdownTimer = 0;
}

export const bountyHref = (slug) => `#/bounty/${encodeURIComponent(slug)}`;
export const leaderboardHref = (slug) => `#/bounty/${encodeURIComponent(slug)}/leaderboard`;
export const profileHref = (handle) => `#/u/${encodeURIComponent(handle)}`;

const BOARD_SORTS = {
  ending: ['Ending soonest', (a, b) => new Date(a.deadline) - new Date(b.deadline)],
  pot: ['Biggest pot', (a, b) => livePotUsd(b) - livePotUsd(a)],
  entries: ['Most entries', (a, b) => b.submissionCount - a.submissionCount],
  newest: ['Newest', (a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)],
};
const boardFilters = { sort: 'ending', category: 'all', query: '' };
const bountyCards = new Map();

function createBountyCard(slug) {
  const span = (className) => el('span', { className });
  const refs = { category: span('card-category'), sponsor: span('card-sponsor'), summary: el('p', { className: 'card-summary' }), pot: span('card-pot-amount'), potNote: span('card-pot-note'), timeLeft: span('card-time-left'), fee: el('strong'), entries: el('strong') };
  refs.title = el('a', { className: 'card-title-link', href: bountyHref(slug), onpointerenter: () => prefetchBounty(slug), onfocus: () => prefetchBounty(slug) });
  refs.feeLabel = el('span', { className: 'card-fee' }, 'Entry fee ', refs.fee);
  const card = el(
    'li',
    { className: 'bounty-card' },
    el('div', { className: 'card-top' }, refs.category, refs.sponsor),
    el('h2', { className: 'card-title' }, refs.title),
    refs.summary,
    el('div', { className: 'card-money' }, el('div', null, el('span', { className: 'card-label' }, 'Live pot'), refs.pot), el('div', { className: 'card-clock' }, el('span', { className: 'card-label' }, 'Time left'), refs.timeLeft)),
    el('div', { className: 'card-meta' }, refs.feeLabel, el('span', null, refs.entries, ' entries'), refs.potNote),
  );
  return { card, refs };
}

function fillBountyCard({ refs }, bounty) {
  const fees = livePotUsd(bounty) - Number(bounty.rewardAmount || 0);
  setText(refs.category, bounty.category || 'Bounty');
  setText(refs.sponsor, bounty.sponsor?.name ? `by ${bounty.sponsor.name}` : '');
  setText(refs.title, bounty.title);
  setText(refs.summary, bounty.summary || '');
  setText(refs.pot, formatUsd(livePotUsd(bounty)));
  setText(refs.potNote, fees > 0.004 ? `+${formatUsd(fees.toFixed(2))} fees in pot` : '');
  setText(refs.fee, formatEntryFee(bounty));
  refs.feeLabel.toggleAttribute('data-paid', entryFeeUsd(bounty) > 0);
  setText(refs.entries, formatCount(bounty.submissionCount));
  trackCountdown(refs.timeLeft, bounty.deadline);
}

function matchesSearch(bounty, query) {
  const haystack = [bounty.title, bounty.summary, bounty.category, bounty.sponsor?.name, ...(bounty.skills || [])].join(' ').toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

function patchBoardCardsInPlace(list, cards) {
  cards.forEach((card, index) => list.children[index] !== card && list.insertBefore(card, list.children[index] || null));
  while (list.children.length > cards.length) list.lastElementChild.remove();
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
  for (const bounty of bounties) counts.set(bounty.category || 'Other', (counts.get(bounty.category || 'Other') || 0) + 1);
  if (!counts.has(boardFilters.category)) boardFilters.category = 'all';
  const chip = (key, count) => el('button', { type: 'button', className: 'chip', dataset: { category: key }, 'aria-pressed': String(boardFilters.category === key) }, key === 'all' ? 'All' : key, el('span', { className: 'chip-count' }, count));
  container.replaceChildren(chip('all', bounties.length), ...[...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => chip(name, count)));
}

async function mountBoardView(container, _params, route) {
  document.title = 'Live bounties · make.fun';
  let liveBounties = [];
  const totals = { live: el('strong'), pots: el('strong'), entries: el('strong') };
  const list = el('ul', { className: 'bounty-grid' });
  const resultCount = el('p', { className: 'board-result-count', 'aria-live': 'polite' });
  const emptyState = el('p', { className: 'empty-state', hidden: true }, 'No live bounty matches. Clear the search or pick another category.');
  const { toolbar, chips } = buildBoardToolbar(applyBoardFilters);

  function applyBoardFilters() {
    renderCategoryChips(chips, liveBounties);
    const visible = liveBounties
      .filter((bounty) => boardFilters.category === 'all' || (bounty.category || 'Other') === boardFilters.category)
      .filter((bounty) => !boardFilters.query || matchesSearch(bounty, boardFilters.query))
      .sort(BOARD_SORTS[boardFilters.sort][1]);
    patchBoardCardsInPlace(list, visible.map((bounty) => bountyCards.get(bounty.slug).card));
    emptyState.hidden = visible.length > 0;
    setText(resultCount, visible.length === liveBounties.length ? '' : `Showing ${visible.length} of ${liveBounties.length}`);
  }

  function applyBoardData(data) {
    liveBounties = (data.items || []).filter(isTakingEntries);
    for (const bounty of liveBounties) {
      if (!bountyCards.has(bounty.slug)) bountyCards.set(bounty.slug, createBountyCard(bounty.slug));
      fillBountyCard(bountyCards.get(bounty.slug), bounty);
    }
    setText(totals.live, pluralize(liveBounties.length, 'bounty', 'bounties'));
    setText(totals.pots, formatUsd(Math.round(liveBounties.reduce((sum, b) => sum + livePotUsd(b), 0))));
    setText(totals.entries, formatCount(liveBounties.reduce((sum, b) => sum + (b.submissionCount || 0), 0)));
    applyBoardFilters();
  }

  const onChange = (fresh) => route.isCurrent() && applyBoardData(fresh);
  const data = await readCached(apiPaths.board(), onChange);
  if (!route.isCurrent()) return;
  const summary = el('p', { className: 'board-totals' }, totals.live, ' taking entries · ', totals.pots, ' in live pots · ', totals.entries, ' entries');
  container.replaceChildren(el('section', null, el('div', { className: 'view-heading' }, el('h1', { tabIndex: -1 }, 'Live bounties'), summary), toolbar, chips, resultCount, list, emptyState));
  applyBoardData(data);
  return revalidateWhileVisible(apiPaths.board(), onChange);
}

const ROUTES = {
  board: async () => mountBoardView,
  bounty: async () => (await import('./bounty-view.js')).mountBountyView,
  leaderboard: async () => (await import('./leaderboard-view.js')).mountLeaderboardView,
  profile: async () => (await import('./profile-view.js')).mountProfileView,
};

const viewRoot = document.getElementById('view');
let routeGeneration = 0;
let unmountActiveView = null;

export function parseHashRoute(hash) {
  const parts = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'bounty' && parts[1]) return { name: parts[2] === 'leaderboard' ? 'leaderboard' : 'bounty', params: { slug: parts[1] } };
  if (parts[0] === 'u' && parts[1]) return { name: 'profile', params: { handle: parts[1].replace(/^@/, '') } };
  return { name: 'board', params: {} };
}

function renderSkeleton(routeName) {
  const bar = (className) => el('div', { className: `skeleton ${className}` });
  const blocks = routeName === 'board' ? [bar(''), el('div', { className: 'bounty-grid' }, Array.from({ length: 6 }, () => bar('skeleton-card')))] : [bar(''), bar('skeleton-block'), bar('skeleton-block')];
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

async function renderCurrentRoute() {
  const generation = ++routeGeneration;
  const isFirstRender = generation === 1;
  window.__shotReady = false;
  unmountActiveView?.();
  unmountActiveView = null;
  stopAllCountdowns();
  const { name, params } = parseHashRoute(location.hash);
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  viewRoot.replaceChildren(renderSkeleton(name));
  if (!isFirstRender) scrollTo(0, 0);
  const route = { isCurrent: () => generation === routeGeneration };
  readCached(apiPaths[name](params)).catch(() => {});
  try {
    const unmount = await (await ROUTES[name]())(viewRoot, params, route);
    if (!route.isCurrent()) return unmount?.();
    unmountActiveView = unmount || null;
  } catch (error) {
    if (!route.isCurrent()) return;
    viewRoot.replaceChildren(renderErrorState(error, renderCurrentRoute));
  }
  if (!isFirstRender) viewRoot.querySelector('h1')?.focus({ preventScroll: true });
  window.__shotReady = true;
}

function warmLaterViewsWhenIdle() {
  const warm = () => Promise.all([ROUTES.bounty(), ROUTES.leaderboard(), ROUTES.profile()]).catch(() => {});
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 2500);
}

document.getElementById('profile-search').addEventListener('submit', (event) => {
  event.preventDefault();
  const handle = new FormData(event.target).get('handle').trim().replace(/^@/, '');
  if (handle) location.hash = profileHref(handle);
});
addEventListener('hashchange', renderCurrentRoute);
renderCurrentRoute().then(warmLaterViewsWhenIdle);
