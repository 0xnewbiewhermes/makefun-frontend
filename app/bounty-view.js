// One bounty (#/bounty/<slug>): summary, the key numbers (live pot, entry fee, time left, entries), the rewards table
// of the live pot (rewardsNow: base + fee share per place), its dates and phases, then the description and rules.
// When the board already holds this bounty the page paints from it at once, then fills in from the bounty's own read.

import { boardPath, bountyPath, MAKEFUN_ORIGIN, peekCached, readCached } from './api.js';
import { renderMarkdown, splitMarkdownSections } from './markdown.js';
import { el, entryFeeUsd, formatCount, formatDateTime, formatUsd, isTakingEntries, leaderboardHref, livePotUsd, setText, statBlock, trackCountdown } from './ui.js';

/** The live payout curve as rows; consecutive places paying the same amount share one row ('4–10'). */
export function payoutRows(bounty) {
  const places = Array.isArray(bounty.rewardsNow) && bounty.rewardsNow.length
    ? bounty.rewardsNow.map((r) => ({ place: r.place, base: Number(r.baseUsd), feeShare: Number(r.feeShareUsd || 0), total: Number(r.amountUsd) }))
    : Object.entries(bounty.rewards || {}).map(([place, amount]) => ({ place: Number(place), base: Number(amount), feeShare: 0, total: Number(amount) }));
  places.sort((a, b) => a.place - b.place);
  const rows = [];
  for (const place of places) {
    const previous = rows.at(-1);
    if (previous && previous.total === place.total && previous.base === place.base && previous.last === place.place - 1) previous.last = place.place;
    else rows.push({ ...place, first: place.place, last: place.place });
  }
  return rows;
}

function ordinal(n) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}

function bountyStatusLabel(bounty) {
  if (isTakingEntries(bounty)) return { text: 'Taking entries', tone: 'live' };
  if (bounty.status === 'resolved' || bounty.resolvedAt) return { text: 'Resolved', tone: 'done' };
  return { text: 'Closed · results pending', tone: 'closed' };
}

function buildRewardsTable(bounty) {
  const rows = payoutRows(bounty);
  const hasFeeShare = rows.some((row) => row.feeShare > 0);
  return el(
    'table',
    { className: 'rewards-table' },
    el('caption', { className: 'visually-hidden' }, 'Rewards by place'),
    el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Place'), hasFeeShare && el('th', { scope: 'col' }, 'Base'), hasFeeShare && el('th', { scope: 'col' }, 'Fee share'), el('th', { scope: 'col' }, 'Prize'))),
    el(
      'tbody',
      null,
      rows.map((row) =>
        el(
          'tr',
          { className: row.first <= 3 ? `podium podium-${row.first}` : '' },
          el('th', { scope: 'row' }, row.first === row.last ? ordinal(row.first) : `${ordinal(row.first)}–${ordinal(row.last)}`),
          hasFeeShare && el('td', null, formatUsd(row.base)),
          hasFeeShare && el('td', null, `+${formatUsd(row.feeShare.toFixed(2))}`),
          el('td', { className: 'prize-amount' }, formatUsd(row.total), row.last > row.first && el('span', { className: 'muted' }, ' each')),
        ),
      ),
    ),
  );
}

function buildDatesList(bounty) {
  const items = [
    ['Opens', bounty.opensAt || bounty.publishedAt],
    ['Deadline', bounty.deadline],
    ...(bounty.phases || []).flatMap((phase) => [[`${phase.title} phase`, phase.startsAt && phase.endsAt ? `${formatDateTime(phase.startsAt)} → ${formatDateTime(phase.endsAt)}` : null, true]]),
    ['Resolved', bounty.resolvedAt],
  ].filter(([, value]) => value);
  return el('dl', { className: 'dates-list' }, items.flatMap(([label, value, preformatted]) => [el('dt', null, label), el('dd', null, preformatted ? value : formatDateTime(value))]));
}

function buildRulesSections(rules) {
  return splitMarkdownSections(rules).map(({ title, body }, index) =>
    el('details', { className: 'rules-section', open: index === 0 }, el('summary', null, title || 'Overview'), el('div', { className: 'prose' }, renderMarkdown(body))),
  );
}

