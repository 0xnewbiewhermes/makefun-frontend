// A bounty's leaderboard (#/bounty/<slug>/leaderboard): summary cards (pot, time left, entries ranked, leader) over one
// virtual list, from one read with ?rows=first (the top rows whole, every other row as the light record a ranked list
// needs) plus the bounty's own read for the pot and the "prize now" column. Every row is reachable by scrolling, but
// only the rows in view (plus OVERSCAN_ROWS each side) exist: a pool of fixed-height ROW_HEIGHT rows is moved over one
// spacer and rewritten in place, so scrolling, filtering or a revalidation never rebuilds the list.

import { absoluteAssetUrl, adoptViewStyles, apiPaths, avatarImage, bountyHref, el, formatCount, formatScore, formatTimeAgo, formatTimeLeft, formatUsd, isLive, leaderboardHref, livePot, normalizeLeaderboardRows, peekCached, prizeNow, profileHref, readCached, revalidateWhileVisible, setText, statCard } from './app.js';

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
    fillPooledRow(pooled, rows[index], state);
  }
  for (const pooled of view.rowPool) if (!inView.has(pooled)) pooled.row.hidden = true;
  setText(view.domCount, `Virtual list · ${inView.size} of ${formatCount(rows.length)} rows in the DOM`);
  view.list.setAttribute('aria-rowcount', String(rows.length + 1));
  view.emptyState.hidden = rows.length > 0;
  setText(view.emptyState, state.query ? 'No entry matches that filter.' : 'No ranked entries yet: scores show here once entries are judged.');
}

