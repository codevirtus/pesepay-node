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
| 4 | Payments client | ✅ done |
| 5 | Catalogue, invoices, webhook | ✅ done |
| 6 | Entry points + v1 compat layer | ✅ done |
| 7 | Docs | ✅ done |
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

## Stage 4 — done

`src/client.ts` (701 lines) — the `Pesepay` class — plus 44 new tests. `npm run
verify` is green end to end: lint, typecheck, build, **130 tests**,
`publint --strict`, `attw` clean in every resolution mode.

Still not wired into `src/index.ts`; entry points remain stage 6, and the tests
reach `dist/client.js` through a new loader in `test/fixtures/modules.mts`.

### What shipped

| method | endpoint | returns |
|---|---|---|
| `initiateTransaction(options)` | `POST /v1/payments/initiate` | `{ referenceNumber, pollUrl, redirectUrl }` |
| `makeSeamlessPayment(options)` | `POST /v2/payments/make-payment` | `PaymentResult` |
| `checkPayment(referenceNumber)` | `GET /v1/payments/check-payment` | `PaymentResult` |
| `pollTransaction(pollUrl)` | `GET` that URL | `PaymentResult` |

The constructor takes `{ integrationKey, encryptionKey, resultUrl, returnUrl,
timeoutMs?, baseUrl?, transport? }` **and** the v1 positional
`(integrationKey, encryptionKey)` form, with `resultUrl`/`returnUrl` as settable
properties. Keys are validated eagerly via `assertValidEncryptionKey`, so a bad
key is a `PesepayConfigError` before any socket.

`PaymentResult` is the decoded `PaymentTransactionResult` — real
`transactionStatus`, `transactionStatusCode`, `transactionStatusDescription`,
`amountDetails`, `transactionMetadata` — plus derived `paid` and `isTerminal`
from `status.ts`. Frozen, and both derived fields are **plain data rather than
getters**, so the object survives `JSON.stringify`, `structuredClone`, and a
trip through a queue.

### Decisions taken in stage 4

- **Status is checked before anything is decrypted.** This is the single
  load-bearing ordering in the file. Errors are always plain JSON, never the
  `{payload}` envelope, so decrypting first turns "your integration key is
  unknown" (404) into a padding error and sends you rotating the wrong
  credential. `404`/`403` → `PesepayAuthError`; everything else →
  `PesepayApiError`, on which `isEncryptionKeyMismatch()` picks out the 500.
- **The gateway's words are redacted before they become an error.** Any
  occurrence of either key in a server `message`, `description` or response body
  is replaced with `[redacted]`. The gateway is not believed to echo
  credentials, but errors reach log aggregators and "we checked, it doesn't" is
  weaker than "it cannot". Tested by having the fake gateway echo both keys.
- **Fields are `#private`, not `private`.** A TS `private` field is an ordinary
  enumerable own property at runtime, so `JSON.stringify(pesepay)` would publish
  both keys. `#` fields are invisible to it — asserted.
- **Callback URLs are validated client-side**, because the server will not:
  `CreateTransactionCommand` substitutes the string `"NONE"` for a blank one, so
  the transaction is created and the outcome is simply never delivered. Blank
  and whitespace-only are rejected with that explanation, not just with "does
  not parse".
- **`customer` is unconditional on seamless payments**, and the request type
  makes it non-optional — a mutation that sent it conditionally failed to
  compile rather than failing a test, which is the better place for that
  invariant.
- **A malformed 2xx is reported as `PesepayApiError`**, so the HTTP status stays
  on the error either way. It deliberately carries **no** `responseBody`: by
  that point the body is decrypted, and decrypted transaction data is customer
  data.
- **Absent options are omitted, never sent as `null`** — the server's
  `@NotBlank` validators and its `"NONE"` substitution treat missing and null
  differently.
- **`checkPayment` builds its query through `URL`.** v1 concatenated the
  reference raw, so one containing `&`, `#` or a space produced a silently
  different request.

### Mutation testing — ten injected, ten caught

As in stage 3, "all green" was checked rather than assumed:

| mutation | result |
|---|---|
| decrypt before checking the status | **7 failures** — every error-mapping test |
| send the request body as cleartext | **7 failures** |
| skip redaction of the server's words | **2 failures** |
| swap `paid` and `isTerminal` | **2 failures** |
| drop the `key` header | **2 failures** |
| treat 403/404 as ordinary API errors | **2 failures** |
| v1's raw query-string concatenation | **1 failure** |
| accept a blank `resultUrl` | **survived at first** — see below |
| send `customer` conditionally | **compile error** (TS2375) |
| identity `#redact` with a type change | **compile error** (TS2339) |

