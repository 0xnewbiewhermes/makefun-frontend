// One bounty (#/bounty/<slug>): live pot, entry fee, time left, entries and entries per paid place up top, then the
// rewards table of the live pot, its dates, the description and the rules. On wide screens the board's list stays
// beside it (master-detail), one rail reused across bounties. It paints at once from the board's cached copy, fills in
// from its own read, and patches the same nodes when a revalidation brings a change.

import { adoptViewStyles, apiPaths, bountyHref, breadcrumb, el, formatCount, formatDateTime, formatEntryFee, formatTimeLeft, formatUsd, isTakingEntries, leaderboardHref, livePotUsd, MAKEFUN_ORIGIN, paidPlaces, peekCached, readCached, revalidateWhileVisible, setText, statBlock } from './app.js';

export async function mountBountyView(root, { slug }, route) {
  const view = buildBountyLayout(slug);
  const railReady = matchMedia(MASTER_DETAIL_QUERY).matches && mountBoardListBesideBounty(view, slug, route);
  const fromBoard = peekCached(apiPaths.board())?.items?.find((item) => item.slug === slug);
  if (fromBoard) patchBountyInPlace(root, view, fromBoard);
  const onChange = route.whenCurrent((fresh) => patchBountyInPlace(root, view, fresh));
  const [bounty] = await Promise.all([readCached(apiPaths.bounty({ slug }), onChange), railReady]);
  if (!route.isCurrent()) return;
  patchBountyInPlace(root, view, bounty);
  return revalidateWhileVisible(apiPaths.bounty({ slug }), onChange);
}

/** The board's list beside the bounty: the cached board read, one rail element moved from page to page. */
async function mountBoardListBesideBounty(view, slug, route) {
  view.page.classList.add('with-rail');
  view.page.prepend(boardRail.node);
  const onChange = route.whenCurrent((fresh) => patchBoardRailInPlace(fresh.items, slug));
  const board = peekCached(apiPaths.board()) || (await readCached(apiPaths.board(), onChange).catch(() => null));
  if (board && route.isCurrent()) patchBoardRailInPlace(board.items, slug);
}

/** One row per live bounty, keyed by slug and rewritten in place; the open bounty is marked aria-current. */
function patchBoardRailInPlace(items, currentSlug) {
  const live = items.filter(isTakingEntries).sort((a, b) => livePotUsd(b) - livePotUsd(a));
  const rows = live.map((bounty) => {
    let row = boardRail.rows.get(bounty.slug);
    if (!row) {
      row = { title: el('span', { className: 'rail-title' }), pot: el('b', { className: 'rail-pot' }), left: el('span', { className: 'rail-left' }), fee: el('span', { className: 'rail-fee' }) };
      row.link = el('a', { href: bountyHref(bounty.slug), className: 'rail-link' }, row.title, el('span', { className: 'rail-numbers' }, row.pot, row.fee, row.left));
      row.node = el('li', null, row.link);
      boardRail.rows.set(bounty.slug, row);
    }
    setText(row.title, bounty.title);
    setText(row.pot, formatUsd(livePotUsd(bounty)));
    setText(row.fee, formatEntryFee(bounty) === 'Free' ? 'free' : `${formatEntryFee(bounty)} fee`);
    row.left.dataset.deadline = bounty.deadline;
    setText(row.left, formatTimeLeft(bounty.deadline));
    if (bounty.slug === currentSlug) row.link.setAttribute('aria-current', 'page');
    else row.link.removeAttribute('aria-current');
    return row.node;
  });
  rows.forEach((node, index) => boardRail.list.children[index] !== node && boardRail.list.insertBefore(node, boardRail.list.children[index] || null));
  while (boardRail.list.children.length > rows.length) boardRail.list.lastElementChild.remove();
  setText(boardRail.count, `${live.length} live`);
}

