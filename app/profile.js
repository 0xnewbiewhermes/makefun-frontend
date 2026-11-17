// An account's public profile (#/u/<handle>): avatar, name, bio and links, four summary cards (prize money, bounties won,
// ranked in, best place) over its entries, SOLUTIONS_PAGE_SIZE at a time ("Show more" appends, it never rebuilds the
// table); and #/u, the profile finder: a handle box and the entrants leading the biggest live leaderboard.

import { absoluteAssetUrl, adoptViewStyles, apiPaths, avatarImage, bountyHref, el, formatDate, formatDateTime, formatScore, formatUsd, isLive, leaderboardHref, normalizeLeaderboardRows, profileHref, readCached, statCard } from './app.js';

export async function mountProfileView(root, { handle }, route) {
  const profile = await readCached(apiPaths.profile({ handle }));
  if (!route.isCurrent()) return;
  document.title = `@${profile.handle} · make.fun`;
  const record = profile.record || {};
  // Prizes and places first, then the rest in the API's order (newest first).
  const solutions = (profile.solutions || []).map((solution, index) => ({ solution, index })).sort((a, b) => Number(b.solution.prize_usd || 0) - Number(a.solution.prize_usd || 0) || (a.solution.placement || 1e9) - (b.solution.placement || 1e9) || a.index - b.index).map(({ solution }) => solution);
  const solutionsBody = el('tbody');
  const moreButton = el('button', { type: 'button', className: 'button show-more', onclick: () => appendNextPageOfEntries(solutionsBody, solutions, moreButton) }, 'Show more entries');

  const cards = [statCard('Prize money', 'stat-pot'), statCard('Bounties won'), statCard('Ranked in'), statCard('Best place')];
  const fill = (card, value, note) => ((card.value.textContent = value), (card.note.textContent = note));
  fill(cards[0], formatUsd(record.prize_usd || 0), `${record.podium_finishes ?? 0} podium finishes`);
  fill(cards[1], record.competitions_won ?? 0, `of ${record.competitions_entered ?? 0} entered`);
  fill(cards[2], record.competitions_placed ?? 0, 'bounties placed');
  fill(cards[3], record.best_placement ? `#${record.best_placement}` : '—', 'best final place');
  const identity = [`@${profile.handle}`, profile.house && 'house account', profile.joined_at && `joined ${formatDate(profile.joined_at)}`].filter(Boolean).join(' · ');
  const links = profileLinks(profile).map(([label, href, text]) => el('li', null, el('span', { className: 'muted' }, `${label} `), el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text)));
  const headings = ['Bounty', 'Entry', 'Score', 'Place', 'Prize', 'Entered'].map((label, index) => el('th', { scope: 'col', className: ['', 'col-title', 'col-sc', '', 'col-prize', 'col-received'][index] }, label));
  root.replaceChildren(
    el(
      'article',
      null,
      el('header', { className: 'profile-header' }, avatarImage(absoluteAssetUrl(profile.avatar?.url || profile.image), profile.handle, 72), el('div', { className: 'profile-identity' }, el('h1', { tabIndex: -1 }, profile.display_name || `@${profile.handle}`), el('p', { className: 'muted' }, identity), profile.bio && el('p', { className: 'profile-bio' }, profile.bio), el('ul', { className: 'profile-links' }, links))),
      el('dl', { className: 'stat-row profile-stats' }, cards.map((card) => card.node)),
      el(
        'section',
        { className: 'panel' },
        el('h2', null, 'Results ', el('span', { className: 'muted' }, `(${solutions.length} entries · prizes and places first)`)),
        el('div', { className: 'table-scroll' }, el('table', { className: 'solutions-table' }, el('thead', null, el('tr', null, headings)), solutionsBody)),
        !solutions.length && el('p', { className: 'empty-state' }, 'No public entries yet.'),
        moreButton,
      ),
    ),
  );
  appendNextPageOfEntries(solutionsBody, solutions, moreButton);
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
  const board = await readCached(apiPaths.board());
  const target = board.items.filter(isLive).sort((a, b) => b.submissionCount - a.submissionCount)[0];
  if (!target || !route.isCurrent()) return;
  const { rows } = normalizeLeaderboardRows(await readCached(apiPaths.leaderboard({ slug: target.slug })));
  if (!route.isCurrent()) return;
  heading.textContent = `Leading ${target.title}`;
  list.replaceChildren(...rows.filter((row) => row.handle && !row.house).slice(0, 12).map((row) => el('li', null, avatarImage(absoluteAssetUrl(row.image), row.handle, 36), el('span', { className: 'who' }, el('a', { href: profileHref(row.handle) }, `@${row.handle}`), el('small', { className: 'muted' }, `#${row.rank} · ${row.title || ''}`)))));
  heading.append(' ', el('a', { className: 'small', href: leaderboardHref(target.slug) }, 'leaderboard →'));
}

