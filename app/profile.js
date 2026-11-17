// An account's public profile (#/u/<handle>), one request: avatar, name, bio, links and the last payout, six summary
// cards (prize money, bounties entered, placed, paid places, first places, best place), then "Entries by bounty": one
// small card per bounty (title, status, date, pot) listing this account's entries in it (place, title, score, prize),
// in two columns on a desktop, BOUNTY_CARDS_PAGE_SIZE at a time ("Show all" appends), filtered in place by chips;
// and #/u, the profile finder: a handle box and the entrants leading the biggest live leaderboard.

import { absoluteAssetUrl, adoptViewStyles, apiPaths, avatarImage, bountyHref, el, formatCount, formatDate, formatScore, formatUsd, isLive, leaderboardHref, normalizeLeaderboardRows, profileHref, readCachedEtag, setText, statCard } from './app.js';

export async function mountProfileView(root, { handle }, route) {
  const profile = await readCachedEtag(apiPaths.profile({ handle }));
  if (!route.isCurrent()) return;
  document.title = `@${profile.handle} · make.fun`;
  const record = profile.record || {};
  const solutions = profile.solutions || [];
  const groups = groupEntriesByBounty(solutions);
  const paid = solutions.filter((solution) => Number(solution.prize_usd) > 0);
  const payouts = (profile.payouts || []).filter((payout) => Number(payout.amount_usd) > 0);
  const cards = [statCard('Prize money', 'stat-pot'), statCard('Bounties entered'), statCard('Placed'), statCard('Paid places', 'stat-paid'), statCard('First places', 'stat-gold'), statCard('Best place')];
  const patchCardInPlace = (card, value, note) => {
    setText(card.value, String(value));
    setText(card.note, note);
  };
  patchCardInPlace(cards[0], formatUsd(record.prize_usd || 0), payouts.length ? `${payouts.length} payout${payouts.length === 1 ? '' : 's'} on Solana` : 'no payouts yet');
  patchCardInPlace(cards[1], formatCount(record.competitions_entered ?? groups.length), `${formatCount(solutions.length)} entries in all`);
  patchCardInPlace(cards[2], formatCount(record.competitions_placed ?? 0), 'with a final place');
  patchCardInPlace(cards[3], formatCount(paid.length), 'entries paid a prize');
  patchCardInPlace(cards[4], formatCount(record.competitions_won ?? 0), `${record.podium_finishes ?? 0} top-3 finishes`);
  patchCardInPlace(cards[5], record.best_placement ? `#${formatCount(record.best_placement)}` : '—', 'best final place');
  const identity = [profile.display_name && `@${profile.handle}`, profile.house && 'house account', profile.joined_at && `joined ${formatDate(profile.joined_at)}`].filter(Boolean).join(' · ');
  const links = profileLinks(profile).map(([label, href, text]) => el('li', null, el('span', { className: 'muted' }, `${label} `), el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text)));
  const grid = el('div', { className: 'bounty-cards' });
  const more = el('button', { type: 'button', className: 'button show-more' });
  const filter = { key: 'all', shown: BOUNTY_CARDS_PAGE_SIZE };
  const chips = el('div', { className: 'pf-chips', role: 'group', 'aria-label': 'Show' }, PROFILE_FILTERS.map(([key, label]) => el('button', { type: 'button', className: 'chip', dataset: { key } }, label, el('span', { className: 'chip-count' }, groups.filter(FILTER_TESTS[key]).length))));
  /** Chips and "Show all" hide or reveal the same cards; a card is built the first time it shows, never rebuilt. */
  const filterBountyCardsInPlace = () => {
    const shown = groups.filter(FILTER_TESTS[filter.key]).slice(0, filter.shown);
    const visible = new Set(shown);
    for (const group of shown) if (!group.node) grid.append((group.node = buildBountyCard(group)));
    for (const group of groups) if (group.node) group.node.hidden = !visible.has(group);
    for (const chip of chips.children) chip.setAttribute('aria-pressed', String(chip.dataset.key === filter.key));
    const total = groups.filter(FILTER_TESTS[filter.key]).length;
    more.hidden = total <= shown.length;
    setText(more, `Show all ${total} bounties`);
  };
  chips.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-key]');
    if (chip) (filter.key = chip.dataset.key), filterBountyCardsInPlace();
  });
  more.addEventListener('click', () => ((filter.shown = Infinity), filterBountyCardsInPlace()));
  root.replaceChildren(
    el(
      'article',
      { className: 'profile-page' },
      el(
        'header',
        { className: 'profile-header' },
        avatarImage(absoluteAssetUrl(profile.avatar?.url || profile.image), profile.handle, 72),
        el('div', { className: 'profile-identity' }, el('h1', { tabIndex: -1 }, profile.display_name || `@${profile.handle}`), identity && el('p', { className: 'muted' }, identity), profile.bio && el('p', { className: 'profile-bio' }, profile.bio), links.length > 0 && el('ul', { className: 'profile-links' }, links)),
        payouts[0] && buildLastPayout(payouts[0]),
      ),
      el('dl', { className: 'stat-row profile-stats' }, cards.map((card) => card.node)),
      el('div', { className: 'pf-heading' }, el('h2', null, 'Entries by bounty ', el('span', { className: 'muted' }, `${formatCount(solutions.length)} entries in ${formatCount(groups.length)} bounties · prizes and places first`)), chips),
      grid,
      !groups.length && el('p', { className: 'empty-state' }, 'No public entries yet.'),
      more,
    ),
  );
  filterBountyCardsInPlace();
}

