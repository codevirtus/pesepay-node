# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-09-11

A complete rewrite. The package is now a zero-dependency, TypeScript-first SDK
that reports all 17 transaction statuses and throws typed errors.

`require('pesepay/v1-compat')` restores the 1.x surface exactly and is the only
line most integrations need to change:

```js
const { Pesepay } = require('pesepay/v1-compat');
```

See [MIGRATION.md](MIGRATION.md).

### Breaking

- **Methods throw instead of resolving `{ success: false, message }`.** Every
  failure is now an error extending `PesepayError`, so "your key is disabled",
  "the socket dropped" and "you sent a negative amount" stop being one string.
  1.x code has no `catch`; `pesepay/v1-compat` folds errors back for you.
- **`PesepayResponse` is gone.** `initiateTransaction` returns
  `{ referenceNumber, pollUrl, redirectUrl }`; the other payment methods return
  a `PaymentResult` carrying the gateway's real `transactionStatus`, its code
  and description, the fee split in `amountDetails`, and your metadata — plus
  `paid` and `isTerminal`.
- **`createTransaction` and `createPayment` are gone.** Both were object
  builders for a single call; that call now takes named options. The 1.x
  `makeSeamlessPayment(payment, reason, amount, fields)` positional order was
  easy to transpose and impossible for a compiler to catch.
- **The constructor takes an options object**: `{ integrationKey,
  encryptionKey, resultUrl, returnUrl, timeoutMs?, baseUrl?, transport? }`. The
  1.x positional form `new Pesepay(integrationKey, encryptionKey)` still
  constructs the same class, with the URLs as settable properties.
- **The encryption key is validated eagerly**, in the constructor. It must be
  exactly 32 ASCII characters; a bad one throws `PesepayConfigError` before any
  socket, where 1.x failed per call. The compat layer defers this so the failure
  still folds.
- **`resultUrl` and `returnUrl` are validated client-side.** A blank or
  malformed one is rejected instead of being sent: the gateway silently
  substitutes the literal string `"NONE"`, which yields a transaction whose
  outcome is never delivered anywhere.
- **`insecureHTTPParser` is no longer set on every request.** 1.0.4 set it
  unconditionally, opting every user out of response-smuggling protection. The
  transport now tries the strict parser first and retries once, on a parse error
  only.
- **Node.js 22.12 or newer** is required.
- **`redirectUrl` is no longer read from poll responses.** The gateway declares
  the field but has it commented out, so 1.x's read of it was always
  `undefined`. It is returned only by `initiateTransaction`.
- **The `default` export is gone.** Use the named `Pesepay` export.

### Added

- **All 17 transaction statuses** as `TransactionStatus`, with
  `TRANSACTION_STATUS_CODES`, `TRANSACTION_STATUS_DESCRIPTIONS`,
  `TERMINAL_TRANSACTION_STATUSES`, `NON_TERMINAL_TRANSACTION_STATUSES`,
  `isPaid`, `isTerminal` and `isTransactionStatus`. `PENDING`, `DECLINED` and
  `REVERSED` are now three distinguishable outcomes rather than one
  `paid: false`.
- **A typed error hierarchy**: `PesepayError`, `PesepayApiError`,
  `PesepayAuthError`, `PesepayCryptoError`, `PesepayNetworkError`,
  `PesepayTimeoutError`, `PesepayConfigError`, each with a stable `code`.
  `PesepayApiError.isRetryable()` and `isEncryptionKeyMismatch()` encode a
  status-code mapping that reads backwards: `403` is a disabled key, `404` an
  unknown one, and a `500` saying `"Failed to decrypt your data"` means the
  encryption key is wrong.