The blank-`resultUrl` mutant survived the first round: `''` still threw, but
via `new URL('')` with a message about parsing rather than about `"NONE"`.
Since that explanation *is* the reason the check exists client-side, a test now
pins it, and the mutant dies.

Tarball is **53 files / 49.6 KB packed**, still nothing outside `dist/`, `src/`,
`package.json`, `README`, `LICENSE`. No test files, no `scripts/`.

### Touched from stage 3

Two TSDoc corrections in `errors.ts`, no behaviour change: `PesepayApiError`
now also documents the malformed-2xx case, and `PesepayConfigError` documents
that it covers per-call arguments (a negative amount, a customer-less seamless
payment) as well as construction.

## Stage 5 — done

Catalogue, invoices and the webhook, all on `src/client.ts` (701 → 1,375
lines), plus 84 new tests in three new files. `npm run verify` is green end to
end: lint, typecheck, build, **214 tests**, `publint --strict`, `attw` clean in
every resolution mode.

Still not wired into `src/index.ts`; entry points remain stage 6.

### What shipped

| method | endpoint | envelope | returns |
|---|---|---|---|
| `getActiveCurrencies()` | `GET /v1/currencies/active` | **plain** | `Currency[]` |
| `getPaymentMethods(code)` | `GET /v1/payment-methods/for-currency` | **plain** | `PaymentMethod[]` |
| `getActivePaymentMethods()` | `GET /v1/payment-methods/all-active` | **plain** | `PaymentMethod[]` |
| `initiateInvoice(options)` | `POST /v1/payments/invoice/initiate` | encrypted | `InvoiceResult` |
| `checkInvoice(invoiceNumber)` | `GET /v1/payments/invoice/check` | encrypted | `PaymentResult` |
| `parseCallback(body, headers?)` | — (you are the server) | **plain** | `{ result, keyVerified, keyStatus }` |

New types in `types.ts`: `RecurringFrequency`, `InvoicePayer`,
`CreateInvoiceRequest`, `Invoice`. New in `client.ts`:
`InitiateInvoiceOptions`, `InvoiceResult`, `CallbackHeaders`,
`CallbackKeyStatus`, `CallbackVerification`.

### What the wire contract turned out to be

Read off the Java server, not inferred:

- **`/v1/currencies/active`** → `Collection<Currency>`, the JPA entity whole:
  `name`, `description`, `code`, `defaultCurrency`, `rateToDefault`, `active`,
  plus `BaseEntity`'s auditing columns (`createdDate`, `version`, `deleted`, …).
  (`parameters/.../CurrenciesRestController.java`)
- **`/v1/payment-methods/for-currency?currencyCode=…`** → `Collection<PaymentMethod>`,
  also the entity whole — including `reverseProxyName`, which is internal
  routing config. Not modelled in our types, but preserved rather than dropped.
- **`getActivePaymentMethods` reads `/all-active`, not `/active`.** The plan
  said "for-currency" for both; the server says otherwise, and the two
  similarly-named endpoints are not interchangeable:

  | path | returns | filter |
  |---|---|---|
  | `/v1/payment-methods/all-active` | `Collection<PaymentMethod>` | none |
  | `/v1/payment-methods/active` | `Collection<PaymentMethodDto>` | **drops every `redirectRequired` method** |

  `PaymentMethodDto` carries only `name`, `code`, `acceptedCurrencies` and
  required-field *names* — no amount bounds, no `redirectRequired`, no
  `displayName`. Using it would make "cards do not exist" indistinguishable
  from "cards need a redirect".
- **All three catalogue paths are `permitAll()`** in `WebSecurityConfig`, along
  with `/v1/payments/**` and `/v2/payments/**`.
- **Invoice initiate takes `CreateInvoiceCommand` and returns the `Invoice`
  entity** — not a purpose-built DTO, so the reply also carries the nested
  `application` object and the JPA auditing columns.
- **`invoiceNumber` is `String.format("%07d", id)`** — a zero-padded row id,
  e.g. `0001042`. It doubles as the reference number of the transaction created
  when the payer pays, which is why `checkInvoice` returns a
  `PaymentTransactionResult` rather than an invoice.
