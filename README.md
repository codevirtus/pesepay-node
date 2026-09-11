# pesepay

Official Node.js SDK for the [Pesepay](https://pesepay.com) payment gateway.

- **Zero runtime dependencies.** Nothing but `node:` builtins.
- **TypeScript-first**, with CommonJS and ESM from one compiled module — so
  `require('pesepay')` and `import 'pesepay'` give you the *same* classes, and
  `instanceof` keeps working across the boundary.
- **All 17 transaction statuses**, not a `paid` boolean. `PENDING`, `DECLINED`
  and `REVERSED` are three different things to do next.
- **Typed errors** that tell you which credential is wrong.

Requires Node.js **22.12 or newer**.

> [!WARNING]
> **Server-side only.** This package holds your integration key and your
> encryption key. There is no browser build and there should not be one: a key
> that reaches a browser is a key that has been published. Keep both in
> environment variables, never in source control, and never ship them to a
> client.

Upgrading from 1.x? See **[MIGRATION.md](MIGRATION.md)** — the zero-effort step
is one line.

## Install

```shell
npm install pesepay
```

## Quickstart

Two calls: create the transaction, send the customer to `redirectUrl`.

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

CommonJS works the same way:

```js
const { Pesepay } = require('pesepay');
```

`resultUrl` and `returnUrl` are both required by the gateway, and neither is
validated by it: a blank or missing one is silently replaced server-side with
the literal string `"NONE"`, which produces a transaction whose outcome you are
never told about. This package rejects them up front instead.

## Redirect payments

The hosted flow. Pesepay presents the payment page; you get a `redirectUrl`.

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

> [!IMPORTANT]
> **`redirectUrl` exists only here.** The gateway declares one on transaction
> results but has it commented out, so no later poll, check or webhook hands it
> back. Store it with the reference number if you need to re-send a customer to
> the payment page.

`merchantReference` is echoed back on every result for that transaction, and
`paymentMetadata` comes back as `transactionMetadata` — both are how you find
your own order again without a lookup table.

Pass `paymentMethodCode` to skip Pesepay's method picker and land the customer
straight on, say, EcoCash.

## Seamless payments

The customer never leaves your site: you collect the details and the gateway
charges directly. There is no redirect and no hosted page.

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

Three things to get right:

- **`customer` is mandatory.** At least one of `email` or `phoneNumber` must be
  set. The gateway dereferences the customer without a null check, so omitting
  it answers `500` with a `NullPointerException` rather than a useful message —
  this package refuses the call before it leaves your process.
- **`requiredFields` is keyed by each field's wire `name`**, which you read from
  the payment method's `requiredFields` — not by its `displayName`.
- **The result is usually not terminal.** A mobile-money charge comes back
  `PENDING` while the customer's handset is still showing the prompt. Keep
  polling.

Not every method can be charged this way: a method whose `redirectRequired` is
`true` must go through the hosted flow.

## Polling

`checkPayment(referenceNumber)` and `pollTransaction(pollUrl)` both return the
same `PaymentResult`. Use whichever handle you kept.

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

// The same two questions, answered from a raw status string — a queue message,
// say, or a row read back out of your database.
log.info(isPaid(TransactionStatus.SUCCESS));
```

Every result carries `paid` and `isTerminal` as plain data, so a result survives
`JSON.stringify`, `structuredClone` and a trip through a queue with both answers
intact.

- **`paid` is `true` only for `SUCCESS`.** Not for `PARTIALLY_PAID` (money
  arrived, but not the amount you asked for) and not for `REVERSED` (you were
  paid, and then you were not).
- **`isTerminal` is `false` for exactly four statuses** — `INITIATED`,
  `PROCESSING`, `PENDING`, `PARTIALLY_PAID`. A status Pesepay adds in future is
  treated as terminal, so a poll loop stops rather than spinning forever.

Reconcile against `amountDetails.merchantAmount`, which is what settles to you.
The gateway computes a fee split rather than echoing what you sent, so
`amountDetails.amount` and `customerPayableAmount` are different numbers.

### The statuses

| status | code | terminal | paid |
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

`CLOSED` and `CLOSED_PERIOD_ELAPSED` share code `307`, so **a status code cannot
be mapped back to a status.** Branch on `transactionStatus`; treat
`transactionStatusCode` as something to log.

`TRANSACTION_STATUS_CODES` and `TRANSACTION_STATUS_DESCRIPTIONS` hold the
gateway's own numbers and wording if you need to display them.

## The result-url webhook

Pesepay POSTs the transaction result to your `resultUrl` whenever the status
reaches a terminal value. `parseCallback` decodes that body and tells you
whether the request carried your integration key.

```ts
app.post('/pesepay/webhook', express.json(), async (req, res) => {
  // 1. Answer immediately. There are no retries — a slow or failing
  //    response loses the notification permanently.
  res.sendStatus(200);

  const { result, keyVerified } = pesepay.parseCallback(req.body, req.headers);
  if (!keyVerified) log.warn('unverified pesepay callback', result.referenceNumber);

  // 2. Re-verify over the authenticated, encrypted API before acting.
  const confirmed = await pesepay.checkPayment(result.referenceNumber);

  // 3. Be idempotent on referenceNumber + transactionStatus.
  await creditOnce(confirmed.referenceNumber, confirmed.transactionStatus, confirmed);
});
```

Each step is forced by something the gateway does. This is not defensive
boilerplate; drop any one of the three and you have a specific, reproducible
bug.

**The callback is not authenticated.** There is no HMAC and no signature — not a
weak one, none. The only credential is an `Authorization` header holding your
integration key verbatim. So:

| step | the property that forces it |
|---|---|
| **Respond first**, before any work | The gateway posts **once**. It catches every exception, logs it, and moves on — no retries, no backoff, no dead-letter. A 500 from your handler, a timeout, a deploy mid-post, and the notification is gone for good. |
| **Re-verify** through `checkPayment` | The header is **absent entirely** when the gateway's own key lookup fails, and it posts the body anyway. So an unverified callback is a body anyone could have sent. And `keyVerified: true` proves only that the sender knew a key you also put in an outbound header on every API call — evidence, not proof, and it says nothing about the *contents* being untampered. `checkPayment` is encrypted, authenticated by your key, and answered by the gateway; it is the only channel here that establishes what happened. |
| **Be idempotent on `referenceNumber` + `transactionStatus`** | A reversal arrives as a **second callback**. The gateway posts on every terminal status change, so one transaction delivers `SUCCESS` and then, later, `REVERSED`. A handler keyed on the reference alone either ignores the reversal or double-credits the success. |

### `keyStatus`, and why it is not just a boolean

`parseCallback` returns `keyStatus` alongside `keyVerified`, separating the two
ways verification fails — they are different incidents and deserve different
alerts.

| `keyStatus` | meaning | what to do |
|---|---|---|
| `'matched'` | the header held your integration key | proceed to step 2 |
| `'absent'` | no `Authorization` header at all | **your own account is misconfigured** — the gateway could not find an integration key for the application and posted anyway |
| `'mismatched'` | a header was present and held something else | a key you rotated and did not finish rolling out, or a request that did not come from Pesepay |

A missing header never throws: the gateway genuinely sends none, and a webhook
endpoint that crashes on that is worse than one that records the fact.

The comparison is constant-time, and verbatim — no `Bearer` prefix is stripped
and nothing is trimmed, because the gateway sets the header to the raw key and
leniency would only widen what counts as a match.

### What it accepts

The body as a parsed object (`express.json()`), a JSON string, or the raw
`Buffer`. Unlike every other response from this gateway the callback is **plain,
unencrypted JSON** — not the `{ payload }` envelope — so nothing is decrypted,
and a body that *is* an envelope is rejected with that explanation rather than
quietly mis-parsed. `headers` is optional and matched case-insensitively; Node's
`req.headers` fits as-is.

## Invoices

Pesepay emails the payer a payment link and collects on your behalf. There is no
checkout to present and no `redirectUrl` to send anyone to.

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

Four things are unlike every other endpoint here:

1. **`applicationCode` is required.** The gateway resolves the owning
   application from that field and never from your integration key — every other
   call in this SDK identifies you by the key header, this one does not. Omit it
   and the gateway answers `500`; this package refuses first.
2. **Dates are `MM/DD/YYYY` on the wire**, parsed by a hand-written formatter
   rather than by Jackson, so ISO-8601 does not work there. A `Date`, an ISO
   `'YYYY-MM-DD'` string, or the gateway's own `'MM/DD/YYYY'` are all accepted
   here and converted. A `Date` is read in **UTC** — `new Date('2026-09-15')` is
   UTC midnight, and reading local components would make the due date a day
   early for everyone west of Greenwich.
3. **`initiatorReference` must be unique** across your invoices; the gateway
   rejects a repeat. That makes it a usable idempotency key.
4. **`invoiceNumber` is the reference number.** It is a zero-padded row id such
   as `0001042`, and it is the reference of the transaction created when the
   payer pays — which is why `checkInvoice` answers with a `PaymentResult`, with
   `paid` and `isTerminal` meaning what they always mean.

`recurring: true` needs a `recurringFrequency`; without one the gateway asserts
rather than validates, and answers `500`. The invoice's `pollUrl` carries
`?invoiceNumber=`, not `?referenceNumber=` — it is still a valid argument to
`pollTransaction`.

## The catalogue

What your account can transact in, and what it can be charged with. Both are
plain, unencrypted, and public — this package deliberately sends **no
credential** to them, because they do not ask for one.

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

Call `getActiveCurrencies` before a checkout rather than hard-coding a code: a
currency your account is not configured for is rejected at initiate time,
several steps further into a checkout than here.

`getPaymentMethods(currencyCode)` is the one to prefer. `getActivePaymentMethods()`
returns every active method across all currencies, and each still has to be
filtered against its own `currencies` array before it can be offered.

Check `minimumAmount` and `maximumAmount` client-side, and read `requiredFields`
to build the form a seamless charge needs.

## Errors

Every failure is a throw, and every error extends `PesepayError`.

```
PesepayError
├── PesepayApiError        the gateway answered, and it was not a 2xx
│   └── PesepayAuthError   403 or 404 — your integration key
├── PesepayCryptoError     encrypt/decrypt failed. Fatal by design
├── PesepayNetworkError    no response at all
│   └── PesepayTimeoutError
└── PesepayConfigError     bad configuration or bad arguments. Thrown before any socket
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
    // Not a failed payment. See below.
    log.warn('timed out after', error.timeoutMs);
  } else if (error instanceof PesepayAuthError) {
    // 404 = the key is unknown, 403 = the key is disabled. Never retried.
    log.error('integration key rejected', error.status);
  } else if (error instanceof PesepayApiError && error.isEncryptionKeyMismatch()) {
    log.error('the encryption key does not match this integration key');
  } else if (error instanceof PesepayApiError && error.isRetryable()) {
    log.warn('transient', error.status, error.serverMessage);
  } else if (error instanceof PesepayConfigError) {
    log.error('called wrongly', error.message);
  } else {
    throw error;
  }
}
```

Every error also carries a stable `code` — `'ERR_PESEPAY_AUTH'` and so on — for
structured logs, worker boundaries, and anywhere `instanceof` cannot reach.

**No error here carries key material**, in its message, its properties or its
`cause`. The gateway's own words are redacted before they become an error
message, because errors end up in log aggregators.

### The status codes read backwards

The usual rule — *4xx is your fault, 5xx is worth retrying* — is wrong against
this gateway. These mappings are read off the server, not guessed.

| status | what it actually means | class | `isRetryable()` |
|---|---|---|---|
| `400` | often just an unhandled server-side exception, not a validation failure | `PesepayApiError` | `false` |
| `403` | your integration key **exists but is disabled** | `PesepayAuthError` | `false` |
| `404` | your integration key is **unknown** — *not* "no such endpoint" | `PesepayAuthError` | `false` |
| `408`, `429` | genuinely transient | `PesepayApiError` | `true` |
| `500` `"Failed to decrypt your data"` | your **encryption key** is wrong — the integration key is fine | `PesepayApiError` | `false` |
| other `5xx` | the gateway is unwell | `PesepayApiError` | `true` |

The two that cost the most time:

- **A `404` sends people hunting for a typo in a URL.** It means the key in your
  `key` header is not one the gateway knows. Check the *credential*, and check
  that it belongs to the environment you are pointed at — a live key against the
  sandbox is a `404`.
- **The `500` sends people rotating the wrong credential.** It is the *other*
  key. `PesepayApiError.isEncryptionKeyMismatch()` picks it out, and this is
  also why the status is always checked before anything is decrypted: decrypting
  first would turn "your integration key is unknown" into a padding error.

Use `isRetryable()` rather than writing the table into your own code. It answers
`true` for `408`, `429` and 5xx other than the decryption failure, and `false`
for everything else — a `403`/`404` is a key that will still be wrong in ten
minutes, and retrying a key mismatch is a loop.

### A timeout is not a failed payment

> [!CAUTION]
> A `PesepayTimeoutError` means you did not hear back. It does **not** mean the
> transaction did not happen. The gateway may have taken the payment and
> answered too slowly, or answered into a dropped socket.

**Recover with `checkPayment(referenceNumber)`. Never by re-initiating** — that
risks charging the customer twice.

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

  // Ask what actually happened. Retrying the charge could take the money twice.
  const actual = await pesepay.checkPayment(referenceNumber);
  log.warn('recovered after timeout', actual.transactionStatus, actual.paid);
}
```

