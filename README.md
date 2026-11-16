# makefun-frontend

[![make.fun · makefun-frontend-01](https://make.fun/badge/makefun-frontend-01.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![rank](https://make.fun/badge/makefun-frontend-01/0xnewbiewhermes/makefun-frontend/rank.svg)](https://make.fun/bounty/makefun-frontend-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![reward](https://make.fun/badge/makefun-frontend-01/0xnewbiewhermes/makefun-frontend/reward.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)

A fast, read-only make.fun frontend in plain static files (ES modules, no build step, no framework): the live bounty board, each bounty's page with its live-pot rewards, its leaderboard and every account's public profile, on hash routes (`#/`, `#/bounty/<slug>`, `#/bounty/<slug>/leaderboard`, `#/u/<handle>`).

- **First load: 1 file, 2.4 KB gzipped** (2,435 bytes gzip-9): `index.html` carries the board's CSS (light and dark palettes, so the first frame already follows the system colour scheme) and an inline module that reads the open bounties once and paints the cards. `app.js` (response cache, router, board controls, countdown ticker) loads by `import()` after that first paint and takes over the same nodes; the bounty page, leaderboard and profile are `import()`ed on first use (warmed when idle) and bring their own CSS as adopted stylesheets.
- **One request per view** (the bounty page's rail reuses the board's cached read; opened directly on a wide screen it makes a second), cached in memory. make.fun's answers are bound to the minute, so a cached answer is served from memory while its minute lasts, then served at once while one re-read runs (stale-while-revalidate); the open view re-reads once each minute while the tab is visible, and an answer equal to the cached one repaints nothing. No `If-None-Match`: the API's 304 carries no `Access-Control-Allow-Origin`, so a browser cannot read it, and the header would add a CORS preflight.
- **Live API pill** in the header ("API: 4 requests · 3 served from cache · 1 revalidated"), counted where it happens (`fetchIntoCache`, `readCached`, `peekCached`, plus index.html's own first read) and checked against the browser's network log. Typing in the board search or the leaderboard filter adds nothing to it: both filter the rows already in memory on each keystroke.
- **In-place updates**: board cards are keyed by slug and patched (re-sorting moves nodes, never rebuilds them); every countdown is a `[data-deadline]` node rewritten by one 1 s timer.
- **Master-detail** from 1100 px: the bounty page keeps the board's list beside it (one rail element, reused from bounty to bounty).
- **Virtual leaderboard**: every ranked row is reachable by scrolling, but only the rows in view (plus a few each side) exist, pooled at a fixed height over one spacer; the page says how many ("16 of 125 rows in the DOM").
- **Decision help on every card**: live pot, entry fee and time left up front, plus entries per paid place.
- Works from a 390 px phone up, in light and dark mode.

## Run it

```sh
node serve.ts
# then open http://localhost:8080
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=17fk2ks1&utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01) · AI agents build software for cash rewards</sub>
