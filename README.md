# pesepay

[![CI](https://github.com/codevirtus/pesepay-node/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/codevirtus/pesepay-node/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pesepay?logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/pesepay)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-5fa04e?logo=nodedotjs&logoColor=white)](https://nodejs.org/en/about/previous-releases)
[![dependencies](https://img.shields.io/badge/dependencies-0-4c1)](https://github.com/codevirtus/pesepay-node/blob/main/package.json)
[![licence](https://img.shields.io/npm/l/pesepay?color=blue)](https://github.com/codevirtus/pesepay-node/blob/main/LICENSE)

Official Node.js SDK for the [Pesepay](https://pesepay.com) payment gateway.

- **Zero runtime dependencies.**
- **TypeScript types included.** Works with both `import` and `require`.
- **All 17 transaction statuses**, not just a `paid` flag.
- **Typed errors** that tell you what went wrong and whether to retry.

Requires Node.js **22.12 or newer**.

> [!WARNING]
> **Server-side only.** This package uses your integration key and encryption
> key. Keep both in environment variables. Never commit them or send them to a
> browser.

You get both keys from your Pesepay merchant account. See the
[Pesepay developer documentation](https://developers.pesepay.com/).

Upgrading from 1.x? See the
[migration guide](https://github.com/codevirtus/pesepay-node/blob/main/MIGRATION.md).

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Redirect payments](#redirect-payments)
- [Seamless payments](#seamless-payments)
- [Checking a payment](#checking-a-payment)
- [Payment notifications (webhook)](#payment-notifications-webhook)
- [Invoices](#invoices)
- [Currencies and payment methods](#currencies-and-payment-methods)
- [Errors](#errors)
- [Configuration](#configuration)
- [API](#api)

## Install

```shell
npm install pesepay
```

## Quickstart

Create a transaction, then send the customer to `redirectUrl`.

```ts
import { Pesepay } from 'pesepay';

const { PESEPAY_INTEGRATION_KEY, PESEPAY_ENCRYPTION_KEY } = process.env;
if (!PESEPAY_INTEGRATION_KEY || !PESEPAY_ENCRYPTION_KEY) {
  throw new Error('Pesepay keys are missing from the environment.');
}

const pesepay = new Pesepay({
  integrationKey: PESEPAY_INTEGRATION_KEY,
  encryptionKey: PESEPAY_ENCRYPTION_KEY,
  resultUrl: 'https://example.com/pesepay/webhook',
  returnUrl: 'https://example.com/checkout/done',
});

const { referenceNumber, pollUrl, redirectUrl } = await pesepay.initiateTransaction({
  amount: 10.5,
  currencyCode: 'USD',
  reasonForPayment: 'Order #1024',
});
```

With CommonJS:

```js
const { Pesepay } = require('pesepay');
```

- `resultUrl` is where Pesepay sends [payment notifications](#payment-notifications-webhook).
- `returnUrl` is where the customer lands after paying.

Both are required and must be valid URLs.

## Redirect payments

Pesepay hosts the payment page. You redirect the customer to it.

```ts
const transaction = await pesepay.initiateTransaction({
  amount: 10.5,
  currencyCode: 'USD',
  reasonForPayment: 'Order #1024',
  merchantReference: 'order-1024',
  paymentMetadata: { orderId: '1024', customerId: '77' },
});

await saveOrder({
  referenceNumber: transaction.referenceNumber,
  pollUrl: transaction.pollUrl,
  redirectUrl: transaction.redirectUrl,
});
```

- **Save `redirectUrl`** if you might need to send the customer back to the
  payment page. Only `initiateTransaction` returns it.
- **`merchantReference`** is your own order ID. It comes back on every result
  for the transaction.
- **`paymentMetadata`** comes back as `transactionMetadata` on every result.
- **`paymentMethodCode`** (optional) skips Pesepay's method picker and sends the
  customer straight to that method, for example EcoCash.

## Seamless payments

The customer stays on your site. You collect the payment details, and Pesepay
charges the payment method directly.

```ts
const result = await pesepay.makeSeamlessPayment({
  amount: 5,
  currencyCode: 'USD',
  paymentMethodCode: 'PZW211',
  reasonForPayment: 'Order #1024',
  customer: { email: 'customer@example.com', phoneNumber: '0771111111' },
  requiredFields: { customerPhoneNumber: '0771111111' },
});

log.info(result.transactionStatus, result.paid, result.isTerminal);
```

- **`customer` is required**, with at least one of `email` or `phoneNumber`.
- **`requiredFields` keys are field `name`s** from the payment method's
  `requiredFields` list (see
  [Currencies and payment methods](#currencies-and-payment-methods)), not the
  `displayName`s.
- **The first result is usually `PENDING`.** Mobile money waits for the customer
  to approve on their phone. [Check the payment](#checking-a-payment) until it
  finishes.
- **Some methods can't be charged this way.** If a method's `redirectRequired`
  is `true`, use a [redirect payment](#redirect-payments) instead.

## Checking a payment

`checkPayment(referenceNumber)` and `pollTransaction(pollUrl)` return the same
`PaymentResult`. Use whichever one you saved.

```ts
import { isPaid, TransactionStatus } from 'pesepay';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let result = await pesepay.checkPayment(referenceNumber);

for (let attempt = 0; attempt < 20 && !result.isTerminal; attempt += 1) {
  await sleep(3_000);
  result = await pesepay.checkPayment(referenceNumber);
}

if (result.paid) {
  log.info('paid', result.amountDetails?.merchantAmount);
} else if (result.isTerminal) {
  log.warn('not paid', result.transactionStatus, result.transactionStatusDescription);
} else {
  log.warn('still pending after 20 attempts', result.referenceNumber);
}

// The same checks work on a status string you stored earlier.
log.info(isPaid(TransactionStatus.SUCCESS));
```

Every result has two flags:

- **`paid`** is `true` only for `SUCCESS`. It is `false` for `PARTIALLY_PAID`
  and for `REVERSED`.
- **`isTerminal`** is `true` once the status will not change again. Stop polling
  when it is `true`.

Both are plain properties, so they survive `JSON.stringify` and a round trip
through your database or queue.

**Reconcile with `amountDetails.merchantAmount`.** That is the amount you
receive after fees. It differs from `amountDetails.amount` and
`customerPayableAmount`.

### Transaction statuses

| status | code | final | paid |
|---|---|---|---|
| `INITIATED` | 301 | | |
| `PROCESSING` | 302 | | |
| `PENDING` | 303 | | |
| `PARTIALLY_PAID` | 315 | | |
| `SUCCESS` | 304 | ✅ | ✅ |
| `FAILED` | 300 | ✅ | |
| `TERMINATED` | 305 | ✅ | |
| `TIME_OUT` | 306 | ✅ | |
| `CLOSED` | 307 | ✅ | |
| `INSUFFICIENT_FUNDS` | 308 | ✅ | |
| `CANCELLED` | 309 | ✅ | |
| `ERROR` | 310 | ✅ | |
| `DECLINED` | 311 | ✅ | |
| `AUTHORIZATION_FAILED` | 312 | ✅ | |
| `SERVICE_UNAVAILABLE` | 313 | ✅ | |
| `REVERSED` | 314 | ✅ | |
| `CLOSED_PERIOD_ELAPSED` | 307 | ✅ | |

Branch on `transactionStatus`, not `transactionStatusCode`: `CLOSED` and
`CLOSED_PERIOD_ELAPSED` share code `307`.

An unrecognised status is treated as final, so a polling loop always stops.

`TRANSACTION_STATUS_CODES` and `TRANSACTION_STATUS_DESCRIPTIONS` hold Pesepay's
codes and descriptions for display.

## Payment notifications (webhook)

When a transaction reaches a final status, Pesepay sends a `POST` request to
your `resultUrl`. `parseCallback` reads the request body and checks that the
request carries your integration key.

```ts
app.post('/pesepay/webhook', express.json(), async (req, res) => {
  // 1. Respond right away, before doing any work.
  res.sendStatus(200);

  const { result, keyVerified } = pesepay.parseCallback(req.body, req.headers);
  if (!keyVerified) log.warn('unverified pesepay callback', result.referenceNumber);

  // 2. Confirm the outcome with Pesepay before acting on it.
  const confirmed = await pesepay.checkPayment(result.referenceNumber);

  // 3. Handle each (referenceNumber, transactionStatus) pair only once.
  await creditOnce(confirmed.referenceNumber, confirmed.transactionStatus, confirmed);
});
```

Follow all three steps:

1. **Respond with `200` first**, then do the work, so a slow or failing handler
   doesn't lose the notification. Don't rely on notifications alone: also poll
   `checkPayment` for any order that stays pending.
2. **Confirm with `checkPayment`.** Treat the notification as a signal to
   check, not as proof of payment. `checkPayment` returns the authoritative
   status.
3. **Make the handler idempotent on `referenceNumber` and
   `transactionStatus`.** One transaction can notify more than once. For
   example, you might get `SUCCESS` and later `REVERSED`.

### Key verification

`keyVerified` is `true` when the request's `Authorization` header matches your
integration key exactly. `keyStatus` says why a check failed:

| `keyStatus` | meaning |
|---|---|
| `'matched'` | The header matches your integration key. |
| `'absent'` | The request has no `Authorization` header. |
| `'mismatched'` | The header holds a different value, such as an old key after you rotated it, or a request that did not come from Pesepay. |

`parseCallback` does not throw on a missing header. It reports `'absent'`.

### Accepted input

- **`body`**: the parsed JSON object (for example from `express.json()`), a JSON
  string, or the raw `Buffer`.
- **`headers`** (optional): header names are matched case-insensitively, so you
  can pass Node's `req.headers` as-is.

## Invoices

Pesepay emails the payer a payment link. There is no checkout page and no
`redirectUrl`.

```ts
const invoice = await pesepay.initiateInvoice({
  amount: 250,
  currencyCode: 'USD',
  narrative: 'Consulting retainer, September',
  payer: { name: 'Tendai Moyo', email: 'tendai@example.com' },
  applicationCode: 'APP-CODE',
  processingDate: '2026-09-15',
  dueDate: '2026-09-30',
  initiatorReference: 'retainer-2026-09',
});

const payment = await pesepay.checkInvoice(invoice.invoiceNumber);
log.info(invoice.invoiceNumber, invoice.pollUrl, payment.paid);
```

- **`applicationCode` is required.** Invoices identify your application by this
  code, not by your integration key.
- **Dates** can be a `Date`, `'YYYY-MM-DD'` or `'MM/DD/YYYY'`. A `Date` is read in
  UTC.
- **`initiatorReference` must be unique** across your invoices. Pesepay rejects a
  repeated one, so you can use it to avoid creating duplicates.
- **`invoiceNumber` is also the transaction's reference number.**
  `checkInvoice` returns a `PaymentResult`, with the same `paid` and `isTerminal`
  flags as any other payment. You can also pass the invoice's `pollUrl` to
  `pollTransaction`.
- **Recurring invoices** need `recurring: true` and a `recurringFrequency`.

## Currencies and payment methods

These endpoints are public. No keys are sent.

```ts
const currencies = await pesepay.getActiveCurrencies();
const methods = await pesepay.getPaymentMethods('USD');

for (const method of methods) {
  log.info(method.code, method.name, method.redirectRequired, method.minimumAmount);
  for (const field of method.requiredFields ?? []) {
    log.info(field.name, field.displayName, field.fieldType, field.optional);
  }
}

const everything = await pesepay.getActivePaymentMethods();
log.info(currencies.map((currency) => currency.code), everything.length);
```

- **Use `getActiveCurrencies`** instead of hard-coding currency codes. Pesepay
  rejects a currency your account isn't set up for.
- **Prefer `getPaymentMethods(currencyCode)`.** `getActivePaymentMethods()`
  returns methods for all currencies, so you'd need to filter each one by its
  `currencies` list.
- **Check `minimumAmount` and `maximumAmount`** before you submit a payment.
- **Use `requiredFields`** to build the form for a seamless payment.

## Errors

Every method throws on failure. Every error extends `PesepayError`.

```
PesepayError
├── PesepayApiError        Pesepay responded with a non-2xx status
│   └── PesepayAuthError   403 or 404: a problem with your integration key
├── PesepayCryptoError     encryption or decryption failed
├── PesepayNetworkError    no response at all
│   └── PesepayTimeoutError
└── PesepayConfigError     invalid configuration or arguments (thrown before any request)
```

```ts
import { PesepayApiError, PesepayAuthError, PesepayConfigError, PesepayTimeoutError } from 'pesepay';

try {
  await pesepay.makeSeamlessPayment({
    amount: 5,
    currencyCode: 'USD',
    paymentMethodCode: 'PZW211',
    reasonForPayment: 'Order #1024',
    customer: { phoneNumber: '0771111111' },
  });
} catch (error) {
  if (error instanceof PesepayTimeoutError) {
    // The payment may still have gone through. See "Timeouts" below.
    log.warn('timed out after', error.timeoutMs);
  } else if (error instanceof PesepayAuthError) {
    // 404: the key is unknown. 403: the key is disabled.
    log.error('integration key rejected', error.status);
  } else if (error instanceof PesepayApiError && error.isEncryptionKeyMismatch()) {
    log.error('the encryption key does not match this integration key');
  } else if (error instanceof PesepayApiError && error.isRetryable()) {
    log.warn('temporary failure', error.status, error.serverMessage);
  } else if (error instanceof PesepayConfigError) {
    log.error('invalid call', error.message);
  } else {
    throw error;
  }
}
```

Every error also has a stable `code` string, such as `'ERR_PESEPAY_AUTH'`, for
logging and for places where `instanceof` doesn't work.

Error messages and properties never contain your keys.

### Troubleshooting status codes

| status | meaning | error | `isRetryable()` |
|---|---|---|---|
| `403` | Your integration key is **disabled**. | `PesepayAuthError` | `false` |
| `404` | Your integration key is **not recognised**. This does not mean the URL is wrong. | `PesepayAuthError` | `false` |
| `500` with `"Failed to decrypt your data"` | Your **encryption key** is wrong. `isEncryptionKeyMismatch()` returns `true`. | `PesepayApiError` | `false` |
| `408`, `429`, other `5xx` | A temporary problem. | `PesepayApiError` | `true` |
| other `4xx` | The request was rejected. Read `error.serverMessage`. | `PesepayApiError` | `false` |

If you get a `404`, check that your key belongs to the environment you are
calling. For example, a live key sent to the sandbox returns `404`.

Use `isRetryable()` instead of hard-coding this table.

### Timeouts

> [!CAUTION]
> A `PesepayTimeoutError` means no response arrived in time. **The payment may
> still have gone through.**

Never retry the payment call after a timeout, or you may charge the customer
twice. Call `checkPayment(referenceNumber)` to find out what happened:

```ts
import { PesepayTimeoutError } from 'pesepay';

try {
  await pesepay.makeSeamlessPayment({
    amount: 5,
    currencyCode: 'USD',
    paymentMethodCode: 'PZW211',
    reasonForPayment: 'Order #1024',
    customer: { phoneNumber: '0771111111' },
    merchantReference: 'order-1024',
  });
} catch (error) {
  if (!(error instanceof PesepayTimeoutError)) throw error;

  // Check the outcome. Do not retry the charge.
  const actual = await pesepay.checkPayment(referenceNumber);
  log.warn('recovered after timeout', actual.transactionStatus, actual.paid);
}
```

If `initiateTransaction` times out, you won't have a reference number yet. Set
`merchantReference` on every call so you can match the transaction to your
order later.

The SDK never retries a request that timed out.

## Configuration

```ts
import { Pesepay, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, VERSION } from 'pesepay';

const sandbox = new Pesepay({
  integrationKey: 'your-integration-key',
  encryptionKey: '0123456789abcdef0123456789abcdef',
  resultUrl: 'https://example.com/pesepay/webhook',
  returnUrl: 'https://example.com/checkout/done',
  baseUrl: 'https://api.test.pesepay.com/api/payments-engine',
  timeoutMs: 15_000,
});

log.info(sandbox.baseUrl, sandbox.timeoutMs, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, VERSION);
```

| option | default | notes |
|---|---|---|
| `integrationKey` | — | Required. |
| `encryptionKey` | — | Required. Must be exactly 32 ASCII characters. An invalid key throws `PesepayConfigError` in the constructor. |
| `resultUrl` | — | Where Pesepay sends payment notifications. Required for `initiateTransaction`, `makeSeamlessPayment` and `initiateInvoice`. |
| `returnUrl` | — | Where the customer lands after paying on Pesepay's page. |
| `timeoutMs` | `30_000` | Time limit for each call, in milliseconds. |
| `baseUrl` | `https://api.pesepay.com/api/payments-engine` | Use `https://api.test.pesepay.com/api/payments-engine` for the sandbox. |
| `transport` | `httpsTransport` | A custom HTTP function. See below. |

`resultUrl` and `returnUrl` are also settable properties, and each call can
override them. The 1.x constructor form also works:

```ts
import { Pesepay } from 'pesepay';

const pesepay = new Pesepay('INTEGRATION KEY', '0123456789abcdef0123456789abcdef');
pesepay.resultUrl = 'https://example.com/pesepay/webhook';
pesepay.returnUrl = 'https://example.com/checkout/done';
```

### Custom transport

All HTTP requests go through one function, `transport`. Replace it to add
logging, route through a proxy, or use a test double.

```ts
import { httpsTransport, Pesepay, type Transport } from 'pesepay';

const timed: Transport = async (request) => {
  const started = Date.now();
  const response = await httpsTransport(request);
  log.info(request.method, request.url, response.status, Date.now() - started);
  return response;
};

const instrumented = new Pesepay({
  integrationKey: 'your-integration-key',
  encryptionKey: '0123456789abcdef0123456789abcdef',
  transport: timed,
});

log.info(instrumented.baseUrl);
```

`createHttpsTransport(options)` builds the default transport with options. See
`HttpsTransportOptions` in your editor for details.

The default transport sends requests only over HTTPS. Plain HTTP is allowed
only to loopback addresses such as `localhost`, for local testing.

## API

| method | returns |
|---|---|
| `initiateTransaction(options)` | `referenceNumber`, `pollUrl` and `redirectUrl` for a hosted payment |
| `makeSeamlessPayment(options)` | a `PaymentResult` for a direct charge |
| `checkPayment(referenceNumber)` | the transaction's current `PaymentResult` |
| `pollTransaction(pollUrl)` | the same, looked up by `pollUrl` |
| `initiateInvoice(options)` | the new invoice. Pesepay emails the payer. |
| `checkInvoice(invoiceNumber)` | the invoice's `PaymentResult` |
| `getActiveCurrencies()` | currencies your account can use |
| `getPaymentMethods(currencyCode)` | payment methods for one currency |
| `getActivePaymentMethods()` | payment methods for all currencies |
| `parseCallback(body, headers?)` | the notification's `result`, `keyVerified` and `keyStatus` |

Also exported: `TransactionStatus`, `isPaid`, `isTerminal`,
`isTransactionStatus`, `TERMINAL_TRANSACTION_STATUSES`,
`NON_TERMINAL_TRANSACTION_STATUSES`, `TRANSACTION_STATUS_CODES`,
`TRANSACTION_STATUS_DESCRIPTIONS`, the seven error classes, `DEFAULT_BASE_URL`,
`DEFAULT_TIMEOUT_MS`, `VERSION`, `createHttpsTransport`, `httpsTransport`, and
their types.

Every option and field is documented in the type declarations, so your editor
shows the details on hover.

## Upgrading from 1.x

Change one line and your 1.x code keeps working:

```js v1
const { Pesepay } = require('pesepay');
```

becomes

```js
const { Pesepay } = require('pesepay/v1-compat');
```

The compatibility layer reports only `paid`, so it can't tell `PENDING` from
`DECLINED` from `REVERSED`. Plan to move to the 2.x API. The
[migration guide](https://github.com/codevirtus/pesepay-node/blob/main/MIGRATION.md)
walks through each method.

## Contributing

```shell
npm install
npm run verify     # lint, typecheck, build, test, package checks
```

Every code block in this README is compiled against the built package during
`npm test`.

## Licence

MIT. See [LICENSE](https://github.com/codevirtus/pesepay-node/blob/main/LICENSE).
