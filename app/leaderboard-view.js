// A bounty's leaderboard (#/bounty/<slug>/leaderboard), one read with ?rows=first: the top rows whole, every other row
// as the light record a ranked list needs. Rows are paged LEADERBOARD_PAGE_SIZE at a time through one fixed pool of
// <tr> elements whose cells are rewritten in place, so paging, filtering or a revalidation never rebuilds the table.

import { adoptViewStyles, apiPaths, bountyHref, el, formatCount, profileHref, readCached, revalidateWhileVisible, setText } from './app.js';
import { absoluteAssetUrl, avatarImage, breadcrumb, formatScore, formatTimeAgo } from './view-kit.js';

const LEADERBOARD_PAGE_SIZE = 50;

/** Show one page of the (filtered) rows by rewriting the pooled <tr>s; the rest of the pool hides. */
function paginateLeaderboardRows(view, page) {
  const { state, rowPool } = view;
  const rows = state.query ? state.rows.filter((row) => `${row.handle} ${row.title}`.toLowerCase().includes(state.query)) : state.rows;
  const pageCount = Math.max(1, Math.ceil(rows.length / LEADERBOARD_PAGE_SIZE));
  state.page = Math.min(Math.max(0, page), pageCount - 1);
  const pageRows = rows.slice(state.page * LEADERBOARD_PAGE_SIZE, (state.page + 1) * LEADERBOARD_PAGE_SIZE);
  rowPool.forEach((pooled, index) => (pageRows[index] ? fillPooledRow(pooled, pageRows[index], state.rankColumn) : (pooled.row.hidden = true)));
  view.table.hidden = !pageRows.length;
  view.pager.hidden = pageCount <= 1;
  view.previousButton.disabled = state.page === 0;
  view.nextButton.disabled = state.page >= pageCount - 1;
  setText(view.pageLabel, `Page ${state.page + 1} of ${formatCount(pageCount)}`);
  view.emptyState.hidden = pageRows.length > 0;
  setText(view.emptyState, state.query ? 'No entry matches that filter.' : 'No ranked entries yet: scores show here once entries are judged.');
}

function fillPooledRow({ row, cells }, entry, rankColumn) {
  row.hidden = false;
  row.className = entry.rank <= 3 ? 'podium' : '';
  setText(cells.rank, entry.rank ?? '—');
  setText(cells.handle, entry.handle ? `@${entry.handle}` : 'anonymous');
  if (entry.handle) cells.handle.href = profileHref(entry.handle);
  else cells.handle.removeAttribute('href');
  const avatarUrl = absoluteAssetUrl(entry.image) || '';
  if (cells.avatarSlot.dataset.src !== avatarUrl) {
    cells.avatarSlot.dataset.src = avatarUrl;
    cells.avatarSlot.replaceChildren(avatarImage(avatarUrl, entry.handle, 24));
  }
  cells.house.hidden = !entry.house;
  setText(cells.title, entry.title || '');
  cells.title.title = entry.title || '';
  setText(cells.score, formatScore(entry.value, entry.display, rankColumn));
  const { low, high } = entry.interval || {};
  setText(cells.interval, entry.interval ? `${formatScore(low, low, rankColumn)} – ${formatScore(high, high, rankColumn)}` : '');
  setText(cells.received, entry.receivedAt ? formatTimeAgo(entry.receivedAt) : '');
}

