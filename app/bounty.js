// One bounty (#/bounty/<slug>): the board table beside it on wide screens (one table, the open bounty highlighted),
// then title, status, live pot, entry fee, time left, entries, the rewards the live pot pays now, the dates with a
// "Now" marker, a top-5 preview and the rules. Reached from the board it costs one API request: the board table comes
// from memory, the top-5 from memory when a hover already read it (else it loads after the view is ready), and the
// bounty's own answer also patches the highlighted board row, so the row and the pot card show the same numbers.

import { absoluteAssetUrl, adoptViewStyles, apiPaths, avatarImage, bountyHref, el, formatCount, formatDateTime, formatEntryFee, formatScore, formatTimeLeft, formatUsd, formatWinsDrawsLosses, isLive, leaderboardHref, livePot, MAKEFUN_ORIGIN, normalizeLeaderboardRows, paidPlaces, peekCached, prizeNow, profileHref, readCachedEtag, revalidateWhileVisible, setText, statCard } from './app.js';
import { mountBoardTable } from './board.js';

export async function mountBountyOneRequest(root, { slug }, route) {
  const view = buildBountyLayout(slug);
  const rail = matchMedia('(min-width:1000px)').matches ? mountBoardTable(view.rail, { currentSlug: slug, compact: true, route }) : null;
  const fromBoard = peekCached(apiPaths.board(), true)?.items?.find((item) => item.slug === slug);
  if (fromBoard) patchBountyInPlace(root, view, fromBoard);
  const onChange = route.whenCurrent((fresh) => {
    patchBountyInPlace(root, view, fresh);
    rail?.then((handle) => handle.patchRowFromBounty(fresh));
  });
  const bounty = await readCachedEtag(apiPaths.bounty({ slug }), onChange).catch(async (error) => {
    (await rail)?.unmount();
    throw error;
  });
  if (!route.isCurrent()) return (await rail)?.unmount();
  onChange(bounty);
  const onTop = route.whenCurrent((fresh) => patchTopFive(view, fresh));
  readCachedEtag(apiPaths.leaderboard({ slug }), onTop).then(onTop, () => setText(view.topNote, 'Leaderboard unavailable right now.'));
  const stopBounty = revalidateWhileVisible(apiPaths.bounty({ slug }), onChange);
  const stopTop = revalidateWhileVisible(apiPaths.leaderboard({ slug }), onTop);
  const refreshDates = setInterval(() => patchDates(view, view.bounty), 30_000);
  const railHandle = await rail;
  return () => (stopBounty(), stopTop(), clearInterval(refreshDates), railHandle?.unmount());
}

/** Write the numbers into the existing nodes; rebuild a heavy block (rewards, dates, text) only when its data changed. */
function patchBountyInPlace(root, view, bounty) {
  if (!view.page.isConnected) root.replaceChildren(view.page);
  view.bounty = bounty;
  document.title = `${bounty.title} · make.fun`;
  const [statusText, tone] = bountyStatusLabel(bounty);
  const fees = livePot(bounty) - Number(bounty.rewardAmount || 0);
  const live = isLive(bounty);
  setText(view.heading, bounty.title);
  setText(view.summary, bounty.summary || '');
  setText(view.status, statusText);
  view.status.dataset.tone = tone;
  setText(view.category, bounty.category || 'Bounty');
  setText(view.sponsor, bounty.sponsor?.name ? `by ${bounty.sponsor.name}` : '');
  setText(view.pot.value, formatUsd(livePot(bounty)));
  setText(view.pot.note, fees > 0.004 ? `${formatUsd(bounty.rewardAmount)} reward + ${formatUsd(fees.toFixed(2))} fees` : 'reward');
  setText(view.fee.value, formatEntryFee(bounty));
  setText(view.fee.note, bounty.entryFeePayers ? `${formatCount(bounty.entryFeePayers)} paid` : 'no fee to enter');
  if (live) {
    view.time.value.dataset.deadline = bounty.deadline;
    view.time.value.dataset.opens = bounty.opensAt || bounty.publishedAt || '';
  } else delete view.time.value.dataset.deadline;
  setText(view.time.value, live ? formatTimeLeft(bounty.deadline) : 'Closed');
  setText(view.time.note, `closes ${formatShortUtc(bounty.deadline)}`);
  setText(view.entries.value, formatCount(bounty.submissionCount));
  setText(view.entries.note, bounty.submissionsPassed != null ? `${formatCount(bounty.submissionsPassed)} passed the checks` : `${formatCount(Math.round(bounty.submissionCount / (paidPlaces(bounty) || 1)))} per paid place`);
  setText(view.rewardsTitle, `Rewards · ${paidPlaces(bounty)} paid places`);
  rebuildIfChanged(view, 'skills', bounty.skills, () => view.skills.replaceChildren(...(bounty.skills || []).map((skill) => el('li', { className: 'chip chip-static' }, skill))));
  rebuildIfChanged(view, 'rewards', bounty.rewardsNow || bounty.rewards, () => view.rewards.replaceChildren(...buildRewardRows(bounty)));
  patchDates(view, bounty);
  rebuildIfChanged(view, 'description', bounty.description, () => view.description.replaceChildren(renderMarkdown(bounty.description || bounty.summary || '')));
  if (bounty.rules) rebuildIfChanged(view, 'rules', bounty.rules, () => view.rules.replaceChildren(...buildRulesSections(bounty.rules)));
  view.rulesPanel.hidden = !bounty.rules;
  view.enter.href = `${MAKEFUN_ORIGIN}/bounty/${encodeURIComponent(bounty.slug)}`;
  setText(view.leaderTab, `Leaderboard · ${formatCount(bounty.submissionCount)}`);
  if (view.top5) patchTopFive(view, view.top5);
}

