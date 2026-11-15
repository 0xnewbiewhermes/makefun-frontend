// A bounty's leaderboard (#/bounty/<slug>/leaderboard), read with ?rows=first: the first rows whole and every other
// row as the light record a ranked list needs. Thousands of rows are paged LEADERBOARD_PAGE_SIZE at a time through one
// pool of <tr> elements whose cells are rewritten in place, so paging or a refresh never rebuilds the table.

import { absoluteAssetUrl, leaderboardPath, readCached } from './api.js';
import { avatarImage, bountyHref, el, formatCount, formatScore, formatTimeAgo, profileHref, setText } from './ui.js';

const LEADERBOARD_PAGE_SIZE = 50;

/** Both row shapes of the API (whole and light) as one: rank, handle, title, score, interval, received, badges. */
export function normalizeLeaderboardRows(board) {
  const rankColumn = board.columns?.find((column) => column.key === board.rank_key) || null;
  const whole = (board.entries || []).map((entry) => ({
    rank: entry.rank,
    handle: entry.handle,
    title: entry.title,
    image: entry.image,
    value: entry.values?.[board.rank_key],
    display: entry.display?.[board.rank_key],
    interval: entry.interval,
    receivedAt: entry.received_at,
    house: entry.house || entry.baseline,
  }));
  const light = (board.rest || []).map((entry) => ({
    rank: entry.rank,
    handle: entry.handle,
    title: entry.title,
    image: null,
    value: entry.value,
    display: entry.display,
    interval: entry.interval,
    receivedAt: entry.received_at,
    house: entry.house || entry.baseline,
  }));
  return { rankColumn, rows: [...whole, ...light].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity)) };
}

function createPooledRow() {
  const cells = {
    rank: el('td', { className: 'col-rank' }),
    avatarSlot: el('span', { className: 'avatar-slot' }),
    handle: el('a', { className: 'entrant-handle' }),
    badge: el('span', { className: 'badge', hidden: true }, 'house'),
    title: el('td', { className: 'col-title' }),
    score: el('td', { className: 'col-score' }),
    interval: el('td', { className: 'col-interval' }),
    received: el('td', { className: 'col-received' }),
  };
  const row = el('tr', null, cells.rank, el('td', { className: 'col-entrant' }, cells.avatarSlot, cells.handle, cells.badge), cells.title, cells.score, cells.interval, cells.received);
  return { row, cells };
}

function fillPooledRow({ row, cells }, entry, rankColumn) {
  row.hidden = false;
  row.className = entry.rank <= 3 ? `podium podium-${entry.rank}` : '';
  setText(cells.rank, entry.rank ?? '—');
  setText(cells.handle, entry.handle ? `@${entry.handle}` : 'anonymous');
  if (entry.handle) cells.handle.href = profileHref(entry.handle);
  else cells.handle.removeAttribute('href');
  const avatarUrl = absoluteAssetUrl(entry.image) || '';
  if (cells.avatarSlot.dataset.src !== avatarUrl) {
    cells.avatarSlot.dataset.src = avatarUrl;
    cells.avatarSlot.replaceChildren(avatarImage(avatarUrl, entry.handle, 24));
  }
  cells.badge.hidden = !entry.house;
  setText(cells.title, entry.title || '');
  cells.title.title = entry.title || '';
  setText(cells.score, formatScore(entry.value, entry.display, rankColumn));
  setText(cells.interval, entry.interval ? `${formatScore(entry.interval.low, entry.interval.low, rankColumn)} – ${formatScore(entry.interval.high, entry.interval.high, rankColumn)}` : '');
  setText(cells.received, entry.receivedAt ? formatTimeAgo(entry.receivedAt) : '');
}

