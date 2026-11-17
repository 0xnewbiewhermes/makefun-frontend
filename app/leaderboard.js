// A bounty's leaderboard (#/bounty/<slug>/leaderboard), three panes on a desktop: the board list on the left (from
// memory), the ranked list in the middle, the selected entrant's card on the right. One read with ?rows=first (the top
// rows whole, every other row as the light record a ranked list needs) plus the bounty's own read for the pot and the
// "prize now" column; reached from the bounty page both are already in memory. Every row is reachable by scrolling, but
// only the rows in view (plus OVERSCAN_ROWS each side) exist: a pool of fixed-height ROW_HEIGHT rows is moved over one
// spacer and rewritten in place, so scrolling, filtering, selecting or a revalidation never rebuilds the list.

import { absoluteAssetUrl, adoptViewStyles, apiPaths, avatarImage, bountyHref, el, formatCount, formatScore, formatTimeAgo, formatTimeLeft, formatUsd, formatWinsDrawsLosses, isLive, leaderboardHref, livePot, normalizeLeaderboardRows, peekCached, prizeNow, profileHref, readCachedEtag, revalidateWhileVisible, setText, statCard } from './app.js';
import { mountBoardTable } from './board.js';

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
    Object.assign(pooled, { index, generation: state.generation, entry: rows[index] });
    pooled.row.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
    pooled.row.setAttribute('aria-rowindex', String(index + 2));
    fillPooledRow(pooled, rows[index], state);
  }
  for (const pooled of view.rowPool) if (!inView.has(pooled)) pooled.row.hidden = true;
  const shownFirst = Math.min(rows.length, Math.max(0, Math.floor(-top / ROW_HEIGHT)) + 1);
  const shownLast = Math.min(rows.length, Math.max(0, Math.floor((innerHeight - FOOTER_HEIGHT - top) / ROW_HEIGHT)));
  setText(view.domCount, rows.length ? `Rows ${formatCount(shownFirst)}–${formatCount(shownLast)} of ${formatCount(rows.length)} · ${inView.size} in the DOM` : '0 rows');
  view.list.setAttribute('aria-rowcount', String(rows.length + 1));
  view.emptyState.hidden = rows.length > 0;
  setText(view.emptyState, state.query ? 'No entry matches that filter.' : 'No ranked entries yet: scores show here once entries are judged.');
}

