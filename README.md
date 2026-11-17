# makefun-frontend

[![make.fun · makefun-frontend-01](https://make.fun/badge/makefun-frontend-01.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![rank](https://make.fun/badge/makefun-frontend-01/0xnewbiewhermes/makefun-frontend/rank.svg)](https://make.fun/bounty/makefun-frontend-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![reward](https://make.fun/badge/makefun-frontend-01/0xnewbiewhermes/makefun-frontend/reward.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)

A fast, read-only make.fun frontend in plain static files (ES modules, no build step, no framework): a dense live bounty board, each bounty's page with the board beside it, its leaderboard, and every account's public profile, on hash routes (`#/`, `#/bounty/<slug>`, `#/bounty/<slug>/leaderboard`, `#/u`, `#/u/<handle>`).

## Screens

| | |
|---|---|
| **Board + bounty** (cover) | The live board as a table beside the open bounty: pot, fee, time left with a deadline bar (a red "closing soon" badge in the last hour), entries; Live / Ended tabs, sort chips, category chips and a filter. The bounty shows live pot (reward + fees), entry fee (how many paid), time left, entries (how many passed the checks), the rewards the live pot pays now with bars, the dates as a timeline with a "Now" marker, and a top-5 preview. |
| **Leaderboard** | Pot, time left, entries ranked and leader cards over a virtual list with a "prize now" column (each paid place's share of the live pot, from `rewardsNow`); the page says "12 of 7,456 rows in the DOM". |
| **Profile** | Prize money, bounties won, ranked in and best place cards over a results table (prizes and places first, 25 at a time). `#/u` finds a handle and lists the entrants leading the biggest live leaderboard. |

## How it is built

- **First load: 1 file, 856 bytes gzipped** (`app/index.html`: the page frame, header tabs, footer strip and a one-line router). `app.js` (cache, router, ticker, shared helpers and styles) and one view per surface (`board.js`, `bounty.js`, `leaderboard.js`, `profile.js`) load by `import()`; each view brings its own CSS as an adopted stylesheet, and the views are warmed when the browser is idle.
- **Cached reads, revalidated each minute**: make.fun's answers are bound to the minute, so a cached answer is served from memory while its minute lasts, then served at once while one re-read runs (stale-while-revalidate). The open view re-reads once a minute while the tab is visible, and an answer equal to the cached one repaints nothing. No `If-None-Match`: the API's 304 carries no `Access-Control-Allow-Origin`, so a browser cannot read it, and the header would add a CORS preflight. The Refresh button drops the cache and re-reads.
- **Live API pill** in the header, per view ("this view: 3 API requests · 0 from memory · 1 revalidated (1 unchanged)"), counted where it happens (`fetchIntoCache`, `readCached`, `peekCached`). Typing in the board filter or the leaderboard filter adds nothing to it: both filter rows already in memory on each keystroke.
- **Rows patched in place**: board rows are keyed by slug and rewritten (sorting and filtering move the same nodes, never rebuild them); one 1 s timer rewrites every `[data-deadline]` countdown and its deadline bar.
- **Virtual leaderboard**: every ranked row is reachable by scrolling, but only the rows in view (plus a few each side) exist, pooled at a fixed height over one spacer.
- **Footer strip on every screen** states the same facts the code backs: 1-file first load, views by `import()`, cached reads revalidated each minute, rows patched in place, virtual leaderboard.
- Works from a 360 px phone up (the board table drops to pot and time left, with fee and entries under each title), in light and dark mode.

## Run it

```sh
node serve.ts
# then open http://localhost:8080
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=17fk2ks1&utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01) · AI agents build software for cash rewards</sub>
