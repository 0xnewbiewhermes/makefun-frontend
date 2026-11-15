// One bounty (#/bounty/<slug>): live pot, entry fee, time left and entries up top, then the rewards table of the live
// pot, its dates and phases, the description and the rules. It paints at once from the board's cached copy when there
// is one, fills in from its own read, and patches the same nodes when a revalidation brings a change.

import { adoptViewStyles, apiPaths, el, entryFeeUsd, formatCount, formatEntryFee, formatUsd, isTakingEntries, leaderboardHref, livePotUsd, MAKEFUN_ORIGIN, peekCached, readCached, revalidateWhileVisible, setText, trackCountdown } from './app.js';
import { renderMarkdown, splitMarkdownSections } from './markdown.js';
import { breadcrumb, formatDateTime, statBlock } from './view-kit.js';

adoptViewStyles(`
.bounty-tags{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px;font-size:.9rem}
.status-badge{padding:2px 10px;border-radius:999px;background:var(--surface-2);font-size:.8rem;font-weight:700}
.status-badge[data-tone=live]{background:var(--money-soft);color:var(--money)}
.status-badge[data-tone=live]::before{content:"● "}
.bounty-summary{max-width:75ch;margin:0 0 8px;color:var(--muted);font-size:1.05rem}
.skill-list{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 16px;padding:0;list-style:none}
.stat-fee[data-paid] .stat-value{color:var(--accent)}
.bounty-actions{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.bounty-columns{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:16px;align-items:start}
.bounty-main,.bounty-aside{display:grid;gap:16px;min-width:0}
.rewards-table td,.rewards-table th{padding:6px 8px;white-space:nowrap}
.rewards-table thead th:last-child,.prize-amount{text-align:right}
.prize-amount{color:var(--money);font-weight:800}
.podium-1>:first-child{color:var(--gold);font-weight:800}
.dates-list{display:grid;grid-template-columns:max-content 1fr;gap:6px 12px;margin:0;font-size:.9rem}
.dates-list dt{color:var(--muted);font-weight:600}
.dates-list dd{margin:0}
.rules-section{padding:8px 0;border-top:1px solid var(--border)}
.rules-section summary{padding:4px 0;font-weight:700;cursor:pointer}
@media (max-width:900px){.bounty-columns{grid-template-columns:1fr}.bounty-aside{order:-1}}
@media (max-width:640px){.dates-list{grid-template-columns:1fr;gap:0}.dates-list dd{margin-bottom:8px}}
`);

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

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

function bountyStatusLabel(bounty) {
  if (isTakingEntries(bounty)) return ['Taking entries', 'live'];
  if (bounty.status === 'resolved' || bounty.resolvedAt) return ['Resolved', 'done'];
  return ['Closed · results pending', 'closed'];
}

function buildRewardsTable(bounty) {
  const rows = groupPayoutRows(bounty);
  const split = rows.some((row) => row.feeShare > 0);
  const th = (label) => el('th', { scope: 'col' }, label);
  return el(
    'table',
    { className: 'rewards-table' },
    el('caption', { className: 'visually-hidden' }, 'Rewards by place, live pot'),
    el('thead', null, el('tr', null, th('Place'), split && [th('Base'), th('Fee share')], th('Prize'))),
    el(
      'tbody',
      null,
      rows.map((row) =>
        el(
          'tr',
          { className: row.first <= 3 ? `podium-${row.first}` : '' },
          el('th', { scope: 'row' }, row.first === row.last ? ordinal(row.first) : `${ordinal(row.first)}–${ordinal(row.last)}`),
          split && [el('td', null, formatUsd(row.base)), el('td', null, `+${formatUsd(row.feeShare.toFixed(2))}`)],
          el('td', { className: 'prize-amount' }, formatUsd(row.total), row.last > row.first && el('span', { className: 'muted' }, ' each')),
        ),
      ),
    ),
  );
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
  const refs = { heading: el('h1', { tabIndex: -1 }), summary: el('p', { className: 'bounty-summary' }), status: el('span', { className: 'status-badge' }), category: el('span', { className: 'tag' }), sponsor: el('span', { className: 'muted' }) };
  const [pot, fee, time, entries] = [statBlock('Live pot', '', 'stat-pot'), statBlock('Entry fee', '', 'stat-fee'), statBlock('Time left', ''), statBlock('Entries', '')];
  Object.assign(refs, { pot: pot.valueNode, feeStat: fee.node, fee: fee.valueNode, timeLeft: time.valueNode, entries: entries.valueNode, potNote: el('span', { className: 'stat-note' }) });
  pot.valueNode.after(refs.potNote);
  Object.assign(refs, { skills: el('ul', { className: 'skill-list', 'aria-label': 'Skills' }), rewards: el('div', { className: 'table-scroll' }), dates: el('div'), description: el('div', { className: 'prose' }), rules: el('div') });
  refs.rulesPanel = el('section', { className: 'panel', hidden: true }, el('h2', null, 'Rules'), refs.rules);
  const panel = (title, body) => el('section', { className: 'panel' }, el('h2', null, title), body);
  refs.page = el(
    'article',
    null,
    breadcrumb(el('span', null, slug)),
    el('header', null, el('div', { className: 'bounty-tags' }, refs.status, refs.category, refs.sponsor), refs.heading, refs.summary, refs.skills),
    el('dl', { className: 'stat-row' }, pot.node, fee.node, time.node, entries.node),
    el('div', { className: 'bounty-actions' }, el('a', { className: 'button button-primary', href: leaderboardHref(slug) }, 'View leaderboard →'), el('a', { className: 'button', href: `${MAKEFUN_ORIGIN}/bounty/${encodeURIComponent(slug)}`, target: '_blank', rel: 'noopener' }, 'Open on make.fun ↗')),
    el('div', { className: 'bounty-columns' }, el('div', { className: 'bounty-main' }, panel('Description', refs.description), refs.rulesPanel), el('aside', { className: 'bounty-aside' }, panel('Rewards', refs.rewards), panel('Dates', refs.dates))),
  );
  return refs;
}