/** Write the numbers into the existing nodes; rebuild a heavy block (rewards, dates, text) only when its data changed. */
function patchBountyInPlace(root, view, bounty) {
  if (!view.page.isConnected) root.replaceChildren(view.page);
  document.title = `${bounty.title} · make.fun`;
  const [statusText, tone] = bountyStatusLabel(bounty);
  const fees = livePotUsd(bounty) - Number(bounty.rewardAmount || 0);
  const places = paidPlaces(bounty);
  setText(view.heading, bounty.title);
  setText(view.summary, bounty.summary || '');
  setText(view.status, statusText);
  view.status.dataset.tone = tone;
  setText(view.category, bounty.category || 'Bounty');
  setText(view.sponsor, bounty.sponsor?.name ? `by ${bounty.sponsor.name}` : '');
  setText(view.pot, formatUsd(livePotUsd(bounty)));
  setText(view.potNote, fees > 0.004 ? `${formatUsd(bounty.rewardAmount)} reward + ${formatUsd(fees.toFixed(2))} fees` : '');
  setText(view.fee, formatEntryFee(bounty));
  if (isTakingEntries(bounty)) view.timeLeft.dataset.deadline = bounty.deadline;
  else delete view.timeLeft.dataset.deadline;
  setText(view.timeLeft, isTakingEntries(bounty) ? formatTimeLeft(bounty.deadline) : 'Closed');
  setText(view.deadlineNote, formatDateTime(bounty.deadline));
  setText(view.entries, formatCount(bounty.submissionCount));
  setText(view.places, String(places));
  setText(view.placesNote, places ? `${formatCount(Math.round((bounty.submissionCount || 0) / places))} entries per place` : '');
  const rebuildIfChanged = (key, source, build) => {
    const signature = JSON.stringify(source ?? null);
    if (view.builtFrom[key] !== signature) build((view.builtFrom[key] = signature));
  };
  rebuildIfChanged('skills', bounty.skills, () => view.skills.replaceChildren(...(bounty.skills || []).map((skill) => el('li', { className: 'chip chip-static' }, skill))));
  rebuildIfChanged('rewards', bounty.rewardsNow || bounty.rewards, () => view.rewards.replaceChildren(buildRewardsTable(bounty)));
  rebuildIfChanged('dates', [bounty.opensAt, bounty.deadline, bounty.phases, bounty.resolvedAt], () => view.dates.replaceChildren(buildDatesList(bounty)));
  rebuildIfChanged('description', bounty.description, () => view.description.replaceChildren(renderMarkdown(bounty.description || bounty.summary || '')));
  if (bounty.rules) rebuildIfChanged('rules', bounty.rules, () => view.rules.replaceChildren(...buildRulesSections(bounty.rules)));
  view.rulesPanel.hidden = !bounty.rules;
}

function buildRewardsTable(bounty) {
  const rows = groupPayoutRows(bounty);
  const split = rows.some((row) => row.feeShare > 0);
  const th = (label, className) => el('th', { scope: 'col', className }, label);
  return el(
    'table',
    { className: 'rewards-table' },
    el('caption', { className: 'visually-hidden' }, 'Rewards by place, live pot'),
    el('thead', null, el('tr', null, th('Place'), split && th('Base + fees', 'prize-split'), th('Prize each', 'prize-amount'))),
    el(
      'tbody',
      null,
      rows.map((row) =>
        el(
          'tr',
          { className: row.first <= 3 ? `podium-${row.first}` : '' },
          el('th', { scope: 'row' }, row.first === row.last ? ordinal(row.first) : `${ordinal(row.first)}–${ordinal(row.last)}`),
          split && el('td', { className: 'prize-split' }, `${formatUsd(row.base)} + ${formatUsd(row.feeShare.toFixed(2))}`),
          el('td', { className: 'prize-amount' }, formatUsd(row.total)),
        ),
      ),
    ),
  );
}

/** The live payout curve as rows; consecutive places paying the same amount share one row ('4th–10th'). */
export function groupPayoutRows(bounty) {
  const places = bounty.rewardsNow?.length
    ? bounty.rewardsNow.map((r) => ({ place: r.place, base: Number(r.baseUsd), feeShare: Number(r.feeShareUsd || 0), total: Number(r.amountUsd) }))
    : Object.entries(bounty.rewards || {}).map(([place, amount]) => ({ place: Number(place), base: Number(amount), feeShare: 0, total: Number(amount) }));
  const rows = [];
  for (const place of places.sort((a, b) => a.place - b.place)) {
    const previous = rows.at(-1);
    if (previous && previous.total === place.total && previous.base === place.base && previous.last === place.place - 1) previous.last = place.place;
    else rows.push({ ...place, first: place.place, last: place.place });
  }
  return rows;
}