/** The live payout curve, one row per place (consecutive equal places share a row, '4th–10th'): base reward, fee share, pays now. */
function buildRewardRows(bounty) {
  return groupPayoutRows(bounty).map((row) =>
    el(
      'tr',
      { className: row.first <= 3 ? `podium-${row.first}` : '' },
      el('th', { scope: 'row' }, row.first === row.last ? ordinal(row.first) : `${ordinal(row.first)}–${ordinal(row.last)}`),
      el('td', { className: 'num' }, formatUsd(row.base)),
      el('td', { className: 'num fee-share' }, row.feeShare > 0 ? `+ ${formatUsd(row.feeShare.toFixed(2))}` : '—'),
      el('td', { className: 'prize-amount' }, formatUsd(row.total)),
    ),
  );
}

/** The dates as a timeline with a "Now" marker between what has happened and what is next; rebuilt when the minute or the dates change. */
function patchDates(view, bounty) {
  if (!bounty) return;
  const minute = Math.floor(Date.now() / 60_000);
  rebuildIfChanged(view, 'dates', [bounty.opensAt, bounty.deadline, bounty.phases, bounty.resolvedAt, minute], () => view.dates.replaceChildren(buildTimeline(bounty)));
}

/** The phases by name (Development, Final heat, Results), each with its dates and whether it is done, running now or next. */
function buildTimeline(bounty) {
  const phases = bounty.phases?.length ? bounty.phases : [{ title: 'Entries', startsAt: bounty.opensAt || bounty.publishedAt, endsAt: bounty.deadline }];
  const resultsAt = bounty.resolvedAt || phases.at(-1).endsAt;
  const steps = [
    ...phases.map((phase, index) => [index && phases.length > 1 ? `${phase.title} heat` : phase.title, phase.startsAt, index ? phase.endsAt : bounty.deadline || phase.endsAt, index ? 'all final entries judged' : 'entries close at the end']),
    ['Results', resultsAt, null, bounty.resolvedAt ? 'published' : 'published by'],
  ];
  const now = Date.now();
  return el(
    'ol',
    { className: 'timeline' },
    steps.map(([label, from, to, what]) => {
      const state = to ? (new Date(to) <= now ? 'past' : new Date(from) <= now ? 'now' : 'next') : new Date(from) <= now ? 'past' : 'next';
      return el('li', { className: state }, el('b', null, label, state === 'now' && el('em', null, 'now')), el('small', null, what), el('span', null, to ? `${formatShortUtc(from).replace(' UTC', '')} → ${formatShortUtc(to)}` : formatShortUtc(from)));
    }),
  );
}

