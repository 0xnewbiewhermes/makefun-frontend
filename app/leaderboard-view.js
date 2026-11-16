// A bounty's leaderboard (#/bounty/<slug>/leaderboard), one read with ?rows=first: the top rows whole, every other row
// as the light record a ranked list needs. Every row is reachable by scrolling, but only the rows in view (plus
// OVERSCAN_ROWS each side) exist: a pool of fixed-height ROW_HEIGHT rows is moved over one spacer and rewritten in
// place, so scrolling, filtering or a revalidation never rebuilds the list.

import { absoluteAssetUrl, adoptViewStyles, apiPaths, avatarImage, bountyHref, breadcrumb, el, formatCount, formatScore, formatTimeAgo, profileHref, readCached, revalidateWhileVisible, setText } from './app.js';

/** Render only the rows that intersect the viewport (window scroll), reusing pooled row elements. */
function virtualiseLeaderboardRows(view) {
  const { state } = view;
  const rows = state.visibleRows;
  view.spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
  const top = view.spacer.getBoundingClientRect().top;
  const first = Math.max(0, Math.floor(-top / ROW_HEIGHT) - OVERSCAN_ROWS);
  const last = Math.min(rows.length, Math.ceil((innerHeight - top) / ROW_HEIGHT) + OVERSCAN_ROWS);
  while (view.rowPool.length < last - first) view.rowPool.push(createPooledRow(view.spacer));
  const inView = new Set();
  for (let index = first; index < last; index++) {
    const pooled = view.rowPool[index % view.rowPool.length];
    inView.add(pooled);
    pooled.row.hidden = false;
    if (pooled.index === index && pooled.generation === state.generation) continue;
    Object.assign(pooled, { index, generation: state.generation });
    pooled.row.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
    pooled.row.setAttribute('aria-rowindex', String(index + 2));
    fillPooledRow(pooled, rows[index], state.rankColumn);
  }
  for (const pooled of view.rowPool) if (!inView.has(pooled)) pooled.row.hidden = true;
  setText(view.domCount, `Virtual list · ${inView.size} of ${formatCount(rows.length)} rows in the DOM`);
  view.list.setAttribute('aria-rowcount', String(rows.length + 1));
  view.emptyState.hidden = rows.length > 0;
  setText(view.emptyState, state.query ? 'No entry matches that filter.' : 'No ranked entries yet: scores show here once entries are judged.');
}

async function mountLeaderboardView(root, { slug }, route) {
  const view = buildLeaderboardLayout(slug);
  const scheduleVirtualise = oncePerFrame(virtualiseLeaderboardRows.bind(null, view));
  view.search.addEventListener('input', () => filterRowsOnEachKeystroke(view));
  const onChange = route.whenCurrent((fresh) => applyLeaderboardData(view, slug, fresh));
  const board = await readCached(apiPaths.leaderboard({ slug }), onChange);
  if (!route.isCurrent()) return;
  root.replaceChildren(view.page);
  applyLeaderboardData(view, slug, board);
  addEventListener('scroll', scheduleVirtualise, { passive: true });
  addEventListener('resize', scheduleVirtualise);
  const stopRevalidating = revalidateWhileVisible(apiPaths.leaderboard({ slug }), onChange);
  return () => {
    stopRevalidating();
    removeEventListener('scroll', scheduleVirtualise);
    removeEventListener('resize', scheduleVirtualise);
  };
}

/** Type-to-filter: narrows the rows already in memory on every keystroke; no request, the pooled rows are rewritten. */
function filterRowsOnEachKeystroke(view) {
  const { state } = view;
  state.query = view.search.value.trim().toLowerCase();
  state.visibleRows = state.query ? state.rows.filter((row) => `${row.handle} ${row.title}`.toLowerCase().includes(state.query)) : state.rows;
  state.generation++;
  virtualiseLeaderboardRows(view);
}