const MASTER_DETAIL_QUERY = '(min-width: 1100px)';
const boardRail = { rows: new Map(), list: el('ul', { className: 'rail-list' }), count: el('span', { className: 'muted' }) };
boardRail.node = el('nav', { className: 'board-rail', 'aria-label': 'Live bounties' }, el('h2', null, el('a', { href: '#/' }, 'Live bounties'), ' ', boardRail.count), boardRail.list);

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

function bountyStatusLabel(bounty) {
  if (isTakingEntries(bounty)) return ['Taking entries', 'live'];
  if (bounty.status === 'resolved' || bounty.resolvedAt) return ['Resolved', 'done'];
  return ['Closed · results pending', 'closed'];
}

function buildDatesList(bounty) {
  const phaseSpan = (phase) => phase.startsAt && phase.endsAt && `${formatDateTime(phase.startsAt)} → ${formatDateTime(phase.endsAt)}`;
  const items = [
    ['Opens', formatDateTime(bounty.opensAt || bounty.publishedAt)],
    ['Deadline', formatDateTime(bounty.deadline)],
    ...(bounty.phases || []).map((phase) => [phase.title, phaseSpan(phase)]),
    ['Resolved', bounty.resolvedAt && formatDateTime(bounty.resolvedAt)],
  ].filter(([, value]) => value && value !== '—');
  return el('dl', { className: 'dates-list' }, items.flatMap(([label, value]) => [el('dt', null, label), el('dd', null, value)]));
}

function buildRulesSections(rules) {
  return splitMarkdownSections(rules).map(({ title, body }, index) => el('details', { className: 'rules-section', open: index === 0 }, el('summary', null, title || 'Overview'), el('div', { className: 'prose' }, renderMarkdown(body))));
}

function buildBountyLayout(slug) {
  const view = { builtFrom: {}, heading: el('h1', { tabIndex: -1 }), summary: el('p', { className: 'bounty-summary' }), status: el('span', { className: 'status-badge' }), category: el('span', { className: 'tag' }), sponsor: el('span', { className: 'muted' }) };
  const [pot, fee, time, entries, places] = [statBlock('Live pot', '', 'stat-pot'), statBlock('Entry fee', '', 'stat-fee'), statBlock('Time left', ''), statBlock('Entries', ''), statBlock('Paid places', '')];
  Object.assign(view, { pot: pot.valueNode, fee: fee.valueNode, timeLeft: time.valueNode, entries: entries.valueNode, places: places.valueNode });
  Object.assign(view, { potNote: el('span', { className: 'stat-note' }), deadlineNote: el('span', { className: 'stat-note' }), placesNote: el('span', { className: 'stat-note' }) });
  pot.valueNode.after(view.potNote);
  time.valueNode.after(view.deadlineNote);
  places.valueNode.after(view.placesNote);
  Object.assign(view, { skills: el('ul', { className: 'skill-list', 'aria-label': 'Skills' }), rewards: el('div', { className: 'table-scroll' }), dates: el('div'), description: el('div', { className: 'prose' }), rules: el('div') });
  view.rulesPanel = el('section', { className: 'panel', hidden: true }, el('h2', null, 'Rules'), view.rules);
  const panel = (title, body) => el('section', { className: 'panel' }, el('h2', null, title), body);
  view.page = el(
    'div',
    { className: 'bounty-page' },
    el(
      'article',
      { className: 'bounty-detail' },
      breadcrumb(el('span', null, slug)),
      el('header', null, el('div', { className: 'bounty-tags' }, view.status, view.category, view.sponsor), view.heading, view.summary, view.skills),
      el('dl', { className: 'stat-row' }, pot.node, fee.node, time.node, entries.node, places.node),
      el('div', { className: 'bounty-actions' }, el('a', { className: 'button button-primary', href: leaderboardHref(slug) }, 'View leaderboard →'), el('a', { className: 'button', href: `${MAKEFUN_ORIGIN}/bounty/${encodeURIComponent(slug)}`, target: '_blank', rel: 'noopener' }, 'Open on make.fun ↗')),
      el('div', { className: 'bounty-columns' }, el('div', { className: 'bounty-main' }, panel('Description', view.description), view.rulesPanel), el('aside', { className: 'bounty-aside' }, panel('Rewards · live pot', view.rewards), panel('Dates', view.dates))),
    ),
  );
  return view;
}