- **The invoice `pollUrl` carries `?invoiceNumber=`**, built as
  `pollUrl.concat("?invoiceNumber=").concat(invoiceNumber)`. It is still a valid
  argument to `pollTransaction`.

### Three traps in the invoice endpoint

1. **`applicationCode` is required, and its absence is a 500.** `Invoice.fromCommand`
   resolves the owning application from `applicationCode`, or failing that from
   `decrypt(applicationId)` — and `SeamlessInvoiceCreationProcessingProviderImpl`
   never injects one from the integration key. So with neither field set, the
   DES decrypt of `null` blows up inside the transaction. Every other endpoint
   in this SDK identifies the application from the `key` header; this one does
   not. Enforced client-side with that explanation.
2. **`currencyCode` on the way out, `currency` on the way back.** The Java field
   is `Currency currency` annotated `@JsonProperty("currencyCode")` with a
   code-lookup deserialiser, so the request key is `currencyCode` (a string) and
   the reply key is `currency` (the whole record). Sending `currency` gets it
   silently dropped and the invoice rejected as currency-less.
3. **Dates are `MM/dd/yyyy`, via a hand-written `LocalDateDeserializer`** — not
   Jackson's ISO handling. `2026-09-11` does not parse. `initiateInvoice`
   accepts a `Date`, an ISO `YYYY-MM-DD`, or the gateway's own `MM/DD/YYYY`, and
   converts; a `Date` is read in **UTC**, because `new Date('2026-09-11')` is UTC
   midnight and reading local components would report the 10th for every caller
   west of Greenwich — a due date silently one day early, with nothing
   downstream to flag it. Dates that are not on the calendar (`2026-02-30`) are
   rejected rather than rolled over, which is what `Date.UTC` would do.

Also: `recurringPayment: true` without a `recurringFrequency` is a
`requireNonNull` on the server, so a 500 rather than a validation message. And
`initiatorReference` is enforced unique, which makes it a usable idempotency
key.

### The callback, and why the docs are blunt about it

`PaymentTransactionResultPosterImpl` is 60 lines, and every property that
matters is visible in them:

```java
restTemplate.getInterceptors().add((request, body, execution) -> {
    request.getHeaders().add("Authorization", integrationKeyForApplication.getKey());
    return execution.execute(request, body);
});
} catch (RecordNotFoundException ex) {
    log.warn("### {}", ex.getMessage());   // …and posts anyway, with no header
}
```

- **Plain unencrypted JSON**, not the `{payload}` envelope.
- **No HMAC, no signature.** The only credential is the integration key
  verbatim in an `Authorization` header.
- **The header is absent when the key lookup fails**, and the body is posted
  regardless — the `catch` logs a warning and falls through.
- **No retries.** One `postForEntity`, every exception caught and logged. A
  failed delivery is lost permanently.
- **A reversal is a second callback.** `PaymentStatusUpdateEventListener` posts
  on *every* terminal status change, so `SUCCESS` then `REVERSED` is two
  callbacks for one reference number.

So `parseCallback` reports `keyVerified` and never implies more than that. Its
TSDoc states plainly that handlers must be **idempotent on `referenceNumber` +
`transactionStatus`** and must **re-verify through `checkPayment()` before
crediting anything**, and it carries a complete Express handler showing the
three steps in order — respond first, re-verify second, credit idempotently
third — with each step tied to the server property that forces it.

### Decisions taken in stage 5

- **No credential is sent to the catalogue endpoints.** They are `permitAll()`,
  so the integration key buys nothing, and a bearer credential is not worth
  sending to an endpoint that does not ask for it. Pinned by a test that walks
  every request header. If Pesepay ever secures these, the call answers
  `401`/`403` through the existing mapping, and this is the decision to revisit.
- **Status is checked before parsing on the plain path too**, mirroring
  `#exchange`. A 503 whose body is a JSON object would otherwise be reported as
  "the body was not an array", burying the real cause.
- **An enveloped catalogue response is rejected, not decrypted.** This is the
  negative control for "these endpoints are not encrypted": a client that
  opportunistically unwrapped `{payload}` would pass every round-trip test and
  fail only here.
