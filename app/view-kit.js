// What the bounty page, leaderboard and profile share and the board never needs: their common CSS (adopted on first
// import), stat blocks, breadcrumbs, avatars, dates and score formatting.

import { adoptViewStyles, el, MAKEFUN_ORIGIN } from './app.js';

adoptViewStyles(`
.breadcrumb{margin-bottom:12px;color:var(--muted);font-size:.9rem;overflow-wrap:anywhere}
.stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 16px}
.stat,.panel{min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
.stat{padding:12px 14px}
.stat-label{color:var(--muted);font-size:.78rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.stat-value{margin:2px 0 0;font-size:1.6rem;font-weight:850;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.stat-pot .stat-value{color:var(--money)}
.stat-note{display:block;color:var(--muted);font-size:.8rem;font-weight:500}
.panel{padding:16px 18px}
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
th[scope=col]{background:var(--surface-2);color:var(--muted);font-size:.75rem;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
.chip-static{cursor:default;font-weight:500;background:var(--surface-2);border-color:transparent}
.avatar{--avatar-size:32px;flex:none;width:var(--avatar-size);height:var(--avatar-size);border-radius:50%;object-fit:cover;background:var(--surface-2)}
.avatar-initials{display:inline-grid;place-items:center;color:var(--accent);background:var(--accent-soft);font-size:calc(var(--avatar-size)*.4);font-weight:700}
@media (max-width:640px){.stat-row{grid-template-columns:repeat(2,minmax(0,1fr))}.stat-value{font-size:1.3rem}.panel{padding:14px}}
`);

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

/** 'Nov 17, 2026, 12:30 PM UTC' */
export const formatDateTime = (iso) => (iso ? `${new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC` : '—');
export const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' }) : '—');

/** '5m ago', '3h ago', '2d ago' */
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