export async function mountLeaderboardView(root, { slug }, route) {
  const view = buildLeaderboardLayout(slug);
  const scheduleVirtualise = oncePerFrame(virtualiseLeaderboardRows.bind(null, view));
  view.search.addEventListener('input', () => filterRowsOnEachKeystroke(view));
  const onBoard = route.whenCurrent((fresh) => applyLeaderboardData(view, slug, fresh));
  const onBounty = route.whenCurrent((fresh) => applyBountyData(view, fresh));
  const bountyPath = apiPaths.bounty({ slug });
  const [board, bounty] = await Promise.all([readCached(apiPaths.leaderboard({ slug }), onBoard), readCached(bountyPath, onBounty).catch(() => peekCached(apiPaths.board())?.items.find((item) => item.slug === slug))]);
  if (!route.isCurrent()) return;
  root.replaceChildren(view.page);
  view.state.bounty = bounty;
  applyBountyData(view, bounty);
  applyLeaderboardData(view, slug, board);
  addEventListener('scroll', scheduleVirtualise, { passive: true });
  addEventListener('resize', scheduleVirtualise);
  const stops = [revalidateWhileVisible(apiPaths.leaderboard({ slug }), onBoard), revalidateWhileVisible(bountyPath, onBounty)];
  return () => {
    stops.forEach((stop) => stop());
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

/** The cards that come from the bounty: the live pot and the time left. */
function applyBountyData(view, bounty) {
  if (!bounty) return;
  view.state.bounty = bounty;
  const fees = livePot(bounty) - Number(bounty.rewardAmount || 0);
  setText(view.pot.value, formatUsd(livePot(bounty)));
  setText(view.pot.note, fees > 0.004 ? `${formatUsd(bounty.rewardAmount)} reward + ${formatUsd(fees.toFixed(2))} fees` : 'reward');
  if (isLive(bounty)) {
    view.time.value.dataset.deadline = bounty.deadline;
    view.time.value.dataset.opens = bounty.opensAt || bounty.publishedAt || '';
    setText(view.time.value, formatTimeLeft(bounty.deadline));
  } else {
    delete view.time.value.dataset.deadline;
    setText(view.time.value, 'Closed');
  }
  setText(view.time.note, `${bounty.submissionCount ? formatCount(bounty.submissionCount) + ' entries · ' : ''}${bounty.rewardsNow?.length || Object.keys(bounty.rewards || {}).length} paid places`);
  view.state.generation++;
  if (view.state.rows.length) virtualiseLeaderboardRows(view);
}

function applyLeaderboardData(view, slug, board) {
  Object.assign(view.state, normalizeLeaderboardRows(board));
  const { rows, rankColumn } = view.state;
  const title = board.competition?.title || board.title || slug;
  document.title = `Leaderboard · ${title} · make.fun`;
  setText(view.boardTitle, title);
  setText(view.scoreHeader, rankColumn?.title || 'Score');
  setText(view.entries.value, formatCount(rows.length));
  setText(view.entries.note, [board.phase?.title && `${board.phase.title} phase`, board.phase?.placements_held && 'places unofficial until results publish'].filter(Boolean).join(' · ') || 'ranked');
  const leader = rows[0];
  setText(view.leader.value, leader ? (leader.handle ? `@${leader.handle}` : 'anonymous') : '—');
  setText(view.leader.note, leader ? `${formatScore(leader.value, leader.display, rankColumn)} · ${leader.title || ''}` : 'no ranked entries yet');
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

function fillPooledRow({ row, cells }, entry, { rankColumn, bounty }) {
  row.className = `lb-row${entry.rank <= 3 ? ' podium' : ''}`;
  setText(cells.rank, entry.rank ?? '—');
  setText(cells.handle, entry.handle ? `@${entry.handle}` : 'anonymous');
  if (entry.handle) cells.handle.href = profileHref(entry.handle);
  else cells.handle.removeAttribute('href');
  const avatarUrl = absoluteAssetUrl(entry.image) || '';
  if (cells.avatarSlot.dataset.src !== avatarUrl || !cells.avatarSlot.firstChild) {
    cells.avatarSlot.dataset.src = avatarUrl;
    cells.avatarSlot.replaceChildren(avatarImage(avatarUrl, entry.handle, 32));
  }
  cells.house.hidden = !entry.house;
  setText(cells.title, entry.title || '');
  cells.title.title = entry.title || '';
  setText(cells.score, formatScore(entry.value, entry.display, rankColumn));
  const prize = entry.house ? 0 : prizeNow(bounty, entry.prizeRank);
  setText(cells.prize, prize ? formatUsd(prize) : '—');
  const { low, high } = entry.interval || {};
  setText(cells.interval, entry.interval ? `${formatScore(low, low, rankColumn)} – ${formatScore(high, high, rankColumn)}` : '');
  setText(cells.received, entry.receivedAt ? formatTimeAgo(entry.receivedAt) : '');
}

function createPooledRow(spacer) {
  const cell = (className, ...children) => el('span', { role: 'cell', className }, ...children);
  const cells = { rank: cell('col-rank'), avatarSlot: el('span', { className: 'avatar-slot' }), handle: el('a', { className: 'entrant-handle' }), house: el('span', { className: 'house-badge', hidden: true }, 'house'), title: el('span', { className: 'entrant-title' }), score: cell('col-score'), prize: cell('col-prize'), interval: cell('col-interval'), received: cell('col-received') };
  const entrant = cell('col-entrant', cells.avatarSlot, el('span', { className: 'entrant-text' }, el('span', { className: 'entrant-line' }, cells.handle, cells.house), cells.title));
  const row = el('div', { role: 'row', className: 'lb-row' }, cells.rank, entrant, cells.score, cells.prize, cells.interval, cells.received);
  spacer.append(row);
  return { row, cells, index: -1, generation: -1 };
}

function buildLeaderboardLayout(slug) {
  const view = {
    state: { query: '', rows: [], visibleRows: [], rankColumn: null, bounty: null, generation: 0 },
    rowPool: [],
    boardTitle: el('a', { href: bountyHref(slug) }, slug),
    scoreHeader: el('span', { role: 'columnheader', className: 'col-score' }, 'Score'),
    search: el('input', { type: 'search', className: 'input', placeholder: 'Filter by handle or entry', 'aria-label': 'Filter entries' }),
    spacer: el('div', { className: 'lb-spacer', role: 'rowgroup' }),
    emptyState: el('p', { className: 'empty-state', hidden: true }),
    domCount: el('span', { className: 'dom-count' }),
    pot: statCard('Live pot', 'stat-pot'),
    time: statCard('Time left'),
    entries: statCard('Entries ranked'),
    leader: statCard('Leader', 'stat-leader'),
  };
  const header = (label, className) => el('span', { role: 'columnheader', className }, label);
  view.list = el('div', { role: 'table', className: 'lb-table', 'aria-label': 'Leaderboard' }, el('div', { role: 'row', className: 'lb-row lb-head', 'aria-rowindex': '1' }, header('#', 'col-rank'), header('Entrant · entry', 'col-entrant'), view.scoreHeader, header('Prize now', 'col-prize'), header('90% interval', 'col-interval'), header('Entered', 'col-received')), view.spacer);
  view.page = el(
    'section',
    { className: 'lb-page' },
    el('div', { className: 'view-heading' }, el('div', null, el('h1', { tabIndex: -1 }, 'Leaderboard'), el('p', { className: 'lb-sub muted' }, view.boardTitle)), el('nav', { className: 'subtabs', 'aria-label': 'Bounty sections' }, el('a', { href: bountyHref(slug) }, 'Overview'), el('a', { href: leaderboardHref(slug), 'aria-current': 'page' }, 'Leaderboard'))),
    el('dl', { className: 'stat-row' }, view.pot.node, view.time.node, view.entries.node, view.leader.node),
    el('div', { className: 'lb-toolbar' }, view.search, view.domCount),
    view.list,
    view.emptyState,
  );
  return view;
}

const ROW_HEIGHT = 50;
const OVERSCAN_ROWS = 6;

adoptViewStyles(`
.lb-sub{margin:0;font-size:.95rem}
.lb-page .view-heading{margin-bottom:8px}
.lb-page .view-heading>div{display:flex;align-items:baseline;gap:4px 14px;flex-wrap:wrap}
.lb-page .stat-note{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lb-page .stat{padding:6px 12px}
.stat-leader .stat-value{color:var(--accent);font-size:1.3rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stat-leader .stat-note{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lb-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}
.lb-toolbar [type=search]{flex:1 1 220px}
.dom-count{padding:5px 12px;border-radius:999px;background:var(--money-soft);color:var(--money);font-size:.85rem;font-weight:700;white-space:nowrap}
.lb-table{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;font-variant-numeric:tabular-nums}
.lb-row{display:grid;grid-template-columns:3rem minmax(0,1fr) 6rem 6rem 9.5rem 5rem;align-items:center;gap:12px;height:${ROW_HEIGHT}px;padding:0 14px;border-bottom:1px solid var(--border);box-sizing:border-box}
.lb-spacer{position:relative;contain:strict;width:100%}
.lb-spacer .lb-row{position:absolute;top:0;left:0;right:0}
.lb-spacer .lb-row:hover{background:var(--surface-2)}
.lb-head{height:34px;background:var(--surface-2);color:var(--muted);font-size:.72rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.col-rank{text-align:right;font-weight:800;font-size:1.2rem}
.podium .col-rank{color:var(--gold);font-size:1.4rem}
.col-entrant{display:flex;align-items:center;gap:10px;min-width:0}
.avatar-slot{display:inline-flex}
.entrant-text{display:grid;min-width:0}
.entrant-line,.entrant-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.entrant-handle{font-weight:700;font-size:1.02rem}
.entrant-title{color:var(--muted);font-size:.88rem}
.house-badge{margin-left:6px;padding:1px 6px;border-radius:6px;background:var(--surface-2);color:var(--muted);font-size:.7rem;font-weight:700;text-transform:uppercase}
.col-score{font-weight:800;font-size:1.1rem;white-space:nowrap;text-align:right}
.col-prize{font-weight:800;color:var(--money);white-space:nowrap;text-align:right}
.lb-head .col-prize{color:var(--muted)}
.col-interval,.col-received{color:var(--muted);font-size:.88rem;white-space:nowrap}
.lb-head .col-score{white-space:normal;line-height:1.1}
.lb-head>*,.lb-head .col-score,.lb-head .col-rank{font-size:.72rem;color:var(--muted);font-weight:700}
@media (max-width:900px){.lb-row{grid-template-columns:2.6rem minmax(0,1fr) 5.2rem 5rem;gap:10px}.col-interval,.col-received{display:none}}
@media (max-width:640px){.lb-row{grid-template-columns:1.8rem minmax(0,1fr) 3.6rem 4.4rem;gap:6px;padding:0 8px}.col-score{font-size:1rem}.col-rank{font-size:1.05rem}.lb-row.lb-head{height:auto;min-height:34px;padding-block:5px;letter-spacing:0}.lb-page .subtabs{display:none}.stat-leader .stat-value{font-size:1.1rem}}
`);