- **`parseCallback` throws `PesepayConfigError`, not `PesepayApiError`.**
  Nothing HTTP happened from our side — the body is a per-call argument, and
  fabricating an HTTP error with an invented status and URL would be worse than
  saying what it is. A body that *is* an envelope gets its own message, since
  every other payments response is enveloped and that is a natural mistake.
- **A missing `Authorization` header never throws.** The gateway genuinely sends
  none, and a webhook endpoint that crashes on that is worse than one that
  records the fact.
- **`keyStatus` exists alongside `keyVerified`**, separating `'absent'` (the
  gateway could not find an integration key — a configuration problem on your
  own account) from `'mismatched'` (something presented the wrong key — a stale
  key after a rotation, or someone else). The boolean loses a distinction worth
  alerting on differently.
- **Several `Authorization` headers count as no key presented.** A merged pair
  is the shape a header-injection attempt takes and is not something the gateway
  sends; picking one to compare would let the right key be smuggled alongside a
  wrong one.
- **The comparison is verbatim** — no `Bearer` prefix stripped, nothing
  trimmed. The server sets the header to the raw key, so leniency would only
  widen what counts as a match.
- **`derivePaymentResult` is shared between the polled path and the callback
  path**, so a webhook result and a `checkPayment` result cannot drift apart.

### The constant-time comparison, and the one test that actually pins it

`timingSafeEqual` throws outright on operands of different lengths, so the
obvious fix is a length check in front of it — which both short-circuits *and*
answers "how long is the key?". Instead both sides are hashed to a fixed 32
bytes and compared once. The hash is not for secrecy; it is for making the
operands the same size whatever was presented.

Proving that in tests took three angles, and the third is the one that matters:

| test | catches |
|---|---|
| a table of 8 odd headers (empty, 64 KiB, non-ASCII, embedded NUL, ±1 char) | passing raw strings to `timingSafeEqual`, which throws |
| same-length vs 1-char wrong key, cost within 5× | a length check that short-circuits |
| **a 1 MiB header must cost >3× a 36-byte one** | **`===`, and any other short-circuit** |

The third test exists because the first two cannot tell a real constant-time
comparison from a plain `===` — which is functionally correct and differs only
in a timing gap too small to measure from JavaScript. It comes at it from the
other direction and asserts a property `===` provably lacks: the comparison must
do work proportional to its input. A string comparison checks length first, so
1 MiB costs it what one byte costs; hashing must read all of it.

That gap was found by mutation testing, not by inspection — `===` survived the
first round and the test was written to kill it.

### Mutation testing — twenty injected, twenty caught

| mutation | result |
|---|---|
| `timingSafeEqual` on the raw strings | **12 failures** |
| `parseCallback` throws on an absent header | **11 failures** |
| month and day swapped in the date format | **5 failures** |
| send the integration key to the catalogue endpoints | **3 failures** |
| an absent header counts as verified | **3 failures** |
| opportunistically decrypt an enveloped catalogue response | **2 failures** |
| skip the status check on the plain path | **2 failures** |
| strip a `Bearer` prefix and trim before comparing | **2 failures** |
| `checkInvoice` queries `?referenceNumber=` | **2 failures** |
| length check in front of `timingSafeEqual` | **2 failures** |
| `getActivePaymentMethods` reads `/active` | 1 failure |
| `readCatalogue` stops requiring a `code` | 1 failure |
| pick a value out of several `Authorization` headers | 1 failure |
| a `Date` read in local time rather than UTC | 1 failure |
| a rolled-over calendar date accepted | 1 failure |
| `applicationCode` no longer required | 1 failure |
| `parseCallback` accepts a `{payload}` envelope | 1 failure |
| **`===` instead of a constant-time comparison** | **survived at first** — see above |
| invoice request key is `currency` | **compile error** (TS2353) |

Tarball is **53 files / 69.2 KB packed**, still nothing outside `dist/`, `src/`,
`package.json`, `README`, `LICENSE`. No test files, no `scripts/`.

## Stage 6 — done

The package is wired up. `src/index.ts` (96 lines) is the public CJS entry,
`src/index.mts` the ESM wrapper, `src/compat/v1.ts` (345 lines) the
`pesepay/v1-compat` layer, plus 50 new tests. `npm run verify` is green end to
end: lint, typecheck, build, **264 tests**, `publint --strict`, `attw` clean in
every resolution mode.

### The public surface, and what was deliberately left out