function patchTopFive(view, board) {
  view.top5 = board;
  const { rows, rankColumn } = normalizeLeaderboardRows(board);
  view.topList.replaceChildren(
    ...rows.slice(0, 5).map((entry) =>
      el(
        'li',
        null,
        el('b', { className: 'top-rank' }, entry.rank),
        avatarImage(absoluteAssetUrl(entry.image), entry.handle, 26),
        el('span', { className: 'top-who' }, entry.handle ? el('a', { href: profileHref(entry.handle) }, `@${entry.handle}`) : 'anonymous'),
        el('span', { className: 'top-record', title: 'wins–draws–losses' }, entry.record ? `${formatWinsDrawsLosses(entry.record)} W–D–L` : ''),
        el('small', { className: 'top-interval' }, entry.interval ? `${formatScore(entry.interval.low, entry.interval.low, rankColumn)} to ${formatScore(entry.interval.high, entry.interval.high, rankColumn)}` : ''),
        el('b', { className: 'top-score' }, formatScore(entry.value, entry.display, rankColumn)),
        el('b', { className: 'top-prize' }, view.bounty ? formatUsd(prizeNow(view.bounty, entry.prizeRank)) : ''),
      ),
    ),
  );
  setText(view.topNote, `of ${formatCount(rows.length)} ranked · ${board.phase?.placements_held ? 'unofficial until results' : 'final'} · prize at today's pot`);
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

/** Rebuild a heavy block only when the data it was built from changed. */
function rebuildIfChanged(view, key, source, build) {
  const signature = JSON.stringify(source ?? null);
  if (view.builtFrom[key] !== signature) build((view.builtFrom[key] = signature));
}

/** "Nov 17, 12:30 UTC": the date without its year, for the compact timeline and card notes. */
const formatShortUtc = (time) => `${new Date(time).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })} UTC`;
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

function bountyStatusLabel(bounty) {
  if (isLive(bounty)) return ['Taking entries', 'live'];
  if (bounty.status === 'resolved' || bounty.resolvedAt) return ['Resolved', 'done'];
  return ['Closed · results pending', 'closed'];
}

function buildRulesSections(rules) {
  return splitMarkdownSections(rules).map(({ title, body }, index) => el('details', { className: 'rules-section', open: index === 0 }, el('summary', null, title || 'Overview'), el('div', { className: 'prose' }, renderMarkdown(body))));
}

function buildBountyLayout(slug) {
  const view = { builtFrom: {}, heading: el('h1', { tabIndex: -1 }), summary: el('p', { className: 'bounty-summary' }), status: el('span', { className: 'status-badge' }), category: el('span', { className: 'tag' }), sponsor: el('span', { className: 'muted small' }) };
  Object.assign(view, { pot: statCard('Live pot', 'stat-pot'), fee: statCard('Entry fee', 'stat-fee'), time: statCard('Time left'), entries: statCard('Entries') });
  Object.assign(view, { skills: el('ul', { className: 'skill-list', 'aria-label': 'Skills' }), rewards: el('tbody'), dates: el('div'), description: el('div', { className: 'prose' }), rules: el('div'), rail: el('div', { className: 'bounty-rail' }) });
  Object.assign(view, { rewardsTitle: el('h2', { className: 'rewards-title' }), topList: el('ol', { className: 'top-list' }), topNote: el('small', { className: 'muted top-note' }, 'Loading the leaderboard…'), leaderTab: el('a', { href: leaderboardHref(slug) }, 'Leaderboard'), enter: el('a', { className: 'button button-primary', target: '_blank', rel: 'noopener' }, 'Enter on make.fun ↗') });
  view.time.value.dataset.urgency = '';
  view.rulesPanel = el('section', { className: 'panel', hidden: true }, el('h2', null, 'Rules'), view.rules);
  const panel = (title, ...body) => el('section', { className: 'panel' }, typeof title === 'string' ? el('h2', null, title) : title, body);
  view.page = el(
    'div',
    { className: 'bounty-page' },
    view.rail,
    el(
      'article',
      { className: 'bounty-detail' },
      el('div', { className: 'bounty-tags' }, view.status, view.category, view.sponsor, el('nav', { className: 'subtabs', 'aria-label': 'Bounty sections' }, el('a', { href: bountyHref(slug), 'aria-current': 'page' }, 'Overview'), view.leaderTab)),
      el('div', { className: 'bounty-title' }, view.heading, view.enter),
      view.summary,
      el('dl', { className: 'stat-row' }, view.pot.node, view.fee.node, view.time.node, view.entries.node),
      el('div', { className: 'bounty-split' }, panel(view.rewardsTitle, el('table', { className: 'rewards-table' }, el('caption', { className: 'visually-hidden' }, 'Rewards by place, live pot'), el('thead', null, el('tr', null, ['Place', 'Base', 'Fee share', 'Pays now'].map((label) => el('th', { scope: 'col' }, label)))), view.rewards)), panel('Dates', view.dates)),
      panel(el('h2', { className: 'top-title' }, 'Top 5 now', view.topNote, el('a', { className: 'small', href: leaderboardHref(slug) }, 'full leaderboard →')), view.topList),
      el('section', { className: 'panel description-panel' }, el('h2', null, 'Description'), view.skills, view.description),
      view.rulesPanel,
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
.bounty-page{display:grid;gap:14px;align-items:start}
@media (min-width:1000px){.bounty-page{grid-template-columns:minmax(440px,520px) minmax(0,1fr)}.bounty-rail{position:sticky;top:8px;max-height:calc(100vh - 80px);overflow:auto}.bounty-rail .btable{border-radius:var(--radius)}}
@media (max-width:999px){.bounty-rail{display:none}}
.bounty-detail{display:grid;gap:9px;min-width:0}
.bounty-tags{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.bounty-tags .subtabs{margin-left:auto}
.bounty-detail .stat{padding:6px 12px}
.bounty-detail .stat-value{font-size:1.35rem}
.bounty-detail .stat-pot .stat-value{font-size:1.6rem}
.bounty-detail .panel{padding:8px 14px}
.bounty-detail .panel h2{margin-bottom:4px}
.description-panel{margin-top:14px}
.top-title{display:flex;align-items:baseline;gap:10px}
.top-note{flex:1;font-weight:500;font-size:.78rem}
.bounty-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.bounty-title .button{flex:none;white-space:nowrap}
.bounty-summary{margin:0;color:var(--muted);font-size:.92rem;line-height:1.4}
.skill-list{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px;padding:0;list-style:none}
.bounty-split{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:10px;align-items:start}
.panel-note{margin:0 0 6px}
.rewards-title small{font-size:.74rem;font-weight:500}
.rewards-table td,.rewards-table th{padding:2px 6px;white-space:nowrap;border-bottom-color:var(--surface-2)}
.rewards-table th{font-weight:700}
.rewards-table thead th{padding:2px 6px 4px;font-size:.66rem;text-align:right}
.rewards-table thead th:first-child{text-align:left}
.fee-share{color:var(--muted)}
.prize-amount{text-align:right;color:var(--money);font-weight:800}
.podium-1>:first-child{color:var(--gold)}
.timeline{list-style:none;margin:0;padding:0 0 0 14px;border-left:2px solid var(--border);display:grid;gap:3px;font-size:.88rem}
.timeline li{position:relative;display:grid;grid-template-columns:auto 1fr;column-gap:8px}
.timeline li>small{text-align:right;color:var(--muted);font-size:.74rem;align-self:center}
.timeline li>span{grid-column:1/-1}
.timeline em{margin-left:6px;padding:0 6px;border-radius:5px;background:var(--accent);color:var(--on-accent);font-size:.66rem;font-style:normal;text-transform:uppercase}
.timeline li::before{content:"";position:absolute;left:-21px;top:6px;width:10px;height:10px;border-radius:50%;background:var(--surface);border:2px solid var(--border)}
.timeline .past::before{background:var(--money);border-color:var(--money)}
.timeline .now::before{background:var(--accent);border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
.timeline .now b{color:var(--accent)}
.timeline span{color:var(--muted);font-variant-numeric:tabular-nums}

.top-list{list-style:none;margin:0;padding:0;display:grid}
.top-list li{display:grid;grid-template-columns:1.6rem 26px minmax(0,1fr) auto auto 3.6rem 4.6rem;align-items:center;gap:10px;padding:6px 0;border-top:1px solid var(--surface-2)}
.top-rank{font-size:1.1rem;text-align:right}
.top-list li:first-child .top-rank{color:var(--gold)}
.top-who{display:flex;align-items:baseline;gap:8px;min-width:0}
.top-who a{font-weight:700}
.top-record{font-weight:700;font-size:.86rem;white-space:nowrap}
.top-interval{color:var(--muted);font-size:.78rem;white-space:nowrap;text-align:right;min-width:7.5rem}
.top-score{text-align:right}
.top-score{font-size:1.05rem}
.top-prize{color:var(--money);text-align:right}
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
@media (max-width:900px){.bounty-split{grid-template-columns:1fr}}
@media (max-width:640px){.bounty-title{flex-wrap:wrap}.top-list li{grid-template-columns:1.4rem 30px minmax(0,1fr) auto auto;gap:8px}.top-prize,.top-interval{display:none}}
`);