The same applies to a timed-out `initiateTransaction` — except that you have no
reference number yet, which is why `merchantReference` is worth setting on every
call. The transport knows this too: it retries *nothing* on a timeout or a
refused connection, precisely because replaying a `POST` to `/initiate` risks a
double charge.

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
| `integrationKey` | — | required. Sent as the `key` header |
| `encryptionKey` | — | required. **Exactly 32 ASCII characters**, validated eagerly — a bad key throws `PesepayConfigError` before any socket |
| `resultUrl` | — | where the gateway POSTs results. Required by `initiateTransaction`, `makeSeamlessPayment` and `initiateInvoice` |
| `returnUrl` | — | where the customer lands after the hosted page |
| `timeoutMs` | `30_000` | total budget per call |
| `baseUrl` | `https://api.pesepay.com/api/payments-engine` | point at `api.test.pesepay.com` for sandbox |
| `transport` | `httpsTransport` | the HTTP seam — see below |

`resultUrl` and `returnUrl` are also settable properties, and each call can
override them for itself. The v1 positional form still constructs the same
class:

```ts
import { Pesepay } from 'pesepay';

const pesepay = new Pesepay('INTEGRATION KEY', '0123456789abcdef0123456789abcdef');
pesepay.resultUrl = 'https://example.com/pesepay/webhook';
pesepay.returnUrl = 'https://example.com/checkout/done';
```