function buildLastPayout(payout) {
  const explorer = /^https:\/\//.test(payout.explorer_url || '') ? el('a', { href: payout.explorer_url, target: '_blank', rel: 'noopener noreferrer' }, 'on-chain ↗') : null;
  return el('div', { className: 'last-payout' }, el('span', { className: 'muted small' }, 'Last payout'), el('b', null, formatUsd(payout.amount_usd)), el('span', { className: 'small' }, `place ${payout.place} · ${payout.competition?.title || ''}`), el('span', { className: 'muted small' }, formatDate(payout.paid_at), explorer && ' · ', explorer));
}

/** Group the entries by bounty: prizes first, then the best place, then the newest. */
function groupEntriesByBounty(solutions) {
  const bySlug = new Map();
  for (const solution of solutions) {
    const competition = solution.competition || {};
    const key = competition.slug || solution.submission_id;
    if (!bySlug.has(key)) bySlug.set(key, { competition, entries: [] });
    bySlug.get(key).entries.push(solution);
  }
  const groups = [...bySlug.values()];
  for (const group of groups) {
    group.entries.sort((a, b) => (a.placement || 1e9) - (b.placement || 1e9) || new Date(b.entered_at) - new Date(a.entered_at));
    group.prize = group.entries.reduce((sum, entry) => sum + Number(entry.prize_usd || 0), 0);
    group.best = group.entries[0].placement || 1e9;
  }
  return groups.sort((a, b) => b.prize - a.prize || a.best - b.best || new Date(b.competition.deadline || 0) - new Date(a.competition.deadline || 0));
}

const PROFILE_FILTERS = [['all', 'All'], ['paid', 'Won a prize'], ['placed', 'Placed'], ['live', 'Live now']];
const FILTER_TESTS = { all: () => true, paid: (group) => group.prize > 0, placed: (group) => group.best < 1e9, live: (group) => isLive(group.competition) };
const BOUNTY_CARDS_PAGE_SIZE = 12;

/** One bounty as a small card: title, status and date, pot, then each entry: place, title, score, prize. */
function buildBountyCard({ competition, entries, prize }) {
  const live = Boolean(competition.deadline) && isLive(competition);
  const pot = Number(competition.pot_usd || competition.reward_usd || 0);
  const entryRow = (entry) => el('li', null, el('b', { className: entry.placement && entry.placement <= 3 ? 'bc-place top' : 'bc-place' }, entry.placement ? `#${formatCount(entry.placement)}` : '—'), el('span', { className: 'bc-title' }, entry.title || 'Untitled entry'), el('span', { className: 'bc-score' }, entry.score ? formatScore(entry.score.value, entry.score.display, entry.score.column) : '—'), el('b', { className: Number(entry.prize_usd) > 0 ? 'bc-prize' : 'bc-prize none' }, Number(entry.prize_usd) > 0 ? formatUsd(entry.prize_usd) : '—'));
  return el(
    'section',
    { className: `bounty-card${prize ? ' won' : ''}` },
    el('h3', null, competition.slug ? el('a', { href: bountyHref(competition.slug) }, competition.title || competition.slug) : competition.title || 'Bounty'),
    el('p', { className: 'bc-meta' }, el('span', { className: 'status-badge', dataset: { tone: live ? 'live' : 'done' } }, live ? 'Live' : competition.refunded ? 'Refunded' : 'Ended'), `${live ? 'closes ' : ''}${formatDate(competition.deadline)}`, pot > 0 && el('b', { className: 'bc-reward' }, `${formatUsd(pot)} pot`), competition.category && el('span', { className: 'tag' }, competition.category), competition.slug && el('a', { className: 'bc-lb', href: leaderboardHref(competition.slug) }, 'leaderboard →')),
    el('ol', { className: 'bc-entries' }, entries.map(entryRow)),
  );
}