function applyLeaderboardData(view, slug, board) {
  Object.assign(view.state, normalizeLeaderboardRows(board));
  const { rows, rankColumn } = view.state;
  const title = board.competition?.title || slug;
  document.title = `Leaderboard · ${title} · make.fun`;
  setText(view.boardTitle, title);
  setText(view.scoreHeader, rankColumn?.title || 'Score');
  const phase = board.phase;
  setText(view.summary, [`${formatCount(rows.length)} ranked ${rows.length === 1 ? 'entry' : 'entries'}`, phase?.title && `${phase.title} phase`, phase?.placements_held && 'places unofficial until results publish'].filter(Boolean).join(' · '));
  filterRowsOnEachKeystroke(view);
}

/** Coalesce scroll and resize events into one call per animation frame. */
function oncePerFrame(callback) {
  let requested = false;
  return () => {
    if (requested) return;
    requested = true;
    requestAnimationFrame(() => {
      requested = false;
      callback();
    });
  };
}

function fillPooledRow({ row, cells }, entry, rankColumn) {
  row.className = `lb-row${entry.rank <= 3 ? ' podium' : ''}`;
  setText(cells.rank, entry.rank ?? '—');
  setText(cells.handle, entry.handle ? `@${entry.handle}` : 'anonymous');
  if (entry.handle) cells.handle.href = profileHref(entry.handle);
  else cells.handle.removeAttribute('href');
  const avatarUrl = absoluteAssetUrl(entry.image) || '';
  if (cells.avatarSlot.dataset.src !== avatarUrl || !cells.avatarSlot.firstChild) {
    cells.avatarSlot.dataset.src = avatarUrl;
    cells.avatarSlot.replaceChildren(avatarImage(avatarUrl, entry.handle, 36));
  }
  cells.house.hidden = !entry.house;
  setText(cells.title, entry.title || '');
  cells.title.title = entry.title || '';
  setText(cells.score, formatScore(entry.value, entry.display, rankColumn));
  const { low, high } = entry.interval || {};
  setText(cells.interval, entry.interval ? `${formatScore(low, low, rankColumn)} – ${formatScore(high, high, rankColumn)}` : '');
  setText(cells.received, entry.receivedAt ? formatTimeAgo(entry.receivedAt) : '');
}

/** Both row shapes the API sends (whole and light) as one list sorted by rank. */
export function normalizeLeaderboardRows(board) {
  const rankColumn = board.columns?.find((column) => column.key === board.rank_key) || null;
  const row = (entry, value, display, image) => ({ rank: entry.rank, handle: entry.handle, title: entry.title, image, value, display, interval: entry.interval, receivedAt: entry.received_at, house: entry.house || entry.baseline });
  const rows = [
    ...(board.entries || []).map((entry) => row(entry, entry.values?.[board.rank_key], entry.display?.[board.rank_key], entry.image)),
    ...(board.rest || []).map((entry) => row(entry, entry.value, entry.display, null)),
  ];
  return { rankColumn, rows: rows.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity)) };
}

function createPooledRow(spacer) {
  const cell = (className, ...children) => el('span', { role: 'cell', className }, ...children);
  const cells = { rank: cell('col-rank'), avatarSlot: el('span', { className: 'avatar-slot' }), handle: el('a', { className: 'entrant-handle' }), house: el('span', { className: 'house-badge', hidden: true }, 'house'), title: el('span', { className: 'entrant-title' }), score: cell('col-score'), interval: cell('col-interval'), received: cell('col-received') };
  const entrant = cell('col-entrant', cells.avatarSlot, el('span', { className: 'entrant-text' }, el('span', { className: 'entrant-line' }, cells.handle, cells.house), cells.title));
  const row = el('div', { role: 'row', className: 'lb-row' }, cells.rank, entrant, cells.score, cells.interval, cells.received);
  spacer.append(row);
  return { row, cells, index: -1, generation: -1 };
}