Exported from `pesepay`: `Pesepay` and its option/result types,
`DEFAULT_BASE_URL`, `DEFAULT_TIMEOUT_MS`, the seven error classes with
`PesepayErrorCode` and `PesepayApiErrorInit`, all eight of `status.ts`, the
`Transport` seam (`createHttpsTransport`, `httpsTransport` and its four types),
sixteen wire types, and `VERSION`. Twenty-one values and thirty-one types.

Three things were kept internal, on the principle that adding an export later is
non-breaking and removing one is not:

- **`crypto.ts` entirely** — `encryptPayload`, `decryptPayload`,
  `assertValidEncryptionKey`. Raw AES-256-CBC with no integrity protection is
  not a primitive to hand out, and nothing public needs it. It still ships in
  `dist/`, reachable by path; it is simply not part of the API.
- **The `*Request` wire shapes** — `CreateTransactionRequest`,
  `SeamlessPaymentRequest`, `CreateInvoiceRequest` — plus `AmountRequest` and
  `EncryptedEnvelope`. No public method takes one; they are built internally
  from the `*Options` types. Exporting them would advertise an input format that
  is not an input, and pin this package to the gateway's *request* shape as a
  compatibility promise on top of its response shape.
- Both are pinned by tests, so re-exporting either is a failure rather than a
  review comment.

### The dual-package hazard is real, and now measured

`esm.Pesepay === cjs.Pesepay` is the load-bearing assertion in
`test/dist/exports.test.mts`, and it was checked against the failure it exists
to prevent: copying `dist/` to a second directory and requiring both gives
`a.PesepayError === b.PesepayError` → `false`, and a `PesepayConfigError` thrown
by one is **not** `instanceof` the other's. That is exactly what a `tsup` /
`unbuild` / two-`tsc` build ships, and it is silent — it shows up only in a
mixed-module application, as a `catch` that stops matching.

The tests assert identity for all 21 value exports, and `instanceof` in both
directions across the boundary: thrown by `require`, caught by `import`, and the
reverse.

### `export *` really does leak, and the parity test is the guard

The stage-2 probe's finding stands: star-re-exporting a CommonJS module copies
`__esModule` and `module.exports` into the ESM namespace. Both wrappers list
every name explicitly instead.

The cost of an explicit list is that a name added to `index.ts` and forgotten in
`index.mts` is invisible until a consumer imports it. So the test compares
`Object.keys` of the two module objects and requires them equal, for both entry
points — the mutation "drop `isPaid` from the `.mts` list" dies there.

Also pinned: `dist/*.js` requires nothing but `node:` builtins and relative
paths, and `VERSION` matches `package.json`.

### v1 compat — read off the `v1` branch, not inferred

The `v1` branch and `pesepay-nodejs-integration/` are byte-identical modulo line
endings, so the branch is canonical. Reproduced: `Pesepay` with
`createTransaction`, `createPayment`, `initiateTransaction`,
`makeSeamlessPayment`, `checkPayment`, `pollTransaction`, the mutable
`resultUrl` / `returnUrl` properties, and the `PesepayResponse`, `Transaction`,
`Payment`, `Customer`, `Amount` classes with v1's endpoint constants.

`const { Pesepay } = require('pesepay/v1-compat')` is the only line that
changes. Five details of v1 that a paraphrase would have lost:

1. **Two failures v1 threw rather than folded.** The `resultUrl == null` and
   `returnUrl == null` checks sat *before* its `try`. They still throw, with the
   messages verbatim — `'Result url has not beeen specified.'`, typo included —
   and as a plain `Error`, not a `PesepayConfigError`. A test asserts no request
   is sent when one fires.
2. **The methods are own properties holding arrow functions**, so
   `const { checkPayment } = pesepay` still works. A `prototype` method would
   have lost `this`.
3. **v1 mutated the caller's objects.** `initiateTransaction` wrote both URLs
   onto the transaction; `makeSeamlessPayment` wrote `resultUrl`, `returnUrl`,
   `reasonForPayment`, a fresh `amountDetails` and both required-field maps onto
   the payment. Callers could observe all of it, so it is reproduced.
4. **`redirectUrl` is only ever set by `initiateTransaction`.** v1 read
   `resObj.redirectUrl` on polls too, where the server has it commented out —
   so it was always `undefined` there, and it stays `undefined` here even if the
   gateway starts sending one.