/** Select a row: the card on the right and the row highlight are rewritten in place, no request (a record past the top rows loads once, lazily). */
function selectEntrantInPlace(view, entry) {
  const { state, card } = view;
  if (!entry) return;
  state.selectedId = entry.id;
  for (const pooled of view.rowPool) pooled.row.setAttribute('aria-selected', String(pooled.entry?.id === entry.id));
  const { rankColumn, bounty } = state;
  const avatarUrl = absoluteAssetUrl(entry.image) || '';
  if (card.avatar.dataset.src !== avatarUrl || !card.avatar.firstChild) {
    card.avatar.dataset.src = avatarUrl;
    card.avatar.replaceChildren(avatarImage(avatarUrl, entry.handle, 52));
  }
  setText(card.handle, entry.handle ? `@${entry.handle}` : 'anonymous');
  card.handle.href = entry.handle ? profileHref(entry.handle) : '#';
  card.house.hidden = !entry.house;
  setText(card.title, entry.title || 'Untitled entry');
  setText(card.rank, entry.rank != null ? `#${formatCount(entry.rank)}` : '—');
  setText(card.rankNote, `of ${formatCount(state.rows.length)} ranked${entry.rankRange ? ` · could be #${entry.rankRange.best}–#${formatCount(entry.rankRange.worst)}` : ''}`);
  setText(card.score, formatScore(entry.value, entry.display, rankColumn));
  const { low, high } = entry.interval || {};
  setText(card.scoreNote, entry.interval ? `90% interval ${formatScore(low, low, rankColumn)} to ${formatScore(high, high, rankColumn)}` : rankColumn?.title || '');
  const share = (micro) => Math.max(0, Math.min(100, Number(micro) / 10_000));
  card.band.style.cssText = entry.interval ? `--low:${share(low)}%;--high:${share(high)}%;--at:${share(entry.value)}%` : '';
  card.band.hidden = !entry.interval;
  patchEntrantRecord(view, entry);
  const prize = entry.house ? 0 : prizeNow(bounty, entry.prizeRank);
  setText(card.prize, prize ? formatUsd(prize) : '—');
  setText(card.prizeNote, entry.house ? 'house entry, never paid' : prize ? `place ${entry.prizeRank} at today's pot` : 'outside the paid places');
  setText(card.entered, entry.receivedAt ? formatShortDate(entry.receivedAt) : '—');
  setText(card.enteredNote, entry.receivedAt ? formatTimeAgo(entry.receivedAt) : '');
  setText(card.profile, entry.handle ? `Open @${entry.handle}'s profile →` : '');
  card.profile.hidden = !entry.handle;
  card.profile.href = entry.handle ? profileHref(entry.handle) : '#';
  if (!entry.record && entry.id && !entry.house) loadRecordForSelected(view, entry);
}

/** The judge's wins, draws and losses for the selected entry: in the leaderboard answer for the top rows, else one lazy read of that submission. */
function patchEntrantRecord({ card }, entry) {
  const record = entry.record;
  setText(card.record, formatWinsDrawsLosses(record));
  setText(card.recordNote, record ? `wins–draws–losses in ${record.matches} judged matches` : entry.recordLoading ? 'loading the record…' : 'no judged matches yet');
}

async function loadRecordForSelected(view, entry) {
  entry.recordLoading = true;
  patchEntrantRecord(view, entry);
  const submission = await readCachedEtag(apiPaths.submission({ id: entry.id })).catch(() => null);
  const judge = submission?.scores?.find((score) => score.performance?.judge)?.performance.judge;
  entry.recordLoading = false;
  if (judge?.matches) entry.record = judge;
  if (view.state.selectedId === entry.id) patchEntrantRecord(view, entry);
  if (entry.record) view.state.generation++, virtualiseLeaderboardRows(view);
}

export async function mountLeaderboardView(root, { slug }, route) {
  const view = buildLeaderboardLayout(slug);
  const rail = matchMedia('(min-width:1180px)').matches ? mountBoardTable(view.rail, { currentSlug: slug, compact: true, mini: true, route }) : null;
  const scheduleVirtualise = oncePerFrame(virtualiseLeaderboardRows.bind(null, view));
  view.search.addEventListener('input', () => filterRowsOnEachKeystroke(view));
  view.spacer.addEventListener('click', (event) => event.target.closest('a') || openOrSelectEntrant(view, rowEntry(view, event.target)));
  view.spacer.addEventListener('keydown', (event) => moveSelectionWithKeys(view, event));
  const onBoard = route.whenCurrent((fresh) => applyLeaderboardData(view, slug, fresh));
  const onBounty = route.whenCurrent((fresh) => applyBountyData(view, fresh));
  const bountyPath = apiPaths.bounty({ slug });
  const [board, bounty] = await Promise.all([readCachedEtag(apiPaths.leaderboard({ slug }), onBoard), readCachedEtag(bountyPath, onBounty).catch(() => peekCached(apiPaths.board())?.items.find((item) => item.slug === slug))]);
  if (!route.isCurrent()) return (await rail)?.unmount();
  root.replaceChildren(view.page);
  view.state.bounty = bounty;
  applyBountyData(view, bounty);
  applyLeaderboardData(view, slug, board);
  addEventListener('scroll', scheduleVirtualise, { passive: true });
  addEventListener('resize', scheduleVirtualise);
  const stops = [revalidateWhileVisible(apiPaths.leaderboard({ slug }), onBoard), revalidateWhileVisible(bountyPath, onBounty)];
  const railHandle = await rail;
  return () => {
    stops.forEach((stop) => stop());
    railHandle?.unmount();
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
  setText(view.pot.note, fees > 0.004 ? `${formatUsd(bounty.rewardAmount)} + ${formatUsd(fees.toFixed(2))} fees` : 'reward');
  if (isLive(bounty)) {
    view.time.value.dataset.deadline = bounty.deadline;
    view.time.value.dataset.opens = bounty.opensAt || bounty.publishedAt || '';
    setText(view.time.value, formatTimeLeft(bounty.deadline));
  } else {
    delete view.time.value.dataset.deadline;
    setText(view.time.value, 'Closed');
  }
  setText(view.time.note, `${bounty.rewardsNow?.length || Object.keys(bounty.rewards || {}).length} paid places`);
  view.state.generation++;
  if (view.state.rows.length) virtualiseLeaderboardRows(view);
  const selected = view.state.rows.find((row) => row.id === view.state.selectedId);
  if (selected) selectEntrantInPlace(view, selected);
}

function applyLeaderboardData(view, slug, board) {
  const previous = new Map(view.state.rows.map((row) => [row.id, row.record]));
  Object.assign(view.state, normalizeLeaderboardRows(board));
  for (const row of view.state.rows) row.record ||= previous.get(row.id) || null;
  const { rows, rankColumn } = view.state;
  const title = board.competition?.title || board.title || slug;
  document.title = `Leaderboard · ${title} · make.fun`;
  setText(view.boardTitle, title);
  setText(view.scoreHeader, rankColumn?.title || 'Score');
  setText(view.entries.value, formatCount(rows.length));
  setText(view.entries.note, 'ranked entries');
  setText(view.phase.value, board.phase?.title || '—');
  setText(view.phase.note, board.phase?.placements_held ? 'places unofficial for now' : 'places final');
  filterRowsOnEachKeystroke(view);
  selectEntrantInPlace(view, rows.find((row) => row.id === view.state.selectedId) || rows[0]);
}

/** Desktop: select the row into the card. Phone (the card is hidden there): open the entrant's profile. */
function openOrSelectEntrant(view, entry) {
  if (!view.card.node.offsetParent && entry?.handle) location.hash = profileHref(entry.handle);
  else selectEntrantInPlace(view, entry);
}

const rowEntry = (view, target) => view.rowPool.find((pooled) => pooled.row.contains(target))?.entry;

/** Arrow keys move the selection through the rows in memory; Enter opens the selected entrant's profile. */
function moveSelectionWithKeys(view, event) {
  const rows = view.state.visibleRows;
  const at = rows.findIndex((row) => row.id === view.state.selectedId);
  if (event.key === 'Enter' && rows[at]?.handle) location.hash = profileHref(rows[at].handle);
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const next = rows[Math.max(0, Math.min(rows.length - 1, at + step))];
  selectEntrantInPlace(view, next);
  view.rowPool.find((pooled) => pooled.entry === next)?.row.focus({ preventScroll: false });
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

function fillPooledRow({ row, cells }, entry, { rankColumn, bounty, selectedId }) {
  row.className = `lb-row${entry.rank <= 3 ? ' podium' : ''}`;
  row.setAttribute('aria-selected', String(entry.id === selectedId));
  setText(cells.rank, entry.rank ?? '—');
  setText(cells.handle, entry.handle ? `@${entry.handle}` : 'anonymous');
  if (entry.handle) cells.handle.href = profileHref(entry.handle);
  else cells.handle.removeAttribute('href');
  const avatarUrl = absoluteAssetUrl(entry.image) || '';
  if (cells.avatarSlot.dataset.src !== avatarUrl || !cells.avatarSlot.firstChild) {
    cells.avatarSlot.dataset.src = avatarUrl;
    cells.avatarSlot.replaceChildren(avatarImage(avatarUrl, entry.handle, 30));
  }
  cells.house.hidden = !entry.house;
  setText(cells.title, entry.title || '');
  cells.title.title = entry.title || '';
  setText(cells.score, formatScore(entry.value, entry.display, rankColumn));
  const { low, high } = entry.interval || {};
  setText(cells.interval, entry.interval ? `${formatScore(low, low, rankColumn)} to ${formatScore(high, high, rankColumn)}` : '');
  setText(cells.record, formatWinsDrawsLosses(entry.record));
  const prize = entry.house ? 0 : prizeNow(bounty, entry.prizeRank);
  setText(cells.prize, prize ? formatUsd(prize) : '—');
  setText(cells.received, entry.receivedAt ? formatTimeAgo(entry.receivedAt) : '');
}

function createPooledRow(spacer) {
  const cell = (className, ...children) => el('span', { role: 'cell', className }, ...children);
  const cells = { rank: cell('col-rank'), avatarSlot: el('span', { className: 'avatar-slot' }), handle: el('a', { className: 'entrant-handle' }), house: el('span', { className: 'house-badge', hidden: true }, 'house'), title: el('span', { className: 'entrant-title' }), score: el('b'), interval: el('small'), record: cell('col-record'), prize: cell('col-prize'), received: cell('col-received') };
  const entrant = cell('col-entrant', cells.avatarSlot, el('span', { className: 'entrant-text' }, el('span', { className: 'entrant-line' }, cells.handle, cells.house), cells.title));
  const row = el('div', { role: 'row', className: 'lb-row', tabIndex: 0 }, cells.rank, entrant, cell('col-score', cells.score, cells.interval), cells.record, cells.prize, cells.received);
  spacer.append(row);
  return { row, cells, index: -1, generation: -1, entry: null };
}

/** The selected entrant's card: built once, every value written into the same nodes by selectEntrantInPlace. */
function mountEntrantCard() {
  const fact = (label) => {
    const value = el('dd'), note = el('small');
    return { node: el('div', { className: 'ec-fact' }, el('dt', null, label), value, note), value, note };
  };
  const [rank, score, record, prize, entered] = ['Rank', 'Judge win rate', 'Record', 'Prize now', 'Entered'].map(fact);
  const card = { avatar: el('span', { className: 'avatar-slot' }), handle: el('a', { className: 'ec-handle' }), house: el('span', { className: 'house-badge', hidden: true }, 'house'), title: el('p', { className: 'ec-title' }), band: el('div', { className: 'ec-band', 'aria-hidden': 'true' }, el('i'), el('b')), profile: el('a', { className: 'button button-primary ec-profile' }) };
  Object.assign(card, { rank: rank.value, rankNote: rank.note, score: score.value, scoreNote: score.note, record: record.value, recordNote: record.note, prize: prize.value, prizeNote: prize.note, entered: entered.value, enteredNote: entered.note });
  score.node.append(card.band);
  card.node = el(
    'aside',
    { className: 'entrant-card', 'aria-label': 'Selected entrant', 'aria-live': 'polite' },
    el('p', { className: 'ec-label' }, 'Selected entrant'),
    el('div', { className: 'ec-who' }, card.avatar, el('div', null, card.handle, card.house)),
    card.title,
    el('dl', { className: 'ec-facts' }, rank.node, score.node, record.node, prize.node, entered.node),
    card.profile,
    el('p', { className: 'ec-hint muted' }, 'Click a row or use ↑ ↓ to select: this card is patched in place, no new request.'),
  );
  return card;
}

function buildLeaderboardLayout(slug) {
  const view = {
    state: { query: '', rows: [], visibleRows: [], rankColumn: null, bounty: null, generation: 0, selectedId: null },
    rowPool: [],
    rail: el('div', { className: 'lb-rail' }),
    card: mountEntrantCard(),
    boardTitle: el('a', { href: bountyHref(slug) }, slug),
    scoreHeader: el('span', null, 'Score'),
    search: el('input', { type: 'search', className: 'input', placeholder: 'Filter by handle or entry', 'aria-label': 'Filter entries' }),
    spacer: el('div', { className: 'lb-spacer', role: 'rowgroup' }),
    emptyState: el('p', { className: 'empty-state', hidden: true }),
    domCount: el('span', { className: 'dom-count' }),
    pot: statCard('Live pot', 'stat-pot'),
    time: statCard('Time left'),
    entries: statCard('Ranked'),
    phase: statCard('Phase'),
  };
  const header = (label, className) => el('span', { role: 'columnheader', className }, label);
  view.list = el('div', { role: 'table', className: 'lb-table', 'aria-label': 'Leaderboard' }, el('div', { role: 'row', className: 'lb-row lb-head', 'aria-rowindex': '1' }, header('#', 'col-rank'), header('Entrant · entry', 'col-entrant'), el('span', { role: 'columnheader', className: 'col-score' }, view.scoreHeader, el('small', null, '90% interval')), header('W–D–L', 'col-record'), header('Prize now', 'col-prize'), header('Entered', 'col-received')), view.spacer);
  view.page = el(
    'div',
    { className: 'lb-page' },
    view.rail,
    el(
      'section',
      { className: 'lb-main' },
      el('div', { className: 'view-heading' }, el('div', null, el('h1', { tabIndex: -1 }, 'Leaderboard'), el('p', { className: 'lb-sub' }, view.boardTitle)), el('nav', { className: 'subtabs', 'aria-label': 'Bounty sections' }, el('a', { href: bountyHref(slug) }, 'Overview'), el('a', { href: leaderboardHref(slug), 'aria-current': 'page' }, 'Leaderboard'))),
      el('dl', { className: 'stat-row' }, view.pot.node, view.time.node, view.entries.node, view.phase.node),
      el('div', { className: 'lb-toolbar' }, view.search, view.domCount),
      view.list,
      view.emptyState,
    ),
    view.card.node,
  );
  return view;
}

const formatShortDate = (iso) => `${new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })} UTC`;
const ROW_HEIGHT = 46;
const OVERSCAN_ROWS = 6;
const FOOTER_HEIGHT = 24;

adoptViewStyles(`
.lb-page{display:grid;gap:12px;align-items:start}
@media (min-width:1180px){.lb-page{grid-template-columns:280px minmax(0,1fr) 250px}.lb-rail{position:sticky;top:8px;max-height:calc(100vh - 70px);overflow:auto}}
@media (max-width:1179px){.lb-rail{display:none}}
@media (min-width:900px){.entrant-card{position:sticky;top:8px}}
@media (min-width:900px) and (max-width:1179px){.lb-page{grid-template-columns:minmax(0,1fr) 250px}}
.lb-main{min-width:0}
.lb-main .view-heading{margin-bottom:8px;flex-wrap:nowrap}
.lb-main .view-heading>div{min-width:0}
.lb-sub{margin:1px 0 0;font-size:.9rem;font-weight:600}
.lb-main .stat-row{gap:8px;margin-bottom:8px}
.lb-main .stat{padding:5px 10px}
.lb-main .stat-value{font-size:1.25rem}
.lb-main .stat-pot .stat-value{font-size:1.35rem}
.lb-main .stat-note{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lb-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}
.lb-toolbar [type=search]{flex:1 1 180px}
.dom-count{padding:5px 12px;border-radius:999px;background:var(--money-soft);color:var(--money);font-size:.84rem;font-weight:700;white-space:nowrap}
.lb-table{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;font-variant-numeric:tabular-nums}
.lb-row{display:grid;grid-template-columns:2.2rem minmax(0,1fr) 7.6rem 4.4rem 4.6rem 3.6rem;align-items:center;gap:10px;height:${ROW_HEIGHT}px;padding:0 12px;border-bottom:1px solid var(--border);box-sizing:border-box}
.lb-spacer{position:relative;contain:strict;width:100%}
.lb-spacer .lb-row{position:absolute;top:0;left:0;right:0;cursor:pointer}
.lb-spacer .lb-row:hover{background:var(--surface-2)}
.lb-spacer .lb-row[aria-selected=true]{background:var(--accent-soft);box-shadow:inset 3px 0 var(--accent)}
.lb-head{height:34px;background:var(--surface-2);color:var(--muted);font-size:.7rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.lb-head small{display:block;font-size:.62rem;letter-spacing:0;text-transform:none}
.col-rank{text-align:right;font-weight:800;font-size:1.1rem}
.podium .col-rank{color:var(--gold)}
.col-entrant{display:flex;align-items:center;gap:9px;min-width:0}
.avatar-slot{display:inline-flex}
.entrant-text{display:grid;min-width:0}
.entrant-line,.entrant-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.entrant-handle{font-weight:700}
.entrant-title{color:var(--muted);font-size:.82rem}
.house-badge{margin-left:6px;padding:1px 6px;border-radius:6px;background:var(--surface-2);color:var(--muted);font-size:.68rem;font-weight:700;text-transform:uppercase}
.col-score{display:grid;text-align:right;white-space:nowrap;line-height:1.15}
.col-score b{font-size:1.05rem}
.col-score small{color:var(--muted);font-size:.74rem}
.col-record{text-align:center;font-weight:700;white-space:nowrap}
.col-prize{font-weight:800;color:var(--money);white-space:nowrap;text-align:right}
.lb-head .col-prize,.lb-head .col-rank{color:var(--muted);font-size:.7rem}
.col-received{color:var(--muted);font-size:.82rem;white-space:nowrap;text-align:right}
.entrant-card{display:grid;gap:8px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);min-width:0}
.ec-label{margin:0;color:var(--muted);font-size:.7rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.ec-who{display:flex;align-items:center;gap:10px;min-width:0}
.ec-handle{font-weight:800;font-size:1.1rem;overflow-wrap:anywhere}
.ec-title{margin:0;font-size:.86rem;line-height:1.35;color:var(--muted)}
.ec-facts{display:grid;gap:6px;margin:0}
.ec-fact{display:grid;grid-template-columns:auto 1fr;align-items:baseline;column-gap:8px;padding-top:6px;border-top:1px solid var(--surface-2)}
.ec-fact dt{color:var(--muted);font-size:.7rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.ec-fact dd{margin:0;text-align:right;font-weight:800;font-size:1.05rem;font-variant-numeric:tabular-nums}
.ec-fact small{grid-column:1/-1;color:var(--muted);font-size:.76rem}
.ec-fact:nth-child(2) dd{font-size:1.35rem;color:var(--accent)}
.ec-fact:nth-child(4) dd{color:var(--money)}
.ec-band{grid-column:1/-1;position:relative;height:8px;margin:4px 0 2px;border-radius:4px;background:var(--surface-2)}
.ec-band i{position:absolute;inset:0 calc(100% - var(--high)) 0 var(--low);border-radius:4px;background:var(--accent);opacity:.35}
.ec-band b{position:absolute;top:-3px;left:calc(var(--at) - 2px);width:4px;height:14px;border-radius:2px;background:var(--accent)}
.ec-profile{margin-top:2px}
.ec-hint{margin:0;font-size:.74rem}
@media (max-width:899px){.lb-page{grid-template-columns:minmax(0,1fr)}.entrant-card{display:none}}
@media (max-width:640px){.lb-row{grid-template-columns:1.8rem minmax(0,1fr) 5rem 4.2rem;gap:6px;padding:0 8px}.col-record,.col-received{display:none}.col-rank{font-size:1rem}.lb-main .subtabs{display:none}.lb-head{font-size:.6rem;letter-spacing:0}.lb-head .col-score small{display:none}.lb-head .col-prize,.lb-head .col-rank{font-size:.6rem}.lb-head>*{white-space:normal;line-height:1.1}.lb-main .stat-row{grid-template-columns:repeat(2,minmax(0,1fr))}}
`);