export async function mountBountyView(container, { slug }, route) {
  const fromBoard = peekCached(boardPath())?.items?.find((item) => item.slug === slug);
  const refs = {};
  let renderedText = { description: null, rules: null, rewards: null, dates: null };

  function ensureLayout() {
    if (refs.page) return;
    refs.heading = el('h1', { tabIndex: -1 });
    refs.summary = el('p', { className: 'bounty-summary' });
    refs.status = el('span', { className: 'status-badge' });
    refs.category = el('span', { className: 'tag' });
    refs.sponsor = el('span', { className: 'muted' });
    refs.skills = el('ul', { className: 'skill-list', 'aria-label': 'Skills' });
    const pot = statBlock('Live pot', '', 'stat-pot');
    const fee = statBlock('Entry fee', '');
    const time = statBlock('Time left', '');
    const entries = statBlock('Entries', '');
    Object.assign(refs, { pot: pot.valueNode, fee: fee.valueNode, timeLeft: time.valueNode, entries: entries.valueNode, potNote: el('span', { className: 'stat-note' }) });
    pot.valueNode.after(refs.potNote);
    refs.rewards = el('div', { className: 'table-scroll' });
    refs.dates = el('div');
    refs.description = el('div', { className: 'prose' });
    refs.rules = el('div', { className: 'rules' });
    refs.rulesPanel = el('section', { className: 'panel', hidden: true, 'aria-labelledby': 'rules-heading' }, el('h2', { id: 'rules-heading' }, 'Rules'), refs.rules);
    refs.page = el(
      'article',
      { className: 'bounty-view' },
      el('nav', { className: 'breadcrumb', 'aria-label': 'Breadcrumb' }, el('a', { href: '#/' }, 'Bounties'), ' / ', el('span', null, slug)),
      el('header', { className: 'bounty-header' }, el('div', { className: 'bounty-tags' }, refs.status, refs.category, refs.sponsor), refs.heading, refs.summary, refs.skills),
      el('dl', { className: 'stat-row', 'data-deadline-scope': '' }, pot.node, fee.node, time.node, entries.node),
      el(
        'div',
        { className: 'bounty-actions' },
        el('a', { className: 'button button-primary', href: leaderboardHref(slug) }, 'View leaderboard →'),
        el('a', { className: 'button', href: `${MAKEFUN_ORIGIN}/bounty/${encodeURIComponent(slug)}`, target: '_blank', rel: 'noopener' }, 'Open on make.fun ↗'),
      ),
      el(
        'div',
        { className: 'bounty-columns' },
        el('div', { className: 'bounty-main' }, el('section', { className: 'panel', 'aria-labelledby': 'description-heading' }, el('h2', { id: 'description-heading' }, 'Description'), refs.description), refs.rulesPanel),
        el(
          'aside',
          { className: 'bounty-aside' },
          el('section', { className: 'panel', 'aria-labelledby': 'rewards-heading' }, el('h2', { id: 'rewards-heading' }, 'Rewards'), refs.rewards),
          el('section', { className: 'panel', 'aria-labelledby': 'dates-heading' }, el('h2', { id: 'dates-heading' }, 'Dates'), refs.dates),
        ),
      ),
    );
    container.replaceChildren(refs.page);
  }

  function applyBountyData(bounty) {
    ensureLayout();
    document.title = `${bounty.title} · make.fun`;
    const status = bountyStatusLabel(bounty);
    const fees = livePotUsd(bounty) - Number(bounty.rewardAmount || 0);
    setText(refs.heading, bounty.title);
    setText(refs.summary, bounty.summary || '');
    setText(refs.status, status.text);
    refs.status.dataset.tone = status.tone;
    setText(refs.category, bounty.category || 'Bounty');
    setText(refs.sponsor, bounty.sponsor?.name ? `by ${bounty.sponsor.name}` : '');
    refs.skills.replaceChildren(...(bounty.skills || []).map((skill) => el('li', { className: 'chip chip-static' }, skill)));
    setText(refs.pot, formatUsd(livePotUsd(bounty)));
    setText(refs.potNote, fees > 0.004 ? `${formatUsd(bounty.rewardAmount)} reward + ${formatUsd(fees.toFixed(2))} fees` : '');
    setText(refs.fee, entryFeeUsd(bounty) > 0 ? formatUsd(bounty.entryFeeUsd) : 'Free');
    if (isTakingEntries(bounty)) trackCountdown(refs.timeLeft, bounty.deadline);
    else setText(refs.timeLeft, 'Closed');
    setText(refs.entries, formatCount(bounty.submissionCount));

    const rewardsKey = JSON.stringify(bounty.rewardsNow || bounty.rewards || null);
    if (rewardsKey !== renderedText.rewards) {
      renderedText.rewards = rewardsKey;
      refs.rewards.replaceChildren(buildRewardsTable(bounty));
    }
    const datesKey = JSON.stringify([bounty.opensAt, bounty.deadline, bounty.phases, bounty.resolvedAt]);
    if (datesKey !== renderedText.dates) {
      renderedText.dates = datesKey;
      refs.dates.replaceChildren(buildDatesList(bounty));
    }
    if (bounty.description !== renderedText.description) {
      renderedText.description = bounty.description;
      refs.description.replaceChildren(renderMarkdown(bounty.description || bounty.summary || ''));
    }
    if (bounty.rules && bounty.rules !== renderedText.rules) {
      renderedText.rules = bounty.rules;
      refs.rules.replaceChildren(...buildRulesSections(bounty.rules));
      refs.rulesPanel.hidden = false;
    }
  }

  if (fromBoard) applyBountyData(fromBoard);
  const bounty = await readCached(bountyPath(slug), (fresh) => route.isCurrent() && applyBountyData(fresh));
  if (!route.isCurrent()) return;
  applyBountyData(bounty);
}