// A small Markdown reader for descriptions and rules, building DOM nodes (never innerHTML): headings, paragraphs,
// lists, fenced code, block quotes, tables, inline code, bold, italics and links (https:, http: and make.fun paths).

/** Block Markdown as a DocumentFragment. */
export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      fragment.append(el(`h${Math.min(6, heading[1].length + 1)}`, { className: 'md-heading' }, renderInlineMarkdown(heading[2])));
      i++;
    } else if (line.startsWith('```')) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      i++;
      fragment.append(el('pre', { className: 'md-code' }, el('code', null, code.join('\n'))));
    } else if (/^>\s?/.test(line)) {
      const quoted = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) quoted.push(lines[i].replace(/^>\s?/, ''));
      fragment.append(el('blockquote', null, renderMarkdown(quoted.join('\n'))));
    } else if (isTableRow(line) && isTableRow(lines[i + 1] || '') && /^[\s|:-]+$/.test(lines[i + 1])) {
      const header = tableCells(line);
      const rows = [];
      for (i += 2; i < lines.length && isTableRow(lines[i]); i++) rows.push(tableCells(lines[i]));
      const cells = (tag, row) => el('tr', null, row.map((cell) => el(tag, null, renderInlineMarkdown(cell))));
      fragment.append(el('div', { className: 'table-scroll' }, el('table', { className: 'md-table' }, el('thead', null, cells('th', header)), el('tbody', null, rows.map((row) => cells('td', row))))));
    } else if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      const list = el(/^\s*\d/.test(line) ? 'ol' : 'ul', { className: 'md-list' });
      let item = null;
      for (; i < lines.length && lines[i].trim(); i++) {
        const bullet = lines[i].match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
        if (bullet) list.append((item = el('li', null, renderInlineMarkdown(bullet[1]))));
        else item?.append(' ', ...renderInlineMarkdown(lines[i].trim()));
      }
      fragment.append(list);
    } else {
      const paragraph = [line.trim()];
      for (i++; i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i]) && !isTableRow(lines[i]); i++) paragraph.push(lines[i].trim());
      fragment.append(el('p', null, renderInlineMarkdown(paragraph.join(' '))));
    }
  }
  return fragment;
}

/** Split Markdown by its top-level "## " headings: [{ title, body }]. */
export function splitMarkdownSections(source) {
  const sections = [];
  let current = { title: '', lines: [] };
  for (const line of String(source || '').split('\n')) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      if (current.title || current.lines.some((l) => l.trim())) sections.push(current);
      current = { title: heading[1].trim(), lines: [] };
    } else current.lines.push(line);
  }
  sections.push(current);
  return sections.map(({ title, lines }) => ({ title, body: lines.join('\n') }));
}

/** Inline Markdown of one line or paragraph as an array of nodes and strings. */
function renderInlineMarkdown(text) {
  const output = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    if (match.index > last) output.push(text.slice(last, match.index));
    const [token, code, bold, link, bareUrl, italic] = match;
    if (code) output.push(el('code', null, code.slice(1, -1)));
    else if (bold) output.push(el('strong', null, renderInlineMarkdown(bold.slice(2, -2))));
    else if (link) {
      const [, label, target] = link.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const href = target.startsWith('/') ? MAKEFUN_ORIGIN + target : /^https?:\/\//i.test(target) ? target : null;
      output.push(href ? externalLink(href, renderInlineMarkdown(label)) : label);
    } else if (bareUrl) output.push(externalLink(bareUrl, bareUrl));
    else if (italic) output.push(el('em', null, italic.slice(1, -1)));
    else output.push(token);
    last = match.index + token.length;
  }
  if (last < text.length) output.push(text.slice(last));
  return output;
}

