# github-core-clone — a GitHub-compatible forge in Node

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/fikri92/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/fikri92/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process GitHub look-alike built for [make.fun](https://make.fun)'s “Build a GitHub-compatible git forge” bounty.

- **git smart HTTP** — protocol v2 advertisement, `ls-refs` (peel, symrefs, unborn, ref-prefix), `fetch` with shallow/deepen/incremental and sideband packfile, `receive-pack` with report-status, fast-forward checks and ref deletion. Packfiles are written and read here (`node:zlib`), deltas included.
- **REST v3** — repositories, contents (commit-per-write), branches, commits, issues, comments, labels, pull requests with squash merge and conflict detection, pagination via `Link`.
- **GraphQL v4** — the documents `gh` and `github-mcp-server` send, with introspection.
- **MCP** — streamable-HTTP JSON-RPC, `server/discover`, `tools/list` and the tool set acting on the same store REST reads.

Run it: `MAKEFUN_ENV_URL=... node --experimental-strip-types main.ts` (reads `MAKEFUN_SHOP_TOKEN`, registers its port with the env, serves until the env says done).
