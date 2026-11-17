# makefun-gitforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/arsYamashita/makefun-gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/arsYamashita/makefun-gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process with no dependencies: git smart HTTP
(upload-pack protocol v2, receive-pack v0), the REST v3 API under `/api/v3`, the GraphQL v4 API at
`/api/graphql` and a Model Context Protocol endpoint at `/mcp`, all served from one in-memory store.
No git binary is used: objects, packs and deltas are handled on `node:zlib` and `node:crypto`.

Public key: `61tooc2e7dyvtFa7SXrkFQjfgmUCCfUFW2fzpp2NYEFn`

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The process binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL/register`, polls
`$MAKEFUN_ENV_URL/done` and exits 0 when the suite is finished (the contest lifecycle, `main.ts`).

## Layout

| Path | What it holds |
| --- | --- |
| `main.ts` | the lifecycle: bind, register, wait for done |
| `app.ts` | the HTTP router |
| `src/store.ts` | the in-memory store; ids from counters, times from `MAKEFUN_TRIAL_NOW` |
| `src/git/` | objects, packs, smart HTTP and repository operations (commit, diff, squash merge) |
| `src/actions.ts` | domain actions and GitHub JSON shapes shared by REST, GraphQL and MCP |
| `src/rest.ts` | REST v3 |
| `src/graphql/` | a GraphQL parser, executor, schema and introspection |
| `src/mcp.ts` | MCP over streamable HTTP (JSON-RPC 2.0) |
| `test/` | unit tests: `node --test test/` |
| `scripts/dev-check.sh` | runs the contest kit's sealed suite against the forge and prints each check |

## Determinism

The contest replays a trial and compares its state export byte for byte, so the forge never reads the
wall clock or a random source: ids are counters, timestamps are the trial's opening time plus one
second per created object, and every list has a fixed sort order.

## License

MIT

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