export async function mountLeaderboardView(container, { slug }, route) {
  const view = buildLeaderboardLayout(slug);
  const goTo = (page) => paginateLeaderboardRows(view, page);
  view.previousButton.onclick = () => goTo(view.state.page - 1);
  view.nextButton.onclick = () => goTo(view.state.page + 1);
  view.search.addEventListener('input', () => {
    view.state.query = view.search.value.trim().toLowerCase();
    goTo(0);
  });

  function applyLeaderboardData(board) {
    Object.assign(view.state, normalizeLeaderboardRows(board));
    const { rows, rankColumn } = view.state;
    const title = board.competition?.title || slug;
    document.title = `Leaderboard · ${title} · make.fun`;
    setText(view.boardTitle, title);
    setText(view.scoreHeader, rankColumn?.title || 'Score');
    const phase = board.phase;
    setText(view.summary, [`${formatCount(rows.length)} ranked ${rows.length === 1 ? 'entry' : 'entries'}`, phase?.title && `${phase.title} phase`, phase?.placements_held && 'places unofficial until results publish'].filter(Boolean).join(' · '));
    goTo(view.state.page);
  }

  const onChange = (fresh) => route.isCurrent() && applyLeaderboardData(fresh);
  const board = await readCached(apiPaths.leaderboard({ slug }), onChange);
  if (!route.isCurrent()) return;
  container.replaceChildren(view.page);
  applyLeaderboardData(board);
  return revalidateWhileVisible(apiPaths.leaderboard({ slug }), onChange);
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

function createPooledRow() {
  const cells = { rank: el('td', { className: 'col-rank' }), avatarSlot: el('span', { className: 'avatar-slot' }), handle: el('a', { className: 'entrant-handle' }), house: el('span', { className: 'house-badge', hidden: true }, 'house'), title: el('td', { className: 'col-title' }), score: el('td', { className: 'col-score' }), interval: el('td', { className: 'col-interval' }), received: el('td', { className: 'col-received' }) };
  const row = el('tr', null, cells.rank, el('td', { className: 'col-entrant' }, cells.avatarSlot, cells.handle, cells.house), cells.title, cells.score, cells.interval, cells.received);
  return { row, cells };
}

function buildLeaderboardLayout(slug) {
  const view = {
    state: { page: 0, query: '', rows: [], rankColumn: null },
    rowPool: Array.from({ length: LEADERBOARD_PAGE_SIZE }, createPooledRow),
    boardTitle: el('a', { href: bountyHref(slug) }, slug),
    summary: el('p', { className: 'leaderboard-summary' }),
    scoreHeader: el('th', { scope: 'col', className: 'col-score' }, 'Score'),
    search: el('input', { type: 'search', className: 'input', placeholder: 'Filter by handle or entry', 'aria-label': 'Filter entries' }),
    pageLabel: el('span', { className: 'pager-label', 'aria-live': 'polite' }),
    previousButton: el('button', { type: 'button', className: 'button' }, '← Previous'),
    nextButton: el('button', { type: 'button', className: 'button' }, 'Next →'),
    emptyState: el('p', { className: 'empty-state', hidden: true }),
  };
  const th = (label, className) => el('th', { scope: 'col', className }, label);
  view.table = el('table', { className: 'leaderboard-table' }, el('thead', null, el('tr', null, th('#', 'col-rank'), th('Entrant'), th('Entry', 'col-title'), view.scoreHeader, th('90% interval', 'col-interval'), th('Entered', 'col-received'))), el('tbody', null, view.rowPool.map((pooled) => pooled.row)));
  view.pager = el('nav', { className: 'pager', 'aria-label': 'Leaderboard pages' }, view.previousButton, view.pageLabel, view.nextButton);
  view.page = el(
    'section',
    null,
    breadcrumb(view.boardTitle, el('span', null, 'Leaderboard')),
    el('div', { className: 'view-heading' }, el('h1', { tabIndex: -1 }, 'Leaderboard'), view.summary),
    el('div', { className: 'board-toolbar' }, view.search, el('a', { className: 'button', href: bountyHref(slug) }, 'Bounty details')),
    el('div', { className: 'table-scroll' }, view.table),
    view.emptyState,
    view.pager,
  );
  return view;
}

adoptViewStyles(`
.leaderboard-summary{margin:0;color:var(--muted)}
.leaderboard-table{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
.leaderboard-table tbody tr:hover{background:var(--surface-2)}
.col-rank{width:3.5rem;text-align:right;font-weight:800}
.podium .col-rank{color:var(--gold)}
.col-entrant{white-space:nowrap}
.avatar-slot{display:inline-flex;vertical-align:middle;margin-right:8px}
.entrant-handle{font-weight:600}
.house-badge{margin-left:6px;padding:1px 6px;border-radius:6px;background:var(--surface-2);color:var(--muted);font-size:.7rem;font-weight:700;text-transform:uppercase}
.col-title{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.col-score{font-weight:800;white-space:nowrap}
.col-interval,.col-received{color:var(--muted);font-size:.9rem;white-space:nowrap}
.pager{display:flex;justify-content:center;align-items:center;gap:12px;margin-top:16px}
.pager-label{color:var(--muted);font-variant-numeric:tabular-nums}
@media (max-width:900px){.col-interval{display:none}}
@media (max-width:640px){.leaderboard-table .col-title,.col-received{display:none}.col-entrant{white-space:normal;overflow-wrap:anywhere}.col-rank{width:2.5rem}}
`);