/** #/u: find a profile by handle, and jump to the entrants leading the most-entered live bounty. */
export async function mountProfilesView(root, _params, route) {
  document.title = 'Profiles · make.fun';
  const input = el('input', { className: 'input', name: 'handle', 'aria-label': 'Find a profile by handle', placeholder: '@handle', autocomplete: 'off', spellcheck: 'false' });
  const form = el('form', { className: 'profile-search', role: 'search' }, input, el('button', { type: 'submit', className: 'button button-primary' }, 'Open profile'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const handle = input.value.trim().replace(/^@/, '');
    if (handle) location.hash = profileHref(handle);
  });
  const list = el('ul', { className: 'finder-list' });
  const heading = el('h2', null, 'Leading entrants');
  root.replaceChildren(el('section', null, el('h1', { tabIndex: -1 }, 'Profiles'), el('p', { className: 'muted' }, 'Open any account by handle: prize money, bounties won, places and every entry.'), form, el('section', { className: 'panel' }, heading, list)));
  const board = await readCachedEtag(apiPaths.board());
  const target = board.items.filter(isLive).sort((a, b) => b.submissionCount - a.submissionCount)[0];
  if (!target || !route.isCurrent()) return;
  const { rows } = normalizeLeaderboardRows(await readCachedEtag(apiPaths.leaderboard({ slug: target.slug })));
  if (!route.isCurrent()) return;
  heading.textContent = `Leading ${target.title}`;
  list.replaceChildren(...rows.filter((row) => row.handle && !row.house).slice(0, 12).map((row) => el('li', null, avatarImage(absoluteAssetUrl(row.image), row.handle, 36), el('span', { className: 'who' }, el('a', { href: profileHref(row.handle) }, `@${row.handle}`), el('small', { className: 'muted' }, `#${row.rank} · ${row.title || ''}`)))));
  heading.append(' ', el('a', { className: 'small', href: leaderboardHref(target.slug) }, 'leaderboard →'));
}

function profileLinks(profile) {
  const links = [];
  if (profile.github_login) links.push(['GitHub', `https://github.com/${encodeURIComponent(profile.github_login)}`, profile.github_login]);
  if (profile.x?.url) links.push(['X', profile.x.url, `@${profile.x.username}`]);
  if (profile.discord?.url) links.push(['Discord', profile.discord.url, profile.discord.global_name || profile.discord.username]);
  if (profile.wallet?.explorer_url) links.push(['Wallet', profile.wallet.explorer_url, `${profile.wallet.address.slice(0, 4)}…${profile.wallet.address.slice(-4)}`]);
  return links.filter(([, href]) => /^https:\/\//.test(href));
}

adoptViewStyles(`
.profile-header{display:flex;gap:16px;align-items:center;margin-bottom:10px}
.profile-identity{min-width:0;flex:1}
.profile-identity h1{margin-bottom:2px;overflow-wrap:anywhere}
.profile-identity p{margin:2px 0}
.profile-bio{max-width:70ch}
.profile-links{display:flex;flex-wrap:wrap;gap:4px 16px;margin:4px 0 0;padding:0;list-style:none;font-size:.9rem}
.last-payout{display:grid;gap:1px;max-width:320px;padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius);background:var(--money-soft)}
.last-payout b{color:var(--money);font-size:1.3rem}
.profile-stats{grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-bottom:10px}
.profile-stats .stat{padding:6px 12px}
.stat-gold .stat-value{color:var(--gold)}
.stat-paid .stat-value{color:var(--money)}
.pf-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px;margin:0 0 8px}
.pf-heading h2{font-size:1.05rem}
.pf-heading h2 span{font-size:.85rem;font-weight:500}
.pf-chips{display:flex;flex-wrap:wrap;gap:5px}
.pf-chips .chip{min-height:28px;font-size:.8rem}
.bounty-cards{columns:2 320px;column-gap:10px}
.bounty-card{break-inside:avoid;margin:0 0 10px;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
.bounty-card.won{box-shadow:inset 4px 0 var(--money)}
.bounty-card h3{margin:0;font-size:.95rem;line-height:1.3}
.bounty-card h3 a{color:var(--text);text-decoration:none}
.bounty-card h3 a:hover{text-decoration:underline}
.bc-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:3px 0 4px;color:var(--muted);font-size:.78rem}
.bc-meta .status-badge{font-size:.7rem;padding:0 8px}
.bc-reward{color:var(--money)}
.bc-lb{margin-left:auto}
.bc-entries{list-style:none;margin:0;padding:0}
.bc-entries li{display:grid;grid-template-columns:3.4rem minmax(0,1fr) auto 4.4rem;align-items:baseline;gap:8px;padding:3px 0;border-top:1px solid var(--surface-2);font-size:.84rem;font-variant-numeric:tabular-nums}
.bc-place{text-align:right}
.bc-place.top{color:var(--gold)}
.bc-title{color:var(--muted);line-height:1.3}
.bc-score{font-weight:700;white-space:nowrap}
.bc-prize{text-align:right;color:var(--money);white-space:nowrap}
.bc-prize.none{color:var(--muted);font-weight:500}
.show-more{margin-top:4px}
.profile-search{display:flex;gap:8px;margin:12px 0;max-width:460px}
.profile-search .input{flex:1}
.finder-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px 16px}
.finder-list li{display:flex;align-items:center;gap:10px;min-width:0}
.finder-list .who{display:grid;min-width:0}
.finder-list small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media (max-width:900px){.profile-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.profile-header{flex-wrap:wrap}.last-payout{max-width:none;flex:1 1 100%}}
@media (max-width:640px){.profile-header{gap:12px}.profile-header .avatar{--avatar-size:56px!important;width:56px;height:56px}.profile-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.bc-entries li{grid-template-columns:3rem minmax(0,1fr) auto}.bc-score{display:none}}
`);
