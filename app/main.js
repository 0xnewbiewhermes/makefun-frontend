// The router: four hash routes, each a view module. The board ships in the first load; the bounty page, the
// leaderboard and the profile are fetched by import() the first time they are opened (and warmed on idle).
//
//   #/                                the board of live bounties
//   #/bounty/<slug>                   one bounty: summary, rewards with the live pot, dates, rules
//   #/bounty/<slug>/leaderboard       that bounty's ranked entries
//   #/u/<handle>                      an account's public profile
//
// window.__shotReady is false while a route loads and true once its data is on screen.

import { boardPath, bountyPath, leaderboardPath, profilePath, readCached } from './api.js';
import { mountBoardView } from './board-view.js';
import { renderErrorState, renderSkeleton, stopAllCountdowns } from './ui.js';

const loadBountyView = () => import('./bounty-view.js');
const loadLeaderboardView = () => import('./leaderboard-view.js');
const loadProfileView = () => import('./profile-view.js');

const ROUTE_MOUNTERS = {
  board: async () => mountBoardView,
  bounty: async () => (await loadBountyView()).mountBountyView,
  leaderboard: async () => (await loadLeaderboardView()).mountLeaderboardView,
  profile: async () => (await loadProfileView()).mountProfileView,
};

/** The API read each route paints from, started alongside the route's import() so the two download in parallel. */
const ROUTE_DATA_PATHS = {
  board: () => boardPath(),
  bounty: ({ slug }) => bountyPath(slug),
  leaderboard: ({ slug }) => leaderboardPath(slug),
  profile: ({ handle }) => profilePath(handle),
};

const viewRoot = document.getElementById('view');
let routeGeneration = 0;
let unmountActiveView = null;
let isFirstRender = true;

/** '#/bounty/x/leaderboard' -> { name: 'leaderboard', params: { slug: 'x' } } */
export function parseHashRoute(hash) {
  const parts = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'bounty' && parts[1]) return { name: parts[2] === 'leaderboard' ? 'leaderboard' : 'bounty', params: { slug: parts[1] } };
  if (parts[0] === 'u' && parts[1]) return { name: 'profile', params: { handle: parts[1].replace(/^@/, '') } };
  return { name: 'board', params: {} };
}

function markActiveNavLink(routeName) {
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === routeName) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function renderCurrentRoute() {
  const generation = ++routeGeneration;
  window.__shotReady = false;
  unmountActiveView?.();
  unmountActiveView = null;
  stopAllCountdowns();
  const route = parseHashRoute(location.hash);
  markActiveNavLink(route.name);
  viewRoot.replaceChildren(renderSkeleton(route.name));
  if (!isFirstRender) window.scrollTo(0, 0);
  const routeContext = { isCurrent: () => generation === routeGeneration };
  readCached(ROUTE_DATA_PATHS[route.name](route.params)).catch(() => {});
  try {
    const mountView = await ROUTE_MOUNTERS[route.name]();
    const unmount = await mountView(viewRoot, route.params, routeContext);
    if (!routeContext.isCurrent()) return unmount?.();
    unmountActiveView = unmount || null;
  } catch (error) {
    if (!routeContext.isCurrent()) return;
    console.error(error);
    viewRoot.replaceChildren(renderErrorState(error, renderCurrentRoute));
  }
  if (!isFirstRender) viewRoot.querySelector('h1')?.focus({ preventScroll: true });
  isFirstRender = false;
  window.__shotReady = true;
}

function handleProfileSearch(event) {
  event.preventDefault();
  const handle = new FormData(event.target).get('handle')?.toString().trim().replace(/^@/, '');
  if (handle) location.hash = `#/u/${encodeURIComponent(handle)}`;
}

function preloadLaterViewsWhenIdle() {
  const warm = () => Promise.all([loadBountyView(), loadLeaderboardView(), loadProfileView()]).catch(() => {});
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 2500);
}

document.getElementById('profile-search').addEventListener('submit', handleProfileSearch);
window.addEventListener('hashchange', renderCurrentRoute);
renderCurrentRoute().then(preloadLaterViewsWhenIdle);