- **`parseCallback(body, headers?)`** for the `resultUrl` webhook — decodes the
  plain-JSON callback and reports `keyVerified` plus a `keyStatus` separating
  `'absent'` (the gateway's own key lookup failed) from `'mismatched'`. The
  integration key is compared in constant time. The documentation is blunt
  about what this can and cannot prove.
- **Invoices**: `initiateInvoice(options)` and `checkInvoice(invoiceNumber)`,
  including conversion to the gateway's `MM/DD/YYYY` dates from a `Date` or an
  ISO string.
- **The catalogue**: `getActiveCurrencies()`, `getPaymentMethods(currencyCode)`
  and `getActivePaymentMethods()`. No credential is sent to these endpoints;
  they are unauthenticated server-side and do not ask for one.
- **`timeoutMs`**, default 30 s. 1.x had no timeout, so a hung socket hung the
  request.
- **`baseUrl`**, for `https://api.test.pesepay.com/api/payments-engine`.
- **`transport`**, the HTTP seam — a proxy, instrumentation, retries, or a test
  double. `createHttpsTransport` and `httpsTransport` are exported.
- **`pesepay/v1-compat`**, the 1.x API backed by the 2.x client, with
  `.client` handing back the modern client so call sites migrate one at a time.
- **First-class TypeScript types** for the whole wire contract, read off the
  gateway's own source. Declarations keep their documentation, so editor hover
  is the API reference.
- **ESM and CommonJS from one compiled module**, so `require('pesepay')` and
  `import 'pesepay'` give the same classes and `instanceof` survives the
  boundary.
- A `LICENSE` file. 1.x declared MIT in `package.json` and shipped none.

### Changed

- **Zero runtime dependencies.** `axios` is gone; the transport is `node:https`.
- **`checkPayment` builds its query through `URL`.** 1.x concatenated the
  reference number raw, so one containing `&`, `#` or a space produced a
  silently different request. Carried into the compat layer deliberately.
- **`getActivePaymentMethods` reads `/v1/payment-methods/all-active`.** The
  similarly named `/active` returns a reduced DTO and silently drops every
  method needing a redirect, which makes "this method does not exist"
  indistinguishable from "this method needs a redirect".
- **Seamless payments always send `customer`**, because the gateway
  dereferences it without a null check and answers `500` with an NPE otherwise.
- The published tarball carries `dist/`, `src/`, `package.json`, `README.md` and
  `LICENSE`, and nothing else. 1.0.4 shipped 42 files including a stray
  `dist/test.js`.

### Fixed

- **Errors no longer carry key material.** No message, property, stack or
  `cause` can hold either key: the keys are `#private` fields, so
  `JSON.stringify(pesepay)` publishes neither, OpenSSL error details are never
  attached, and anything the gateway echoes is redacted before it becomes an
  error message. Errors end up in log aggregators.
- **The status code is checked before the body is decrypted.** Errors are always
  plain JSON, never the `{ payload }` envelope, so decrypting first turned "your
  integration key is unknown" into a padding error and sent people rotating the
  wrong credential.
- **A malformed response is reported as an error** rather than yielding an
  object with `undefined` fields. AES-CBC has no integrity protection, so the
  padding check is the only signal that a response is not what the gateway sent.
- **A timed-out request is never retried.** Replaying a `POST` to
  `/v1/payments/initiate` risks charging the customer twice; recovery is
  `checkPayment(referenceNumber)`.

### Security

- The integration key is never sent over cleartext HTTP to anything but
  loopback.
- Raw AES helpers (`encryptPayload`, `decryptPayload`) are not exported. Raw
  AES-256-CBC with no integrity protection is not a primitive to hand out.
- The `insecureHTTPParser` fallback is opt-out
  (`createHttpsTransport({ allowInsecureHttpParserFallback: false })`) and warns
  once per process when it is used.

## [1.0.4] - 2024-06-22

Released to npm but never committed; reconstructed into this repository's
history from the published tarball, which also contained a stray `dist/test.js`.

### Changed

- `insecureHTTPParser: true` on every axios request, to get past the gateway's
  malformed response headers.
- `Content-Type: application/json` added to the default headers.
- Error messages read from `error.message` rather than
  `error.response.data.message`, which threw when there was no response at all.

## [1.0.3] - 2021-10-25

### Changed

- Every method resolves a `PesepayResponse` — `{ success, message,
  referenceNumber, pollUrl, redirectUrl, paid }` — instead of returning the raw
  response body.

## 1.0.0 - 2021-10-11

Initial release.

[Unreleased]: https://github.com/codevirtus/pesepay-node/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/codevirtus/pesepay-node/compare/v1.0.4...v2.0.0
[1.0.4]: https://github.com/codevirtus/pesepay-node/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/codevirtus/pesepay-node/releases/tag/v1.0.3
