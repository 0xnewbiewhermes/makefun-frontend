// The bounty board (#/): the bounties still taking entries, each card keyed by slug and patched in place when a
// refresh brings new numbers. Sort, category and search work on the data in memory, never with a new request.

import { boardPath, prefetchBounty, readCached, refreshCached } from './api.js';
import { bountyHref, el, entryFeeUsd, formatCount, formatUsd, isTakingEntries, livePotUsd, pluralize, setText, trackCountdown } from './ui.js';

const BOARD_POLL_MS = 60_000;

const BOARD_SORTS = {
  ending: { label: 'Ending soonest', compare: (a, b) => new Date(a.deadline) - new Date(b.deadline) },
  pot: { label: 'Biggest pot', compare: (a, b) => livePotUsd(b) - livePotUsd(a) },
  entries: { label: 'Most entries', compare: (a, b) => b.submissionCount - a.submissionCount },
  newest: { label: 'Newest', compare: (a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0) },
};

/** Kept across visits to the board, so coming back keeps the reader's choices. */
const boardFilters = { sort: 'ending', category: 'all', query: '' };
/** slug -> { card, refs } built once, reused by every render. */
const bountyCards = new Map();

function createBountyCard(slug) {
  const refs = {
    category: el('span', { className: 'card-category' }),
    title: el('a', { className: 'card-title-link', href: bountyHref(slug), onpointerenter: () => prefetchBounty(slug), onfocus: () => prefetchBounty(slug) }),
    summary: el('p', { className: 'card-summary' }),
    pot: el('span', { className: 'card-pot-amount' }),
    potNote: el('span', { className: 'card-pot-note' }),
    fee: el('span', { className: 'card-fee' }),
    timeLeft: el('span', { className: 'card-time-left' }),
    entries: el('span', { className: 'card-entries' }),
    sponsor: el('span', { className: 'card-sponsor' }),
  };
  const card = el(
    'li',
    { className: 'bounty-card', 'data-deadline-scope': '' },
    el('div', { className: 'card-top' }, refs.category, refs.sponsor),
    el('h2', { className: 'card-title' }, refs.title),
    refs.summary,
    el('div', { className: 'card-pot' }, el('span', { className: 'card-pot-label' }, 'Live pot'), refs.pot, refs.potNote),
    el(
      'dl',
      { className: 'card-facts' },
      el('div', null, el('dt', null, 'Time left'), el('dd', null, refs.timeLeft)),
      el('div', null, el('dt', null, 'Entry fee'), el('dd', null, refs.fee)),
      el('div', null, el('dt', null, 'Entries'), el('dd', null, refs.entries)),
    ),
  );
  return { card, refs };
}

function updateBountyCard({ refs }, bounty) {
  const pot = livePotUsd(bounty);
  const fees = pot - Number(bounty.rewardAmount || 0);
  setText(refs.category, bounty.category || 'Bounty');
  setText(refs.title, bounty.title);
  setText(refs.summary, bounty.summary || '');
  setText(refs.pot, formatUsd(pot));
  setText(refs.potNote, fees > 0.004 ? `incl. ${formatUsd(fees.toFixed(2))} fees` : '');
  setText(refs.fee, entryFeeUsd(bounty) > 0 ? formatUsd(bounty.entryFeeUsd) : 'Free');
  refs.fee.classList.toggle('is-free', !(entryFeeUsd(bounty) > 0));
  setText(refs.entries, formatCount(bounty.submissionCount));
  setText(refs.sponsor, bounty.sponsor?.name ? `by ${bounty.sponsor.name}` : '');
  trackCountdown(refs.timeLeft, bounty.deadline);
}

