// An account's public profile (#/u/<handle>): avatar, name, bio and links, its record (prize money, entered, placed,
// won) and its entries, SOLUTIONS_PAGE_SIZE at a time: "Show more" appends the next rows, it never rebuilds the table.

import { absoluteAssetUrl, adoptViewStyles, apiPaths, avatarImage, bountyHref, breadcrumb, el, formatDate, formatDateTime, formatScore, formatUsd, leaderboardHref, readCached, statBlock } from './app.js';

export async function mountProfileView(root, { handle }, route) {
  const profile = await readCached(apiPaths.profile({ handle }));
  if (!route.isCurrent()) return;
  document.title = `@${profile.handle} · make.fun`;
  const record = profile.record || {};
  const solutions = profile.solutions || [];
  const solutionsBody = el('tbody');
  const moreButton = el('button', { type: 'button', className: 'button show-more', onclick: () => appendNextSolutions(solutionsBody, solutions, moreButton) }, 'Show more entries');

  const stats = [
    statBlock('Prize money', formatUsd(record.prize_usd || 0), 'stat-pot'),
    statBlock('Entered', record.competitions_entered ?? 0),
    statBlock('Placed', record.competitions_placed ?? 0),
    statBlock('Won', record.competitions_won ?? 0),
    statBlock('Podiums', record.podium_finishes ?? 0),
    statBlock('Best place', record.best_placement ? `#${record.best_placement}` : '—'),
  ];
  const identity = [`@${profile.handle}`, profile.house && 'house account', profile.joined_at && `joined ${formatDate(profile.joined_at)}`].filter(Boolean).join(' · ');
  const links = profileLinks(profile).map(([label, href, text]) => el('li', null, el('span', { className: 'muted' }, `${label} `), el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text)));
  const headings = ['Bounty', 'Entry', 'Score', 'Place', 'Prize', 'Entered'].map((label, index) => el('th', { scope: 'col', className: ['', 'col-title', '', '', '', 'col-received'][index] }, label));
  root.replaceChildren(
    el(
      'article',
      null,
      breadcrumb(el('span', null, `@${profile.handle}`)),
      el('header', { className: 'profile-header' }, avatarImage(absoluteAssetUrl(profile.avatar?.url || profile.image), profile.handle, 96), el('div', { className: 'profile-identity' }, el('h1', { tabIndex: -1 }, profile.display_name || `@${profile.handle}`), el('p', { className: 'muted' }, identity), profile.bio && el('p', { className: 'profile-bio' }, profile.bio), el('ul', { className: 'profile-links' }, links))),
      el('dl', { className: 'stat-row profile-stats' }, stats.map((stat) => stat.node)),
      el(
        'section',
        { className: 'panel' },
        el('h2', null, 'Entries ', el('span', { className: 'muted' }, `(${solutions.length})`)),
        el('div', { className: 'table-scroll' }, el('table', { className: 'solutions-table' }, el('thead', null, el('tr', null, headings)), solutionsBody)),
        !solutions.length && el('p', { className: 'empty-state' }, 'No public entries yet.'),
        moreButton,
      ),
    ),
  );
  appendNextSolutions(solutionsBody, solutions, moreButton);
}

/** Append the next SOLUTIONS_PAGE_SIZE entries to the table; rows already shown are left alone. */
function appendNextSolutions(tbody, solutions, more) {
  const shown = tbody.children.length;
  tbody.append(...solutions.slice(shown, shown + SOLUTIONS_PAGE_SIZE).map(buildSolutionRow));
  more.hidden = tbody.children.length >= solutions.length;
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
    el('td', { className: 'col-score' }, score ? formatScore(score.value, score.display, score.column) : '—', score?.column?.title && el('div', { className: 'muted small score-column' }, score.column.title)),
    el('td', null, solution.placement ? `#${solution.placement}` : '—'),
    el('td', { className: solution.prize_usd ? 'prize' : '' }, solution.prize_usd ? formatUsd(solution.prize_usd) : '—'),
    el('td', { className: 'col-received' }, solution.entered_at ? formatDateTime(solution.entered_at) : '', competition.slug && el('div', null, el('a', { className: 'small', href: leaderboardHref(competition.slug) }, 'Leaderboard'))),
  );
}

adoptViewStyles(`
.profile-header{display:flex;gap:20px;align-items:flex-start;margin-bottom:20px}
.profile-identity{min-width:0}
.profile-identity h1{margin-bottom:2px;overflow-wrap:anywhere}
.profile-bio{max-width:70ch;margin:8px 0}
.profile-links{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0;padding:0;list-style:none;font-size:.9rem}
.solutions-table .col-score{font-weight:800;white-space:nowrap}
.solutions-table .prize{color:var(--money);font-weight:800}
.show-more{margin-top:12px}
@media (max-width:640px){.profile-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.profile-header{gap:14px}.profile-header .avatar{--avatar-size:64px!important;width:64px;height:64px}.solutions-table .col-title,.solutions-table .col-received,.score-column{display:none}.solutions-table td:first-child{min-width:9rem}}
`);