5. **`error.message ?? 'Something went wrong!'`**, including that a thrown
   non-`Error` yields the fallback.

Two deliberate departures, both improvements v1 could not object to:
`checkPayment` goes through the modern `URL`-built query rather than v1's raw
concatenation (a reference containing `&` or a space produced a different
request), and a third optional constructor argument takes `{ baseUrl, timeoutMs,
transport }` — sandbox, a budget v1 never had, and the seam the tests drive.

### Why the modern client is constructed lazily

v2 validates the encryption key eagerly, in the constructor. v1 validated
nothing: with a malformed key it failed per call and returned
`{ success: false }`. Validating in the compat constructor would turn a degraded
integration into a crash at startup — the opposite of "change one line".

So `Pesepay.client` builds the modern client on first use, inside the fold. It
is also the migration ramp: it hands back the real v2 client, so call sites move
one at a time without a second object holding the same two secrets.

### The fold, and the table that proves it

v1 code has no `catch`, so a typed error escaping this layer is a crash in an
application that used to keep running. Every error class is provoked
deliberately and asserted to fold — and from **all four** async methods, not
just one:

| provoked | folds |
|---|---|
| `PesepayApiError` (400) | ✅ |
| `PesepayAuthError` (404 unknown key, 403 disabled) | ✅ |
| `PesepayApiError` (500, `"Failed to decrypt your data"`) | ✅ |
| `PesepayCryptoError` (response encrypted with another key) | ✅ |
| `PesepayNetworkError` | ✅ |
| `PesepayTimeoutError` | ✅ |
| `PesepayConfigError` (negative amount) | ✅ |
| `PesepayConfigError` (malformed key, at lazy construction) | ✅ |
| a plain `Error` | ✅ — its own message |
| a thrown string | ✅ — `'Something went wrong!'` |

Each row first asserts the error **is** the class it claims, through
`pesepay.client`, before asserting the fold. Without that, a client that stopped
throwing the error would leave every fold assertion passing and proving nothing.

And the redaction from stage 4 is re-pinned at this boundary: a gateway that
echoes both keys must not put either into a `{ success: false }` message, which
is now a string a v1 application logs.

### Mutation testing — fifteen injected, fifteen caught

| mutation | result |
|---|---|
| `pollTransaction` stops folding | **10 failures** |
| `fold` reports `success: true` | **10 failures** |
| `export *` in `index.mts` | **3 failures** |
| drop `isPaid` from the `.mts` re-export list | **3 failures** |
| export `encryptPayload` from `index.ts` | **2 failures** |
| missing `resultUrl` folds instead of throwing | **2 failures** |
| the payment object is no longer mutated | **2 failures** |
| `fold` swallows the server's message | **2 failures** |
| re-export the `*Request` wire shapes | 1 failure |
| `paid` derived from `isTerminal` | 1 failure |
| eager construction of the modern client | 1 failure |
| `redirectUrl` passed through from a poll | 1 failure |
| `createPayment` accepts neither email nor phone | 1 failure |
| the customer object forwarded whole | **survived at first** — see below |

The customer mutant survived because the behaviour it broke was
`JSON.stringify`'s, not ours: `{ ...customer }` forwards `email: undefined`, and
`JSON.stringify` drops it, so the wire was identical. The helper's real job is
to narrow to the three fields the server declares — v1 serialised the customer
whole, so anything a caller hung off it went to the gateway too. The comment now
says that, and a test that sets a stray property on the customer kills the
mutant.

One more thing checked rather than assumed: the declaration tests strip TSDoc
before matching. `removeComments` is off for the build, so a type named only in
prose would otherwise satisfy a search for it — which is exactly how the
"request shapes stay internal" test failed on its first run, against this
file's own explanatory comment.

Tarball is **53 files / 81.0 KB packed**, still nothing outside `dist/`, `src/`,
`package.json`, `README`, `LICENSE`. No test files, no `scripts/`.

## Stage 7 — done