function matchesSearch(bounty, query) {
  if (!query) return true;
  const haystack = [bounty.title, bounty.summary, bounty.category, bounty.sponsor?.name, ...(bounty.skills || [])].join(' ').toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

function buildBoardToolbar(onChange) {
  const search = el('input', { type: 'search', className: 'input', placeholder: 'Search bounties, skills…', 'aria-label': 'Search bounties', value: boardFilters.query });
  const sort = el('select', { className: 'input', 'aria-label': 'Sort bounties' }, Object.entries(BOARD_SORTS).map(([key, { label }]) => el('option', { value: key }, label)));
  sort.value = boardFilters.sort;
  const categoryChips = el('div', { className: 'category-chips', role: 'group', 'aria-label': 'Filter by category' });
  search.addEventListener('input', () => {
    boardFilters.query = search.value.trim().toLowerCase();
    onChange();
  });
  sort.addEventListener('change', () => {
    boardFilters.sort = sort.value;
    onChange();
  });
  categoryChips.addEventListener('click', (event) => {
    const chip = event.target.closest('button[data-category]');
    if (!chip) return;
    boardFilters.category = chip.dataset.category;
    onChange();
  });
  const toolbar = el('div', { className: 'board-toolbar' }, search, sort);
  return { toolbar, categoryChips };
}

function renderCategoryChips(container, liveBounties) {
  const counts = new Map();
  for (const bounty of liveBounties) counts.set(bounty.category || 'Other', (counts.get(bounty.category || 'Other') || 0) + 1);
  if (boardFilters.category !== 'all' && !counts.has(boardFilters.category)) boardFilters.category = 'all';
  const chip = (key, label, count) => el('button', { type: 'button', className: 'chip', dataset: { category: key }, 'aria-pressed': String(boardFilters.category === key) }, label, el('span', { className: 'chip-count' }, count));
  container.replaceChildren(chip('all', 'All', liveBounties.length), ...[...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => chip(name, name, count)));
}

export async function mountBoardView(container, _params, route) {
  document.title = 'Live bounties · make.fun';
  let liveBounties = [];
  const heading = el('h1', { tabIndex: -1 }, 'Live bounties');
  const totals = el('p', { className: 'board-totals' });
  const resultCount = el('p', { className: 'board-result-count', 'aria-live': 'polite' });
  const bountyList = el('ul', { className: 'bounty-grid' });
  const emptyState = el('p', { className: 'empty-state', hidden: true }, 'No live bounty matches. Clear the search or pick another category.');
  const { toolbar, categoryChips } = buildBoardToolbar(applyBoardFilters);

  function applyBoardFilters() {
    renderCategoryChips(categoryChips, liveBounties);
    const visible = liveBounties
      .filter((bounty) => boardFilters.category === 'all' || (bounty.category || 'Other') === boardFilters.category)
      .filter((bounty) => matchesSearch(bounty, boardFilters.query))
      .sort(BOARD_SORTS[boardFilters.sort].compare);
    bountyList.replaceChildren(...visible.map((bounty) => bountyCards.get(bounty.slug).card));
    emptyState.hidden = visible.length > 0;
    setText(resultCount, visible.length === liveBounties.length ? '' : `Showing ${visible.length} of ${liveBounties.length}`);
  }

  function applyBoardData(data) {
    liveBounties = (data.items || []).filter(isTakingEntries);
    for (const bounty of liveBounties) {
      if (!bountyCards.has(bounty.slug)) bountyCards.set(bounty.slug, createBountyCard(bounty.slug));
      updateBountyCard(bountyCards.get(bounty.slug), bounty);
    }
    const potTotal = liveBounties.reduce((sum, bounty) => sum + livePotUsd(bounty), 0);
    const entryTotal = liveBounties.reduce((sum, bounty) => sum + (bounty.submissionCount || 0), 0);
    setText(totals, `${pluralize(liveBounties.length, 'bounty', 'bounties')} taking entries · ${formatUsd(Math.round(potTotal))} in live pots · ${pluralize(entryTotal, 'entry', 'entries')}`);
    applyBoardFilters();
  }

  const data = await readCached(boardPath(), (fresh) => route.isCurrent() && applyBoardData(fresh));
  if (!route.isCurrent()) return;
  container.replaceChildren(el('section', { className: 'board-view' }, el('div', { className: 'view-heading' }, heading, totals), toolbar, categoryChips, resultCount, bountyList, emptyState));
  applyBoardData(data);

  const pollBoard = () => {
    if (document.visibilityState !== 'visible') return;
    refreshCached(boardPath()).then((fresh) => fresh && route.isCurrent() && applyBoardData(fresh), () => {});
  };
  const pollTimer = setInterval(pollBoard, BOARD_POLL_MS);
  document.addEventListener('visibilitychange', pollBoard);
  return () => {
    clearInterval(pollTimer);
    document.removeEventListener('visibilitychange', pollBoard);
  };
}
