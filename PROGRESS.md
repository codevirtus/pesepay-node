# pesepay v2.0.0 — build progress

Rewrite of the `pesepay` npm package as a zero-dependency TypeScript 7 SDK.
Full plan: `C:\Users\oneal\.claude\plans\i-havev-an-npm-golden-beacon.md`

Work is staged, one stage per context window. This file is the source of truth
for where things stand — update it at the end of every stage.

## Stages

| # | Stage | Status |
|---|-------|--------|
| 1 | Repo + history | ✅ done |
| 2 | Toolchain (package.json, tsconfig, biome) | ⬜ not started |
| 3 | Crypto + transport | ⬜ not started |
| 4 | Payments client | ⬜ not started |
| 5 | Catalogue, invoices, webhook | ⬜ not started |
| 6 | Entry points + v1 compat layer | ⬜ not started |
| 7 | Docs | ⬜ not started |
| 8 | CI + release | ⬜ not started |

## Key decisions (settled — do not re-litigate)

- **No native `fetch`.** `api.pesepay.com` emits a header block with a bare LF
  (its `Strict-Transport-Security` value contains a literal newline), so Node's
  strict llhttp parser rejects every production response with `HPE_CR_EXPECTED`.
  Verified by raw TLS dump: `fetch`/undici fails, `node:https` strict fails,
  `node:https` with `insecureHTTPParser: true` succeeds. The SDK uses a
  `node:https` transport that tries strict first and retries once on `HPE_*`.
- **Build: plain `tsc` from TypeScript 7.0.2, one tsconfig**, `"type": "commonjs"`
  with an `src/index.mts` wrapper. The two-tsconfig dual build is not expressible
  in TS 7 (`moduleResolution: node10` removed — TS5108; `commonjs` + `nodenext`
  rejected — TS5110). Validated in a scratch probe: single `tsc` run emits CJS +
  ESM + both declaration flavours, and `esm.Pesepay === cjs.Pesepay` so there is
  no dual-package hazard.
- **Zero runtime dependencies.** axios is dropped.
- **`tsup` / `unbuild` / `typedoc` / `typescript-eslint` are all unusable** — they
  embed the TypeScript programmatic API, which TS 7 does not ship until 7.1.
  Lint/format is Biome; API docs are hand-written.
- **v1 compat** ships at the `pesepay/v1-compat` export path.
- **1.0.4 must stay installable.** Publish 2.0.0 as `latest`; add a `v1` dist-tag
  pointing at 1.0.4 first.

## Stage 1 — done

- Repo seeded from the Bitbucket clone with all 19 commits and original
  authorship intact (viper75 / Sean Huvaya / Simbarashe Chizhande).
- `master` renamed to `main`; Bitbucket remote removed.
- **v1.0.4 reconstructed from the published npm tarball** — it was released on
  2024-06-22 but never committed, so history was missing a shipped version.
  Verified: the `v1` branch matches the published tarball byte-for-byte across
  all 10 source files.
- Tags `v1.0.3` and `v1.0.4`; branch `v1` for any future v1 security patch.
- Hygiene: `.gitignore` (v1's had Java/Python boilerplate and ignored `test.ts`,
  which is how `dist/test.js` leaked into the 1.0.4 tarball), `.gitattributes`
  (`eol=lf`), `.editorconfig`, `.nvmrc`, and a real `LICENSE` — v1 claimed MIT in
  `package.json` but shipped no licence file.

## Open items needing input

- **Sandbox credentials** (`api.test.pesepay.com`) for live end-to-end verification.
- **npm publish rights** — the Trusted Publisher must be configured by an account
  with maintainer rights on `pesepay`: `codevirtus`, `charlescoder`, or
  `deanmaponga` (who published 1.0.4).

## Related, outside this repo

- **Fix the nginx header** on `api.pesepay.com`. It currently breaks `fetch` for
  every language, not just Node:
  `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`
- `pesepay-config-files/payments-engine-service-prod.yml` holds live production
  MySQL credentials, Spring Boot Admin credentials and a SendGate API key in
  cleartext. Unrelated to this work, but someone should own it.