const INLINE_PATTERN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(https:\/\/[^\s)<>"]+[^\s)<>".,;:!?])|(\*[^*\s][^*]*\*)/g;
const BLOCK_START = /^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+[.)]\s)/;
const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const tableCells = (line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
const externalLink = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);

adoptViewStyles(`
@media (min-width:1100px){.with-rail{display:grid;grid-template-columns:280px minmax(0,1fr);gap:20px;align-items:start}}
.board-rail{position:sticky;top:12px;max-height:calc(100vh - 24px);overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
.board-rail h2{margin:0;padding:10px 14px;font-size:.95rem;border-bottom:1px solid var(--border)}
.board-rail h2 a{color:var(--text);text-decoration:none}
.rail-list{list-style:none;margin:0;padding:0}
.rail-link{display:grid;gap:2px;padding:8px 14px;border-bottom:1px solid var(--border);color:var(--text);text-decoration:none}
.rail-link:hover{background:var(--surface-2)}
.rail-link[aria-current=page]{background:var(--accent-soft);box-shadow:inset 3px 0 var(--accent)}
.rail-title{font-weight:600;font-size:.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rail-numbers{display:flex;gap:10px;align-items:baseline;font-size:.82rem;color:var(--muted);font-variant-numeric:tabular-nums}
.rail-pot{color:var(--money);font-size:1rem}
.rail-left{margin-left:auto}
.bounty-tags{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:6px;font-size:.9rem}
.status-badge{padding:2px 10px;border-radius:999px;background:var(--surface-2);font-size:.8rem;font-weight:700}
.status-badge[data-tone=live]{background:var(--money-soft);color:var(--money)}
.status-badge[data-tone=live]::before{content:"● "}
.tag{padding:2px 8px;border-radius:6px;background:var(--accent-soft);color:var(--accent);font-size:.75rem;font-weight:700;text-transform:uppercase}
.bounty-detail h1{font-size:1.8rem}
.bounty-summary{max-width:75ch;margin:0 0 8px;color:var(--muted);font-size:1.05rem;line-height:1.45}
.skill-list{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px;padding:0;list-style:none}
.stat-fee .stat-value{color:var(--accent)}
.bounty-actions{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.bounty-columns{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:16px;align-items:start}
.bounty-main,.bounty-aside{display:grid;gap:16px;min-width:0}
.rewards-table td,.rewards-table th{padding:5px 8px;white-space:nowrap}
.prize-amount{text-align:right}
td.prize-amount{color:var(--money);font-weight:800}
.prize-split{color:var(--muted);font-size:.85rem}
.podium-1>:first-child{color:var(--gold);font-weight:800}
.dates-list{display:grid;grid-template-columns:max-content 1fr;gap:6px 12px;margin:0;font-size:.9rem}
.dates-list dt{color:var(--muted);font-weight:600}
.dates-list dd{margin:0}
.rules-section{padding:8px 0;border-top:1px solid var(--border)}
.rules-section summary{padding:4px 0;font-weight:700;cursor:pointer}
.prose{overflow-wrap:break-word}
.prose>:first-child{margin-top:0}
.prose p,.md-list{max-width:78ch}
.md-heading{margin:1.2em 0 .4em;font-size:1.05rem}
.prose code{padding:1px 5px;border-radius:6px;background:var(--surface-2);font-family:var(--mono);font-size:.86em}
.md-code{padding:12px;overflow-x:auto;border-radius:6px;background:var(--surface-2);font-size:.86em}
.md-code code{padding:0;background:none;font-size:1em}
.prose blockquote{margin:0;padding-left:12px;border-left:3px solid var(--border);color:var(--muted)}
@media (max-width:1099px){.board-rail{display:none}}
@media (max-width:900px){.bounty-columns{grid-template-columns:1fr}.bounty-aside{order:-1}}
@media (max-width:640px){.bounty-detail h1{font-size:1.45rem}.dates-list{grid-template-columns:1fr;gap:0}.dates-list dd{margin-bottom:8px}}
`);
