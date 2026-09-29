# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-09-29

A complete rewrite. The SDK now has zero dependencies, ships TypeScript types,
reports all 17 transaction statuses and throws typed errors.

To keep 1.x code running, change one line:

```js
const { Pesepay } = require('pesepay/v1-compat');
```

See the [migration guide](MIGRATION.md).

### Breaking

- **Methods throw instead of resolving `{ success: false, message }`.** Every
  error extends `PesepayError`. `pesepay/v1-compat` keeps the 1.x behaviour.
- **`PesepayResponse` is removed.** `initiateTransaction` returns
  `{ referenceNumber, pollUrl, redirectUrl }`. The other payment methods return a
  `PaymentResult` with `transactionStatus`, `paid`, `isTerminal`, the fee
  breakdown in `amountDetails`, and your metadata.
- **`createTransaction` and `createPayment` are removed.** Pass named options to
  `initiateTransaction` and `makeSeamlessPayment` instead.
- **The constructor takes an options object**: `{ integrationKey,
  encryptionKey, resultUrl, returnUrl, timeoutMs?, baseUrl?, transport? }`. The
  1.x form `new Pesepay(integrationKey, encryptionKey)` still works.
- **The encryption key is validated in the constructor.** It must be exactly 32
  ASCII characters, or the constructor throws `PesepayConfigError`.
- **`resultUrl` and `returnUrl` are validated** before any request is sent.
- **`redirectUrl` is returned only by `initiateTransaction`**, not by status
  checks.
- **The `default` export is removed.** Use the named `Pesepay` export.
- **Node.js 22.12 or newer** is required.

### Added

- **All 17 transaction statuses** as `TransactionStatus`, with
  `TRANSACTION_STATUS_CODES`, `TRANSACTION_STATUS_DESCRIPTIONS`,
  `TERMINAL_TRANSACTION_STATUSES`, `NON_TERMINAL_TRANSACTION_STATUSES`,
  `isPaid`, `isTerminal` and `isTransactionStatus`.
- **Typed errors**: `PesepayError`, `PesepayApiError`, `PesepayAuthError`,
  `PesepayCryptoError`, `PesepayNetworkError`, `PesepayTimeoutError` and
  `PesepayConfigError`, each with a stable `code`.
  `PesepayApiError.isRetryable()` and `isEncryptionKeyMismatch()` help you
  decide what to do next.
- **`parseCallback(body, headers?)`** reads payment notifications sent to
  `resultUrl` and verifies the integration key.
- **Invoices**: `initiateInvoice(options)` and `checkInvoice(invoiceNumber)`.
- **Currencies and payment methods**: `getActiveCurrencies()`,
  `getPaymentMethods(currencyCode)` and `getActivePaymentMethods()`.
- **`timeoutMs`** option, default 30 seconds.
- **`baseUrl`** option, for the sandbox.
- **`transport`** option, for proxies, logging or test doubles.
  `createHttpsTransport` and `httpsTransport` are exported.
- **`pesepay/v1-compat`**: the 1.x API on top of the 2.x client. Its `.client`
  property gives you the 2.x client, so you can migrate one call site at a time.
- **TypeScript types** for every option and result, with documentation shown on
  hover.
- **ESM and CommonJS** from the same module, so `instanceof` works across both.
- A `LICENSE` file.

### Changed

- **Zero runtime dependencies.** `axios` is removed.
- **`checkPayment` URL-encodes the reference number.**
- **`getActivePaymentMethods` returns every active method**, including those
  that require a redirect.
- The published package contains only `dist/`, `src/`, `package.json`,
  `README.md` and `LICENSE`.

### Fixed

- **Errors never contain your keys**, in their messages, properties or causes.
  `JSON.stringify(pesepay)` doesn't include them either.
- **A wrong integration key is reported as `PesepayAuthError`**, not as a
  decryption failure.
- **A malformed response throws** instead of returning an object with
  `undefined` fields.
- **A timed-out request is never retried**, so a payment is never sent twice.

### Security

- Keys are never sent over plain HTTP, except to loopback addresses for local
  testing.
- Node's lenient HTTP parser is no longer enabled for every request. It is used
  only as a fallback, and `createHttpsTransport({ allowInsecureHttpParserFallback: false })`
  turns it off.
- Published from CI with npm Trusted Publishing. Every 2.x release has a
  provenance attestation, which `npm audit signatures` verifies.

## [2.0.0-rc.1] - 2026-09-16

Release candidate for 2.0.0.

## [1.0.4] - 2024-06-22

### Changed

- Enabled Node's lenient HTTP parser on every request.
- Added `Content-Type: application/json` to the default headers.
- Error messages are read from `error.message`, which no longer throws when
  there is no response.

## [1.0.3] - 2021-10-25

### Changed

- Every method resolves a `PesepayResponse`: `{ success, message,
  referenceNumber, pollUrl, redirectUrl, paid }`.

## 1.0.0 - 2021-10-11

Initial release.

[Unreleased]: https://github.com/codevirtus/pesepay-node/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/codevirtus/pesepay-node/compare/v1.0.4...v2.0.0
[2.0.0-rc.1]: https://github.com/codevirtus/pesepay-node/compare/v1.0.4...v2.0.0-rc.1
[1.0.4]: https://github.com/codevirtus/pesepay-node/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/codevirtus/pesepay-node/releases/tag/v1.0.3