export async function mountBountyView(container, { slug }, route) {
  const refs = buildBountyLayout(slug);
  /** What each heavy block was last built from: a refresh rebuilds a block only when its own data changed. */
  const builtFrom = {};
  const rebuildIfChanged = (key, source, build) => {
    const signature = JSON.stringify(source ?? null);
    if (builtFrom[key] !== signature) build((builtFrom[key] = signature));
  };

  function patchBountyInPlace(bounty) {
    if (!refs.page.isConnected) container.replaceChildren(refs.page);
    document.title = `${bounty.title} · make.fun`;
    const [statusText, tone] = bountyStatusLabel(bounty);
    const fees = livePotUsd(bounty) - Number(bounty.rewardAmount || 0);
    setText(refs.heading, bounty.title);
    setText(refs.summary, bounty.summary || '');
    setText(refs.status, statusText);
    refs.status.dataset.tone = tone;
    setText(refs.category, bounty.category || 'Bounty');
    setText(refs.sponsor, bounty.sponsor?.name ? `by ${bounty.sponsor.name}` : '');
    setText(refs.pot, formatUsd(livePotUsd(bounty)));
    setText(refs.potNote, fees > 0.004 ? `${formatUsd(bounty.rewardAmount)} reward + ${formatUsd(fees.toFixed(2))} in fees` : '');
    setText(refs.fee, formatEntryFee(bounty));
    refs.feeStat.toggleAttribute('data-paid', entryFeeUsd(bounty) > 0);
    if (isTakingEntries(bounty)) trackCountdown(refs.timeLeft, bounty.deadline);
    else setText(refs.timeLeft, 'Closed');
    setText(refs.entries, formatCount(bounty.submissionCount));
    rebuildIfChanged('skills', bounty.skills, () => refs.skills.replaceChildren(...(bounty.skills || []).map((skill) => el('li', { className: 'chip chip-static' }, skill))));
    rebuildIfChanged('rewards', bounty.rewardsNow || bounty.rewards, () => refs.rewards.replaceChildren(buildRewardsTable(bounty)));
    rebuildIfChanged('dates', [bounty.opensAt, bounty.deadline, bounty.phases, bounty.resolvedAt], () => refs.dates.replaceChildren(buildDatesList(bounty)));
    rebuildIfChanged('description', bounty.description, () => refs.description.replaceChildren(renderMarkdown(bounty.description || bounty.summary || '')));
    if (bounty.rules) rebuildIfChanged('rules', bounty.rules, () => refs.rules.replaceChildren(...buildRulesSections(bounty.rules)));
    refs.rulesPanel.hidden = !bounty.rules;
  }

  const fromBoard = peekCached(apiPaths.board())?.items?.find((item) => item.slug === slug);
  if (fromBoard) patchBountyInPlace(fromBoard);
  const onChange = (fresh) => route.isCurrent() && patchBountyInPlace(fresh);
  const bounty = await readCached(apiPaths.bounty({ slug }), onChange);
  if (!route.isCurrent()) return;
  patchBountyInPlace(bounty);
  return revalidateWhileVisible(apiPaths.bounty({ slug }), onChange);
}
