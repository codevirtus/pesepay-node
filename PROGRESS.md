# pesepay v2.0.0 — build progress

Rewrite of the `pesepay` npm package as a zero-dependency TypeScript 7 SDK.
Full plan: `C:\Users\oneal\.claude\plans\i-havev-an-npm-golden-beacon.md`

Work is staged, one stage per context window. This file is the source of truth
for where things stand — update it at the end of every stage.

## Stages

| # | Stage | Status |
|---|-------|--------|
| 1 | Repo + history | ✅ done |
| 2 | Toolchain (package.json, tsconfig, biome) | ✅ done |
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

## Stage 2 — done

Toolchain in place and fully green: `npm run verify` runs lint → typecheck →
build → 9 tests → `publint --strict` + `attw`, all passing.

- `typescript@7.0.2`, `@biomejs/biome@2.5.13`, `@types/node@26.5.1`,
  `publint@0.3.24`, `@arethetypeswrong/cli@0.18.5`. **Zero runtime deps.**
- A single `tsc` run emits CJS + ESM + both declaration flavours for both entry
  points (`.` and `./v1-compat`). `attw` is green in **every** resolution mode,
  including legacy `node10`.
- Tarball is **23 files / 11.1 KB**, with no test files and nothing outside
  `dist/`, `src/`, `package.json`, `README`, `LICENSE`. For comparison, v1.0.4
  shipped **42 files / 44 KB**, including a stray `dist/test.js`.

### Test strategy — settled, and not obvious

`"type": "commonjs"` means `src/**/*.ts` emits CommonJS, which also means **Node
cannot load those sources directly** under type stripping: an `.mts` test doing
`import { X } from '../../src/index.ts'` fails with "does not provide an export
named X" — Node treats the file as CJS and finds no `exports.` assignments in
what is still ESM syntax.

So tests run against `dist/`, which is what consumers actually receive, while
keeping full type safety via `test/fixtures/sdk.mts`:

```ts
import type * as IndexModule from '../../src/index.ts'; // erased at runtime
export const sdk: typeof IndexModule = require_('../../dist/index.js');
```

Types come from source, values from the build. `pretest` runs `build`, so
`npm test` is always honest. Add a similar typed loader per module in stage 3+.

Three smaller gotchas worth remembering:
- `node --test test/unit/` does **not** work on Windows — it resolves the
  directory as a module. Use a glob: `node --test "test/**/*.test.mts"`.
- `typesVersions` is required for `pesepay/v1-compat` to resolve types under
  TypeScript's legacy `node10` resolution, which is exactly what migrating v1
  users are likely to be on.
- `.gitignore` must anchor build output as `/dist/`, not `dist/` — the unanchored
  form matches at any depth and silently swallowed `test/dist/`.

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
