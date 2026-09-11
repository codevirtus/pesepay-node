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
| 3 | Crypto + transport | ✅ done |
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

## Stage 3 — done

The foundation layer: `errors.ts`, `status.ts`, `types.ts`, `crypto.ts`,
`internal/transport.ts` (1,223 lines), plus 77 new tests. `npm run verify` is
green end to end — lint, typecheck, build, **86 tests**, `publint --strict`,
`attw` clean in every resolution mode.

Nothing is wired into `src/index.ts` yet; the modules emit to `dist/` and the
tests reach them by path. Entry points are stage 6, as planned.

### What the wire contract turned out to be

Everything below was read off the Java server, not inferred:

- **AES** — `AES/CBC/PKCS5PADDING`, key used directly as 32 UTF-8 bytes, **IV =
  `key.substring(0, 16)`**, standard base64.
  (`pesepay-payments-engine/encryption/.../PaymentPayloadEncryptionHelper.java`)
- **17 statuses** with codes and descriptions, from
  `pesepay-cloud-utilities/.../TransactionStatus.java`. Confirmed: `CLOSED` and
  `CLOSED_PERIOD_ELAPSED` are both `307`, and they are the *only* duplicate.
- **`CreateTransactionCommand` silently substitutes the string `"NONE"`** for a
  blank `resultUrl`/`returnUrl` rather than rejecting it — so a typo'd result
  URL yields a transaction whose outcome you are never told.
- **`PaymentTransactionResult` has no `redirectUrl`.** The server declares one
  but has it commented out. The redirect URL exists only on the initiate
  response.
- Amounts come back as a fee split (`customerPayableAmount`, `merchantAmount`,
  `totalTransactionAmount`), not as an echo of what was sent. Reconcile against
  `merchantAmount`.

### AES vectors: generated from Java, and they bite

`scripts/java/GenerateVectors.java` mirrors the server's cipher path and writes
`test/fixtures/java-vectors.json` — 10 vectors plus a tampered case. Runs on any
JDK 17+ with `java scripts/java/GenerateVectors.java <out>`; no Maven, and the
source is pure ASCII (non-ASCII test data is written as `\uXXXX` escapes), so
the output is byte-identical regardless of the platform's `file.encoding`.
**Never regenerate these from the Node implementation** — that turns an interop
test into a tautology.

Coverage includes the empty string, 15/16/32-byte inputs, a 2 KiB payload, two
different keys, and non-ASCII *plaintext* (which is fine — only the *key* must
be ASCII).

Because "all green" proves little on its own, five mutations were injected and
each was caught by exactly the test that should catch it:

| mutation | result |
|---|---|
| IV taken from the last 16 chars instead of the first | **21 failures** |
| pad only when there is a remainder (the classic PKCS#7 bug) | **6 failures** |
| always set `insecureHTTPParser` | **5 failures** (incl. the negative control) |
| retry drops the request body | **1 failure** — the body-replay test |
| warn on every fallback instead of once | **1 failure** — the warn-once test |

### Gotchas found in stage 3

- **`src/**/*.ts` must import siblings with a `.js` extension, not `.ts`.**
  `tsconfig.json` sets `allowImportingTsExtensions` (needed for `noEmit`
  typechecking), but `tsconfig.build.json` turns it off, so a `.ts` specifier
  compiles under `typecheck` and fails under `build` with TS5097. Tests under
  `test/` still use `.ts`/`.mts` specifiers — they are never emitted.
- **`net.Server` has no `closeAllConnections()`** (that is `http.Server`). The
  timeout test deliberately leaves a socket open, so the raw fixture tracks its
  sockets and destroys them itself, or `server.close()` never resolves.
- **Plain HTTP is allowed to loopback only.** The transport refuses to send an
  integration key over cleartext to anything else. This is what lets the parser
  fallback be tested against a raw `node:net` server while keeping the
  production path https-only.

### Decisions taken in stage 3

- **`isTerminal()` treats an unknown status as terminal.** A status Pesepay adds
  later is far more likely to be a new terminal outcome than a new in-flight
  one, and guessing "pending" turns a poll loop into an infinite one. `isPaid()`
  is separately `=== 'SUCCESS'`, so stopping early can never credit anything.
- **`createHttpsTransport()` is a factory; `httpsTransport` is the singleton.**
  Warn-once state lives on the closure, which makes it testable per instance
  while the shipped behaviour stays one warning per process.
- **Errors carry no `cause` from OpenSSL.** An OpenSSL error object can hold key
  material in its detail fields, and errors end up in log aggregators. Tests
  assert no key reaches a message, a stack, or `JSON.stringify` output.
- **`insecureHTTPParser` can be switched off** via
  `createHttpsTransport({ allowInsecureHttpParserFallback: false })`, for sites
  whose policy forbids the lenient parser outright.

Tarball is now **48 files / 37.1 KB packed**, still nothing outside `dist/`,
`src/`, `package.json`, `README`, `LICENSE`. No test files, no `scripts/`.

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