function buildLeaderboardLayout(slug) {
  const view = {
    state: { query: '', rows: [], visibleRows: [], rankColumn: null, generation: 0 },
    rowPool: [],
    boardTitle: el('a', { href: bountyHref(slug) }, slug),
    summary: el('p', { className: 'leaderboard-summary' }),
    scoreHeader: el('span', { role: 'columnheader', className: 'col-score' }, 'Score'),
    search: el('input', { type: 'search', className: 'input', placeholder: 'Filter by handle or entry', 'aria-label': 'Filter entries' }),
    spacer: el('div', { className: 'lb-spacer', role: 'rowgroup' }),
    emptyState: el('p', { className: 'empty-state', hidden: true }),
    domCount: el('span', { className: 'dom-count' }),
  };
  const header = (label, className) => el('span', { role: 'columnheader', className }, label);
  view.list = el('div', { role: 'table', className: 'lb-table', 'aria-label': 'Leaderboard' }, el('div', { role: 'row', className: 'lb-row lb-head', 'aria-rowindex': '1' }, header('#', 'col-rank'), header('Entrant · entry', 'col-entrant'), view.scoreHeader, header('90% interval', 'col-interval'), header('Entered', 'col-received')), view.spacer);
  view.page = el(
    'section',
    null,
    breadcrumb(view.boardTitle, el('span', null, 'Leaderboard')),
    el('div', { className: 'view-heading' }, el('h1', { tabIndex: -1 }, 'Leaderboard'), view.summary),
    el('div', { className: 'board-toolbar' }, view.search, view.domCount, el('a', { className: 'button', href: bountyHref(slug) }, 'Bounty details')),
    view.list,
    view.emptyState,
  );
  return view;
}

const ROW_HEIGHT = 60;
const OVERSCAN_ROWS = 6;

adoptViewStyles(`
.leaderboard-summary{margin:0;color:var(--muted);font-size:1.05rem}
.dom-count{padding:6px 12px;border-radius:999px;background:var(--money-soft);color:var(--money);font-size:.9rem;font-weight:700;white-space:nowrap}
.lb-table{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;font-variant-numeric:tabular-nums}
.lb-row{display:grid;grid-template-columns:3.5rem minmax(0,1fr) 8rem 10rem 6rem;align-items:center;gap:12px;height:${ROW_HEIGHT}px;padding:0 14px;border-bottom:1px solid var(--border);box-sizing:border-box}
.lb-spacer{position:relative;contain:strict;width:100%}
.lb-spacer .lb-row{position:absolute;top:0;left:0;right:0}
.lb-spacer .lb-row:hover{background:var(--surface-2)}
.lb-head{height:36px;background:var(--surface-2);color:var(--muted);font-size:.75rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.col-rank{text-align:right;font-weight:800;font-size:1.3rem}
.podium .col-rank{color:var(--gold);font-size:1.5rem}
.col-entrant{display:flex;align-items:center;gap:10px;min-width:0}
.avatar-slot{display:inline-flex}
.entrant-text{display:grid;min-width:0}
.entrant-line,.entrant-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.entrant-handle{font-weight:700;font-size:1.08rem}
.entrant-title{color:var(--muted);font-size:.92rem}
.house-badge{margin-left:6px;padding:1px 6px;border-radius:6px;background:var(--surface-2);color:var(--muted);font-size:.7rem;font-weight:700;text-transform:uppercase}
.col-score{font-weight:800;font-size:1.2rem;white-space:nowrap;text-align:right}
.col-interval,.col-received{color:var(--muted);font-size:.92rem;white-space:nowrap}
.lb-head .col-score{white-space:normal;line-height:1.1}
.lb-head>*{font-size:.75rem;color:var(--muted)}
@media (max-width:760px){.lb-row{grid-template-columns:2.2rem minmax(0,1fr) 4.6rem;gap:8px;padding:0 10px}.col-interval,.col-received{display:none}.col-score{font-size:1.05rem}.col-rank{font-size:1.1rem}}
`);

export { mountLeaderboardView };