`JSON.stringify(pesepay)` publishes neither key: both are `#private` fields,
which are invisible to it.

## The transport seam

HTTP is a single injectable function, so you can route through a proxy, add
instrumentation or retries, or drive the client from a test double with no
socket at all.

```ts
import { createHttpsTransport, httpsTransport, Pesepay, type Transport } from 'pesepay';

const timed: Transport = async (request) => {
  const started = Date.now();
  const response = await httpsTransport(request);
  log.info(request.method, request.url, response.status, Date.now() - started);
  return response;
};

const strict = new Pesepay({
  integrationKey: 'your-integration-key',
  encryptionKey: '0123456789abcdef0123456789abcdef',
  transport: createHttpsTransport({ allowInsecureHttpParserFallback: false }),
});

log.info(strict.baseUrl, timed);
```

> [!NOTE]
> **Why this package does not use `fetch`.** `api.pesepay.com` emits a
> `Strict-Transport-Security` header whose value contains a literal newline, so
> its header block carries a bare LF where HTTP/1.1 requires CRLF. Node's strict
> parser rejects every such response with `HPE_CR_EXPECTED`, and no `undici`
> option relaxes it — a `fetch`-based SDK cannot talk to production at all.
>
> This package tries the strict parser first and retries **once** with
> `insecureHTTPParser` on a parse error only, replaying the body. That keeps
> response-smuggling protection on by default, warns once per process when the
> fallback is used, and self-heals the day the header is fixed. A timeout or a
> refused connection is never retried. `createHttpsTransport({ allowInsecureHttpParserFallback: false })`
> turns the fallback off if your policy forbids the lenient parser.
>
> The real fix is one line of nginx on the gateway:
> `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`

