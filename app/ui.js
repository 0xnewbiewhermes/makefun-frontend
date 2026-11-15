// Shared DOM and formatting helpers. Every API string reaches the page as a text node (textContent), never as HTML.

/** Build an element: el('a', { href, className, onclick }, child, 'text', ...). */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'className') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key in node && typeof value !== 'string') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else node.append(child instanceof Node ? child : String(child));
  }
}

/** Set a node's text only when it differs, so an unchanged refresh touches nothing. */
export function setText(node, text) {
  const value = String(text ?? '');
  if (node.textContent !== value) node.textContent = value;
}

const usdWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdCents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const integerFormat = new Intl.NumberFormat('en-US');

/** '1000' -> '$1,000', '565.5' -> '$565.50'. */
export function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return (Number.isInteger(amount) ? usdWhole : usdCents).format(amount);
}

export const formatCount = (n) => integerFormat.format(Number(n) || 0);
export const pluralize = (n, one, many = `${one}s`) => `${formatCount(n)} ${Number(n) === 1 ? one : many}`;

/** An ISO time as 'Nov 17, 2026, 12:30 UTC'. */
export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return `${date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
}

/** An ISO time as a date alone: 'Nov 15, 2026'. */
export const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' }) : '—');

/** How long ago an ISO time was: '5m ago', '3h ago', '2d ago'. */
export function formatTimeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Time until a deadline: '2d 4h 10m', '3h 05m 09s', 'Closed'. */
export function formatTimeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!(ms > 0)) return 'Closed';
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  if (days > 0) return `${days}d ${hours}h ${pad(minutes)}m`;
  return `${hours}h ${pad(minutes)}m ${pad(s % 60)}s`;
}

/** Urgency class for a deadline: under 1 hour, under 24 hours, or none. */
export function deadlineUrgency(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'is-closed';
  if (ms < 3_600_000) return 'is-urgent';
  if (ms < 86_400_000) return 'is-soon';
  return '';
}

/** A bounty takes entries while its deadline is ahead; a past deadline may still read status "open". */
export function isTakingEntries(bounty) {
  return bounty.status !== 'resolved' && bounty.status !== 'closed' && new Date(bounty.deadline).getTime() > Date.now();
}

/** The live pot: the reward plus entry fees paid so far. */
export const livePotUsd = (bounty) => Number(bounty.potUsd ?? bounty.rewardAmount ?? 0);
export const entryFeeUsd = (bounty) => Number(bounty.entryFeeUsd || 0);

/** A score as the API's column means it: *_micro rates as a percentage, else the API's own display string. */
export function formatScore(value, display, column) {
  if (value == null && display == null) return '—';
  if (column?.source?.endsWith('_micro') && Number.isFinite(Number(value))) return `${(Number(value) / 10_000).toFixed(1)}%`;
  return display ?? String(value);
}

// One ticker for every countdown on screen: a single 1 s interval, cleared on route change.
const liveCountdowns = new Map();
let countdownTimer = 0;

function tickCountdowns() {
  for (const [node, deadline] of liveCountdowns) {
    if (!node.isConnected) continue;
    setText(node, formatTimeLeft(deadline));
    const urgency = deadlineUrgency(deadline);
    if (node.dataset.urgency !== urgency) {
      node.dataset.urgency = urgency;
      node.closest('[data-deadline-scope]')?.setAttribute('data-urgency', urgency);
    }
  }
}

/** Keep a node's text the live time left to a deadline. */
export function trackCountdown(node, deadline) {
  liveCountdowns.set(node, deadline);
  setText(node, formatTimeLeft(deadline));
  node.dataset.urgency = deadlineUrgency(deadline);
  if (!countdownTimer) countdownTimer = setInterval(tickCountdowns, 1000);
}

export function stopAllCountdowns() {
  liveCountdowns.clear();
  clearInterval(countdownTimer);
  countdownTimer = 0;
}

/** A stat block: label above a prominent value. */
export function statBlock(label, value, className = '') {
  const valueNode = el('dd', { className: 'stat-value' }, value);
  return { node: el('div', { className: `stat ${className}` }, el('dt', { className: 'stat-label' }, label), valueNode), valueNode };
}

/** Placeholder blocks shaped like the view that is loading. */
export function renderSkeleton(routeName) {
  const bar = (className) => el('div', { className: `skeleton ${className}` });
  const wrap = el('div', { className: 'skeleton-view', 'aria-busy': 'true', 'aria-label': 'Loading' });
  if (routeName === 'board') {
    wrap.append(bar('skeleton-title'), bar('skeleton-toolbar'), el('div', { className: 'bounty-grid' }, Array.from({ length: 6 }, () => bar('skeleton-card'))));
  } else if (routeName === 'leaderboard') {
    wrap.append(bar('skeleton-title'), ...Array.from({ length: 10 }, () => bar('skeleton-row')));
  } else {
    wrap.append(bar('skeleton-title'), bar('skeleton-stats'), bar('skeleton-block'), bar('skeleton-block'));
  }
  return wrap;
}

/** An error panel with a Retry button. */
export function renderErrorState(error, retry) {
  const notFound = error?.status === 404;
  return el(
    'section',
    { className: 'error-state', role: 'alert' },
    el('h1', { tabIndex: -1 }, notFound ? 'Not found' : 'Could not load this page'),
    el('p', null, notFound ? 'make.fun has nothing at this address.' : `${error?.message || 'Network error'}. Check your connection and try again.`),
    el('div', { className: 'error-actions' }, el('button', { type: 'button', className: 'button button-primary', onclick: retry }, 'Retry'), el('a', { href: '#/', className: 'button' }, 'Back to bounties')),
  );
}

/** A profile picture: crossorigin set before src (make.fun sends CORP same-origin), initials when there is none. */
export function avatarImage(url, handle, size = 32) {
  if (!url) return el('span', { className: 'avatar avatar-initials', style: `--avatar-size:${size}px`, 'aria-hidden': 'true' }, (handle || '?').slice(0, 2).toUpperCase());
  const image = document.createElement('img');
  image.crossOrigin = 'anonymous';
  image.className = 'avatar';
  image.width = size;
  image.height = size;
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.src = url;
  return image;
}

export const profileHref = (handle) => `#/u/${encodeURIComponent(handle)}`;
export const bountyHref = (slug) => `#/bounty/${encodeURIComponent(slug)}`;
export const leaderboardHref = (slug) => `#/bounty/${encodeURIComponent(slug)}/leaderboard`;
