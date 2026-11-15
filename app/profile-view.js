// An account's public profile (#/u/<handle>): avatar, name, bio and links, its record (entered, placed, won, prize
// money) and its entries, each linking to its bounty and that bounty's leaderboard.

import { absoluteAssetUrl, profilePath, readCached } from './api.js';
import { avatarImage, bountyHref, el, formatDate, formatDateTime, formatScore, formatUsd, leaderboardHref, setText, statBlock } from './ui.js';

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
  const placement = solution.placement ? `#${solution.placement}` : '—';
  return el(
    'tr',
    null,
    el('td', null, competition.slug ? el('a', { href: bountyHref(competition.slug) }, competition.title || competition.slug) : '—', el('div', { className: 'muted small' }, competition.category || '', competition.status ? ` · ${competition.status}` : '')),
    el('td', { className: 'col-title' }, solution.title || ''),
    el('td', { className: 'col-score' }, solution.score ? formatScore(solution.score.value, solution.score.display, solution.score.column) : '—', solution.score?.column?.title && el('div', { className: 'muted small' }, solution.score.column.title)),
    el('td', null, placement),
    el('td', null, solution.prize_usd ? formatUsd(solution.prize_usd) : '—'),
    el('td', { className: 'col-received' }, solution.entered_at ? formatDateTime(solution.entered_at) : '', competition.slug && el('div', null, el('a', { className: 'small', href: leaderboardHref(competition.slug) }, 'Leaderboard'))),
  );
}

export async function mountProfileView(container, { handle }, route) {
  let shownSolutions = SOLUTIONS_PAGE_SIZE;
  const refs = {};

  function applyProfileData(profile) {
    document.title = `@${profile.handle} · make.fun`;
    const record = profile.record || {};
    const solutions = profile.solutions || [];
    if (!refs.page) {
      refs.avatar = el('div', { className: 'profile-avatar' });
      refs.name = el('h1', { tabIndex: -1 });
      refs.handle = el('p', { className: 'muted' });
      refs.bio = el('p', { className: 'profile-bio' });
      refs.links = el('ul', { className: 'profile-links' });
      refs.stats = el('dl', { className: 'stat-row' });
      refs.solutionsBody = el('tbody');
      refs.solutionsCount = el('span', { className: 'muted' });
      refs.moreButton = el('button', { type: 'button', className: 'button', onclick: () => { shownSolutions += SOLUTIONS_PAGE_SIZE; renderSolutions(); } }, 'Show more entries');
      refs.emptySolutions = el('p', { className: 'empty-state', hidden: true }, 'No public entries yet.');
      refs.page = el(
        'article',
        { className: 'profile-view' },
        el('nav', { className: 'breadcrumb', 'aria-label': 'Breadcrumb' }, el('a', { href: '#/' }, 'Bounties'), ' / ', el('span', null, `@${profile.handle}`)),
        el('header', { className: 'profile-header' }, refs.avatar, el('div', { className: 'profile-identity' }, refs.name, refs.handle, refs.bio, refs.links)),
        refs.stats,
        el(
          'section',
          { className: 'panel', 'aria-labelledby': 'entries-heading' },
          el('h2', { id: 'entries-heading' }, 'Entries ', refs.solutionsCount),
          el('div', { className: 'table-scroll' }, el('table', { className: 'solutions-table' }, el('thead', null, el('tr', null, ['Bounty', 'Entry', 'Score', 'Place', 'Prize', 'Entered'].map((label) => el('th', { scope: 'col' }, label)))), refs.solutionsBody)),
          refs.emptySolutions,
          refs.moreButton,
        ),
      );
      container.replaceChildren(refs.page);
    }
    const avatarUrl = absoluteAssetUrl(profile.avatar?.url || profile.image);
    if (refs.avatar.dataset.src !== (avatarUrl || '')) {
      refs.avatar.dataset.src = avatarUrl || '';
      refs.avatar.replaceChildren(avatarImage(avatarUrl, profile.handle, 96));
    }
    setText(refs.name, profile.display_name || `@${profile.handle}`);
    setText(refs.handle, [`@${profile.handle}`, profile.house && 'house account', profile.joined_at && `joined ${formatDate(profile.joined_at)}`].filter(Boolean).join(' · '));
    setText(refs.bio, profile.bio || '');
    refs.links.replaceChildren(...profileLinks(profile).map(([label, href, text]) => el('li', null, el('span', { className: 'muted' }, `${label} `), el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text))));
    refs.stats.replaceChildren(
      statBlock('Prize money', formatUsd(record.prize_usd || 0), 'stat-pot').node,
      statBlock('Entered', record.competitions_entered ?? 0).node,
      statBlock('Placed', record.competitions_placed ?? 0).node,
      statBlock('Won', record.competitions_won ?? 0).node,
      statBlock('Podiums', record.podium_finishes ?? 0).node,
      statBlock('Best place', record.best_placement ? `#${record.best_placement}` : '—').node,
    );
    refs.solutions = solutions;
    setText(refs.solutionsCount, `(${solutions.length})`);
    renderSolutions();
  }

  function renderSolutions() {
    const visible = refs.solutions.slice(0, shownSolutions);
    refs.solutionsBody.replaceChildren(...visible.map(buildSolutionRow));
    refs.moreButton.hidden = refs.solutions.length <= shownSolutions;
    refs.emptySolutions.hidden = refs.solutions.length > 0;
  }

  const profile = await readCached(profilePath(handle), (fresh) => route.isCurrent() && applyProfileData(fresh));
  if (!route.isCurrent()) return;
  applyProfileData(profile);
}