`README.md` (610 lines, rewritten from v1's), `MIGRATION.md` (378),
`CHANGELOG.md` (174), and the harness that keeps them honest:
`test/docs/snippets.test.mts` plus `test/fixtures/markdown.mts`. `npm run
verify` is green end to end — lint, typecheck, build, **268 tests**,
`publint --strict`, `attw` clean in every resolution mode.

### Every code block is compiled, not proofread

31 fenced blocks across the three documents are extracted into
`test/docs/generated/` and handed to one `tsc` run. They resolve `pesepay` and
`pesepay/v1-compat` **by self-reference through the package's own `exports`
map**, so they are checked against the declarations a consumer installs rather
than against `src/`. The run costs ~250 ms.

Four things had to be discovered rather than assumed:

- **TypeScript skips dot-directories in `include` globs.** The first attempt
  generated into `test/docs/.probe/` and got TS18003 "No inputs were found".
- **`extends` inherits `exclude`.** The root `tsconfig.json` excludes
  `test/docs/generated` so `npm run typecheck` does not trip over output that
  only exists mid-test — and the generated config inherited that and excluded
  itself. It sets `exclude: []` to undo it.
- **A bare `require()` is typed `any`.** So every `require('x')` is rewritten to
  `require('x') as typeof import('x')`. Without it the v1 blocks — the ones
  whose entire promise is that they are unchanged — would have compiled no
  matter what they said.
- **`.cts` vs `.mts` is chosen by whether the block calls `require`**, because
  `.mts` allows the top-level `await` every async example uses, and `.cts` is
  what makes `require` legal.

A block tagged ```` ```js v1 ```` has `require('pesepay')` redirected to
`require('pesepay/v1-compat')` and is then compiled. That redirect *is* the
compat layer's claim — "the import is the only line that changes" — so the test
performs it mechanically instead of restating it in prose.

Names the documentation elides (`app`, `express`, `log`, `creditOnce`) are
ambient globals in a generated `globals.d.ts`; `export {}` is appended to every
snippet so module scope can shadow them, which is what lets a snippet declare
its own `const pesepay`.

### Mutation testing — five injected, three killed, two were not bugs

| mutation | result |
|---|---|
| `currencyCode:` → `currency:` in the seamless example | **caught** — typecheck |
| import `decryptPayload` (internal) from `pesepay` | **caught twice** — typecheck *and* the public-API test |
| a `v1` block calling `getActiveCurrencies` | **caught** — typecheck, against the compat declarations |
| `parseCallback({})` added to a block | survived — and correctly: `body` is `unknown`, so it is valid |
| the `v1` tag dropped from the construction block | survived — and correctly: `new Pesepay(k, e)` with settable URLs compiles against **both** APIs, which is the compatibility the document claims |

The last two were bad mutations, not gaps. The second is worth keeping in mind:
a `v1` block that happens to be valid v2 will pass either way, so the tag is a
statement about intent that the harness cannot check.

### `PUBLIC_VALUES` moved, and is now read from both ends

The arrays live in `test/fixtures/public-api.mts`; `test/dist/exports.test.mts`
imports them. Two tests now read the one list from opposite directions —
exports asserts every name exists in both flavours, docs asserts the markdown
imports nothing that is *not* there. A name the docs need must be added to
`src/index.ts` and to that file together, or one of the two fails.

(Exporting the arrays from `exports.test.mts` itself would have re-registered
its 20-odd tests inside the docs test's process. A fixture is the only way to
share them.)

### The documentation's own claims, checked against the source

- The `403` / `404` / `500` table, `isRetryable()`, and "a timeout is not a
  failed payment" are taken from `errors.ts`, not paraphrased.
- The Express handler is `parseCallback`'s TSDoc verbatim, with each of the
  three steps tied in a table to the property of
  `PaymentTransactionResultPosterImpl` that forces it.
- **The historical changelog entries were read off git rather than invented.**
  The first draft dated 1.0.3 to 2023 and credited it with a
  `setRequiredFields` change that already existed at its parent commit. What
  1.0.3 (2021-10-25) actually did was introduce `PesepayResponse`; what 1.0.4
  (2024-06-22) did was set `insecureHTTPParser` unconditionally, add a
  `Content-Type` header, and move error messages from
  `error.response.data.message` to `error.message`.
- `npm install pesepay@1.0.4`, not `@v1` — the `v1` dist-tag does not exist
  until stage 8 publishes it.

### Not shipped in the tarball

`MIGRATION.md` and `CHANGELOG.md` stay out of `files`, so the tarball is still
`dist/`, `src/`, `package.json`, `README`, `LICENSE` and nothing else — now
**53 files / 88.6 KB packed**, the growth being the 25.4 KB README. npmjs.com
rewrites relative links against the repository, so the README's links to both
documents resolve on the registry page.

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
