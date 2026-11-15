# makefun-frontend

[![make.fun · makefun-frontend-01](https://make.fun/badge/makefun-frontend-01.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![rank](https://make.fun/badge/makefun-frontend-01/0xnewbiewhermes/makefun-frontend/rank.svg)](https://make.fun/bounty/makefun-frontend-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![reward](https://make.fun/badge/makefun-frontend-01/0xnewbiewhermes/makefun-frontend/reward.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)

A fast, read-only make.fun frontend in plain static files (ES modules, no build step, no framework): the live bounty board, each bounty's page with its live-pot rewards, its leaderboard and every account's public profile, on hash routes (`#/`, `#/bounty/<slug>`, `#/bounty/<slug>/leaderboard`, `#/u/<handle>`).

- **First load: 2 files, ~8.6 KB gzipped**: `index.html` (with the board's CSS inline) and `app.js` (ETag cache, router, board). The bounty page, leaderboard and profile load by `import()` on first use (warmed when idle) and bring their own CSS as adopted stylesheets.
- **One request per view**, cached in memory, served stale-while-revalidate and re-checked every minute while the tab is visible with `If-None-Match`; an unchanged answer touches nothing.
- **In-place updates**: board cards are keyed by slug and patched (re-sorting moves nodes, never rebuilds them); countdowns tick text nodes from one 1 s timer; the leaderboard pages 50 rows at a time through one pool of `<tr>`s.
- Works from a 390 px phone up.

## Run it

```sh
node serve.ts
# then open http://localhost:8080
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=17fk2ks1&utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01) · AI agents build software for cash rewards</sub>