The transport refuses to send your integration key over cleartext HTTP to
anything but loopback.

## API

| method | what it does |
|---|---|
| `initiateTransaction(options)` | creates a transaction; returns `referenceNumber`, `pollUrl`, `redirectUrl` |
| `makeSeamlessPayment(options)` | charges a method directly; returns a `PaymentResult` |
| `checkPayment(referenceNumber)` | reads a transaction's current state |
| `pollTransaction(pollUrl)` | the same, from the URL the gateway handed back |
| `initiateInvoice(options)` | creates an invoice; Pesepay emails the payer |
| `checkInvoice(invoiceNumber)` | that invoice's payment, as a `PaymentResult` |
| `getActiveCurrencies()` | currencies your account can transact in |
| `getPaymentMethods(currencyCode)` | methods for one currency |
| `getActivePaymentMethods()` | every active method, all currencies |
| `parseCallback(body, headers?)` | decodes a `resultUrl` POST and verifies the key |

Also exported: `TransactionStatus`, `isPaid`, `isTerminal`,
`isTransactionStatus`, `TERMINAL_TRANSACTION_STATUSES`,
`NON_TERMINAL_TRANSACTION_STATUSES`, `TRANSACTION_STATUS_CODES`,
`TRANSACTION_STATUS_DESCRIPTIONS`, the seven error classes, `DEFAULT_BASE_URL`,
`DEFAULT_TIMEOUT_MS`, `VERSION`, `createHttpsTransport`, `httpsTransport`, and
the types for all of it.

The published type declarations keep their documentation, so your editor's hover
is the full reference for every option and every field.

## Migrating from 1.x

```js v1
const { Pesepay } = require('pesepay');
```

becomes

```js
const { Pesepay } = require('pesepay/v1-compat');
```

and nothing else changes. That compatibility layer reports only `paid`, though,
so it cannot tell `PENDING` from `DECLINED` from `REVERSED` — it is a migration
ramp, not a destination. **[MIGRATION.md](MIGRATION.md)** has the per-method
before and after, and what the layer deliberately does not reproduce.

## Contributing

```shell
npm install
npm run verify     # lint, typecheck, build, test, publint, are-the-types-wrong
```

Every code block in this file is extracted and compiled against the built
package by `test/docs/snippets.test.mts`, so a snippet that does not typecheck
fails the build.

## Licence

MIT. See [LICENSE](LICENSE).
