// The board: one dense table row per bounty (pot, fee, time left with a deadline bar, entries), shared by the board
// route (#/) and the rail beside an open bounty. Rows are keyed by slug, rewritten in place and reordered by moving the
// same nodes, so filtering, sorting and the minute's revalidation never rebuild the table.

import { adoptViewStyles, apiPaths, bountyHref, el, formatCount, formatEntryFee, formatTimeLeft, formatUsd, isLive, livePot, paidPlaces, patchChildrenInPlace, readCachedEtag, revalidateWhileVisible, setText, statCard } from './app.js';

/** The board table in `host`; `currentSlug` marks the open bounty. Returns { unmount, patchRowFromBounty }. */
export async function mountBoardTable(host, options) {
  const { currentSlug = '', compact = false, route, onData } = options;
  const rows = new Map();
  let items = [];
  const search = el('input', { type: 'search', className: 'input', placeholder: 'Filter bounties…', 'aria-label': 'Filter bounties', value: filters.query });
  const tabs = el('div', { className: 'bt-tabs', role: 'group', 'aria-label': 'Live or ended' }, ['live', 'ended'].map((key) => el('button', { type: 'button', className: 'chip', dataset: { tab: key } })));
  const sorts = el('div', { className: 'bt-chips', role: 'group', 'aria-label': 'Sort' }, Object.entries(SORTS).map(([key, [label]]) => el('button', { type: 'button', className: 'chip', dataset: { sort: key } }, label)));
  const cats = el('div', { className: 'bt-chips', role: 'group', 'aria-label': 'Category' });
  const body = el('tbody');
  const more = el('button', { type: 'button', className: 'button bt-more', hidden: true });
  const empty = el('p', { className: 'empty-state', hidden: true }, 'No bounty matches. Clear the filter or pick another category.');
  const head = ['Bounty', 'Pot', 'Fee', 'Time left', 'Entries', 'Per place'].map((label, index) => el('th', { scope: 'col', className: ['', 'num', 'num', '', 'num', 'num x'][index] }, label));
  const node = el('section', { className: `btable${compact ? ' compact' : ''}`, 'aria-label': 'Bounty board' }, el('div', { className: 'bt-top' }, tabs, search), sorts, cats, el('div', { className: 'table-scroll' }, el('table', null, el('thead', null, el('tr', null, head)), body)), empty, more);
  host.append(node);

  function patchRowsInPlace() {
    const all = pool();
    const counts = new Map();
    for (const bounty of all) counts.set(bounty.category, (counts.get(bounty.category) || 0) + 1);
    if (filters.category !== 'all' && !counts.has(filters.category)) filters.category = 'all';
    const chip = (key, count) => el('button', { type: 'button', className: 'chip', dataset: { category: key }, 'aria-pressed': String(filters.category === key) }, key === 'all' ? 'All' : key, el('span', { className: 'chip-count' }, count));
    cats.replaceChildren(chip('all', all.length), ...[...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => chip(name, count)));
    const words = filters.query.split(/\s+/);
    const matches = all.filter((bounty) => (filters.category === 'all' || bounty.category === filters.category) && words.every((word) => [bounty.title, bounty.summary, bounty.category, bounty.sponsor?.name, ...(bounty.skills || [])].join(' ').toLowerCase().includes(word)));
    if (filters.tab === 'live') matches.sort(SORTS[filters.sort][1]);
    else if (filters.sort !== 'ending') matches.sort(SORTS[filters.sort][1]);
    const shown = matches.slice(0, filters.limit);
    patchChildrenInPlace(body, shown.map((bounty) => patchRowCells(bounty)));
    empty.hidden = matches.length > 0;
    more.hidden = matches.length <= shown.length;
    setText(more, `Show more (${matches.length - shown.length} left)`);
    for (const tab of tabs.children) {
      tab.setAttribute('aria-pressed', String(tab.dataset.tab === filters.tab));
      setText(tab, tab.dataset.tab === 'live' ? `Live ${items.filter(isLive).length}` : `Ended${tab.dataset.tab === filters.tab ? ' ' + all.length : ''}`);
    }
    for (const chip of sorts.children) chip.setAttribute('aria-pressed', String(chip.dataset.sort === filters.sort));
    for (const row of rows.values()) row.node.toggleAttribute('aria-current', row.slug === currentSlug);
  }

  function patchRowCells(bounty) {
    let row = rows.get(bounty.slug);
    if (!row) {
      row = { slug: bounty.slug, title: el('a', { className: 'title', href: bountyHref(bounty.slug) }), tag: el('span', { className: 'tag' }), sub: el('span', { className: 'sub' }), pot: el('td', { className: 'num pot' }), fee: el('td', { className: 'num fee' }), left: el('span', { className: 't' }), entries: el('td', { className: 'num' }), per: el('td', { className: 'num x muted' }) };
      row.node = el('tr', null, el('td', { className: 'bt-name' }, row.title, el('div', null, row.tag, row.sub)), row.pot, row.fee, el('td', { className: 'tl' }, row.left, el('em', { className: 'badge' }, 'closing soon'), el('i', { className: 'bar' })), row.entries, row.per);
      rows.set(bounty.slug, row);
    }
    const entries = bounty.submissionCount;
    setText(row.title, bounty.title);
    setText(row.tag, bounty.category);
    setText(row.sub, `fee ${formatEntryFee(bounty)} · ${formatCount(entries)} entries`);
    setText(row.pot, formatUsd(livePot(bounty)));
    setText(row.fee, formatEntryFee(bounty));
    setText(row.entries, formatCount(entries));
    setText(row.per, paidPlaces(bounty) ? Math.round(entries / paidPlaces(bounty)) + '' : '—');
    if (isLive(bounty)) {
      row.left.dataset.deadline = bounty.deadline;
      row.left.dataset.opens = bounty.publishedAt || bounty.opensAt || '';
      setText(row.left, formatTimeLeft(bounty.deadline));
    } else {
      delete row.left.dataset.deadline;
      delete row.left.dataset.urgency;
      row.node.querySelector('.bar').parentNode.style.setProperty('--used', '100%');
      setText(row.left, 'Ended ' + new Date(bounty.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }));
    }
    return row.node;
  }

  let endedItems = [];
  const ended = () => endedItems.filter((item) => !items.some((it) => it.slug === item.slug));
  const pool = () => (filters.tab === 'live' ? items.filter(isLive) : [...items.filter((item) => !isLive(item)), ...ended()].sort((a, b) => new Date(b.deadline) - new Date(a.deadline)));

  const take = (data) => {
    items = data.items;
    onData?.(items.filter(isLive));
    patchRowsInPlace();
  };
  search.addEventListener('input', () => {
    filters.query = search.value.trim().toLowerCase();
    patchRowsInPlace();
  });
  node.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-tab],button[data-sort],button[data-category]');
    if (event.target === more) filters.limit += 30;
    else if (!button) return;
    else if (button.dataset.tab) {
      filters.tab = button.dataset.tab;
      filters.limit = 30;
      if (filters.tab === 'ended') endedItems = (await readCachedEtag(apiPaths.ended()).catch(() => ({ items: [] }))).items;
    } else if (button.dataset.sort) filters.sort = button.dataset.sort;
    else filters.category = button.dataset.category;
    patchRowsInPlace();
  });
  const onChange = route.whenCurrent(take);
  take(await readCachedEtag(apiPaths.board(), onChange));
  const stop = revalidateWhileVisible(apiPaths.board(), onChange);
  /** The bounty page's own answer is the freshest copy of its row: write it into the cached item and the row, so both show the same numbers. */
  const patchRowFromBounty = (bounty) => {
    const item = items.find((candidate) => candidate.slug === bounty.slug);
    if (!item) return;
    for (const key of ['potUsd', 'entryFeesUsd', 'entryFeePayers', 'entryFeeUsd', 'submissionCount', 'rewardsNow', 'deadline']) if (bounty[key] !== undefined) item[key] = bounty[key];
    patchRowsInPlace();
  };
  return { unmount: () => (stop(), node.remove()), items: () => items, patchRowFromBounty };
}