/** Append the next SOLUTIONS_PAGE_SIZE entries to the table; rows already shown are left alone. */
function appendNextPageOfEntries(tbody, list, more) {
  const shown = tbody.children.length;
  tbody.append(...list.slice(shown, shown + SOLUTIONS_PAGE_SIZE).map(buildSolutionRow));
  more.hidden = tbody.children.length >= list.length;
}

const SOLUTIONS_PAGE_SIZE = 25;

function profileLinks(profile) {
  const links = [];
  if (profile.github_login) links.push(['GitHub', `https://github.com/${encodeURIComponent(profile.github_login)}`, profile.github_login]);
  if (profile.x?.url) links.push(['X', profile.x.url, `@${profile.x.username}`]);
  if (profile.discord?.url) links.push(['Discord', profile.discord.url, profile.discord.global_name || profile.discord.username]);
  if (profile.wallet?.explorer_url) links.push(['Wallet', profile.wallet.explorer_url, `${profile.wallet.address.slice(0, 4)}…${profile.wallet.address.slice(-4)}`]);
  return links.filter(([, href]) => /^https:\/\//.test(href));
}

function buildSolutionRow(solution) {
  const competition = solution.competition || {};
  const score = solution.score;
  return el(
    'tr',
    null,
    el('td', null, competition.slug ? el('a', { href: bountyHref(competition.slug) }, competition.title || competition.slug) : '—', el('div', { className: 'muted small' }, [competition.category, competition.status].filter(Boolean).join(' · '))),
    el('td', { className: 'col-title' }, solution.title || ''),
    el('td', { className: 'col-sc' }, score ? formatScore(score.value, score.display, score.column) : '—', score?.column?.title && el('div', { className: 'muted small score-column' }, score.column.title)),
    el('td', { className: solution.placement && solution.placement <= 3 ? 'place top' : 'place' }, solution.placement ? `#${solution.placement}` : '—'),
    el('td', { className: solution.prize_usd ? 'col-prize prize' : 'col-prize' }, solution.prize_usd ? formatUsd(solution.prize_usd) : '—'),
    el('td', { className: 'col-received' }, solution.entered_at ? formatDateTime(solution.entered_at) : '', competition.slug && el('div', null, el('a', { className: 'small', href: leaderboardHref(competition.slug) }, 'Leaderboard'))),
  );
}

adoptViewStyles(`
.profile-header{display:flex;gap:16px;align-items:center;margin-bottom:12px}
.profile-identity{min-width:0}
.profile-identity h1{margin-bottom:2px;overflow-wrap:anywhere}
.profile-identity p{margin:2px 0}
.profile-bio{max-width:70ch}
.profile-links{display:flex;flex-wrap:wrap;gap:4px 16px;margin:4px 0 0;padding:0;list-style:none;font-size:.9rem}
.solutions-table .col-sc{font-weight:800;white-space:nowrap}
.solutions-table .prize{color:var(--money);font-weight:800}
.solutions-table .place{font-weight:800}
.solutions-table .place.top{color:var(--gold)}
.solutions-table .col-prize{white-space:nowrap}
.show-more{margin-top:12px}
.profile-search{display:flex;gap:8px;margin:12px 0;max-width:460px}
.profile-search .input{flex:1}
.finder-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px 16px}
.finder-list li{display:flex;align-items:center;gap:10px;min-width:0}
.finder-list .who{display:grid;min-width:0}
.finder-list small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media (max-width:640px){.profile-header{gap:12px}.profile-header .avatar{--avatar-size:56px!important;width:56px;height:56px}.solutions-table .col-title,.solutions-table .col-received,.score-column{display:none}.solutions-table td:first-child{min-width:7rem}.solutions-table th,.solutions-table td{padding:7px 5px}}
`);