export async function mountLeaderboardView(container, { slug }, route) {
  const state = { page: 0, query: '', rows: [], rankColumn: null };
  const rowPool = Array.from({ length: LEADERBOARD_PAGE_SIZE }, createPooledRow);
  const heading = el('h1', { tabIndex: -1 }, 'Leaderboard');
  const boardTitle = el('a', { href: bountyHref(slug) });
  const summary = el('p', { className: 'leaderboard-summary' });
  const scoreHeader = el('th', { scope: 'col', className: 'col-score' }, 'Score');
  const search = el('input', { type: 'search', className: 'input', placeholder: 'Filter by handle or title', 'aria-label': 'Filter entries' });
  const pageLabel = el('span', { className: 'pager-label', 'aria-live': 'polite' });
  const previousButton = el('button', { type: 'button', className: 'button', onclick: () => goToPage(state.page - 1) }, '← Previous');
  const nextButton = el('button', { type: 'button', className: 'button', onclick: () => goToPage(state.page + 1) }, 'Next →');
  const emptyState = el('p', { className: 'empty-state', hidden: true });
  const table = el(
    'table',
    { className: 'leaderboard-table' },
    el('thead', null, el('tr', null, el('th', { scope: 'col', className: 'col-rank' }, '#'), el('th', { scope: 'col' }, 'Entrant'), el('th', { scope: 'col', className: 'col-title' }, 'Entry'), scoreHeader, el('th', { scope: 'col', className: 'col-interval' }, '90% interval'), el('th', { scope: 'col', className: 'col-received' }, 'Entered'))),
    el('tbody', null, rowPool.map((pooled) => pooled.row)),
  );
  const pager = el('nav', { className: 'pager', 'aria-label': 'Leaderboard pages' }, previousButton, pageLabel, nextButton);

  const filteredRows = () => {
    if (!state.query) return state.rows;
    return state.rows.filter((row) => `${row.handle} ${row.title}`.toLowerCase().includes(state.query));
  };

  function goToPage(page) {
    const rows = filteredRows();
    const pageCount = Math.max(1, Math.ceil(rows.length / LEADERBOARD_PAGE_SIZE));
    state.page = Math.min(Math.max(0, page), pageCount - 1);
    const pageRows = rows.slice(state.page * LEADERBOARD_PAGE_SIZE, (state.page + 1) * LEADERBOARD_PAGE_SIZE);
    rowPool.forEach((pooled, index) => (pageRows[index] ? fillPooledRow(pooled, pageRows[index], state.rankColumn) : (pooled.row.hidden = true)));
    table.hidden = pageRows.length === 0;
    pager.hidden = pageCount <= 1;
    previousButton.disabled = state.page === 0;
    nextButton.disabled = state.page >= pageCount - 1;
    setText(pageLabel, `Page ${state.page + 1} of ${formatCount(pageCount)}`);
    if (!pageRows.length) {
      emptyState.hidden = false;
      setText(emptyState, state.query ? 'No entry matches that filter.' : 'No ranked entries yet: scores show here once entries are judged, or once the placements are published.');
    } else emptyState.hidden = true;
  }

  search.addEventListener('input', () => {
    state.query = search.value.trim().toLowerCase();
    goToPage(0);
  });

  function applyLeaderboardData(board) {
    const { rankColumn, rows } = normalizeLeaderboardRows(board);
    Object.assign(state, { rankColumn, rows });
    const title = board.competition?.title || slug;
    document.title = `Leaderboard · ${title} · make.fun`;
    setText(boardTitle, title);
    setText(scoreHeader, rankColumn?.title || 'Score');
    const phase = board.phase;
    const facts = [`${formatCount(rows.length)} ranked ${rows.length === 1 ? 'entry' : 'entries'}`, phase?.title && `${phase.title} phase`, phase?.placements_held && 'places unofficial until results publish'];
    setText(summary, facts.filter(Boolean).join(' · '));
    goToPage(state.page);
  }

  const board = await readCached(leaderboardPath(slug), (fresh) => route.isCurrent() && applyLeaderboardData(fresh));
  if (!route.isCurrent()) return;
  container.replaceChildren(
    el(
      'section',
      { className: 'leaderboard-view' },
      el('nav', { className: 'breadcrumb', 'aria-label': 'Breadcrumb' }, el('a', { href: '#/' }, 'Bounties'), ' / ', boardTitle, ' / ', el('span', null, 'Leaderboard')),
      el('div', { className: 'view-heading' }, heading, summary),
      el('div', { className: 'board-toolbar' }, search, el('a', { className: 'button', href: bountyHref(slug) }, 'Bounty details')),
      el('div', { className: 'table-scroll' }, table),
      emptyState,
      pager,
    ),
  );
  applyLeaderboardData(board);
}