/** The board route (#/): summary cards over the full table. */
export async function mountBoardView(root, _params, route) {
  document.title = 'Live bounties · make.fun';
  const cards = [statCard('Live bounties', 'stat-count'), statCard('Live pots', 'stat-pot'), statCard('Entries', ''), statCard('Next deadline', 'stat-next')];
  const nextLink = el('a', { className: 'next-link' });
  cards[3].note.append(nextLink);
  const view = el('section', null, el('div', { className: 'view-heading' }, el('h1', { tabIndex: -1 }, 'Live bounties'), el('span', { className: 'live-dot' })), el('dl', { className: 'stat-row' }, cards.map((card) => card.node)));
  root.replaceChildren(view);
  const dot = view.querySelector('.live-dot');
  const totals = (live) => {
    const sum = (pick) => live.reduce((total, bounty) => total + pick(bounty), 0);
    const next = [...live].sort((a, b) => new Date(a.deadline) - new Date(b.deadline))[0];
    setText(cards[0].value, formatCount(live.length));
    setText(cards[0].note, 'taking entries now');
    setText(cards[1].value, formatUsd(Math.round(sum(livePot))));
    setText(cards[1].note, 'rewards + entry fees');
    setText(cards[2].value, formatCount(sum((bounty) => bounty.submissionCount)));
    setText(cards[2].note, 'across all live bounties');
    if (next) {
      cards[3].value.dataset.deadline = next.deadline;
      cards[3].value.dataset.opens = next.publishedAt || '';
      setText(cards[3].value, formatTimeLeft(next.deadline));
      setText(nextLink, next.title);
      nextLink.href = bountyHref(next.slug);
      cards[3].note.append(nextLink);
    }
    dot.dataset.checked = apiPaths.board();
  };
  const table = await mountBoardTable(view, { route, onData: totals });
  if (!route.isCurrent()) return table.unmount();
  return table.unmount;
}

const SORTS = {
  ending: ['Closing soon', (a, b) => new Date(a.deadline) - new Date(b.deadline)],
  pot: ['Biggest pot', (a, b) => livePot(b) - livePot(a)],
  entries: ['Most entries', (a, b) => b.submissionCount - a.submissionCount],
  odds: ['Fewest per place', (a, b) => a.submissionCount / paidPlaces(a) - b.submissionCount / paidPlaces(b)],
};
const filters = { tab: 'live', sort: 'ending', category: 'all', query: '', limit: 30 };

adoptViewStyles(`
.bt-top{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.bt-top [type=search]{flex:1 1 140px;min-width:0}
.bt-tabs{display:flex;gap:4px}
.bt-chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
.btable{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:10px}
.btable table{table-layout:auto}
.btable td,.btable th{padding:7px 8px}
.btable tbody tr{position:relative}
.btable tbody tr:hover{background:var(--surface-2)}
.btable tr[aria-current]{background:var(--accent-soft);box-shadow:inset 3px 0 var(--accent)}
.num{text-align:right;white-space:nowrap}
.pot{color:var(--money);font-weight:800;font-size:1.05rem}
.fee{color:var(--text)}
.bt-name{min-width:11rem}
.title{color:var(--text);font-weight:700;text-decoration:none}
.title::after{content:"";position:absolute;inset:0}
.title:focus-visible{outline:none}
tr:has(.title:focus-visible){outline:3px solid var(--focus)}
.sub{display:none;margin-left:6px;color:var(--muted);font-size:.78rem;white-space:nowrap}
.bt-more{margin-top:8px}
.next-link{color:var(--accent);font-weight:600}
.live-dot{color:var(--money);font-weight:700;font-size:.85rem}
.compact .x{display:none}
.compact .tl{min-width:6.2rem}
.compact td,.compact th{padding:6px 5px}
.compact .bt-name{min-width:8.5rem}
.compact .title{font-size:.9rem}
.compact .pot{font-size:.95rem}
.compact .bt-chips .chip{min-height:26px;font-size:.78rem;padding:1px 9px}
@media (max-width:760px){.btable .x{display:none}.btable .fee,.btable th:nth-child(3),.btable td:nth-child(5),.btable th:nth-child(5){display:none}.sub{display:inline}.bt-name{min-width:0}.bt-chips{flex-wrap:nowrap;overflow-x:auto}.chip{flex:none}}
`);
