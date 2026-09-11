# Migrating from pesepay 1.x to 2.0.0

There are two ways through this, and you can take them in either order.

1. **Change one line** and keep running. `require('pesepay/v1-compat')` restores
   the 1.x surface exactly — same methods, same argument order, same
   `{ success, message, … }` response object.
2. **Move to the 2.x API**, a call site at a time, for real transaction statuses
   and typed errors.

The compat layer exists to make step 1 free so that step 2 is never urgent. It
is a ramp, not a destination, and [what it cannot
do](#what-the-compat-layer-cannot-do) is the reason.

## The zero-effort step

```js v1
const { Pesepay } = require('pesepay');
```

becomes

```js
const { Pesepay } = require('pesepay/v1-compat');
```

That is the whole change. Everything below still works, unchanged:

```js
const { Pesepay } = require('pesepay/v1-compat');

const pesepay = new Pesepay('INTEGRATION KEY', '0123456789abcdef0123456789abcdef');
pesepay.resultUrl = 'https://example.com/result';
pesepay.returnUrl = 'https://example.com/return';

const transaction = pesepay.createTransaction(10.5, 'USD', 'Order #1024');

pesepay.initiateTransaction(transaction).then((response) => {
  if (response.success) {
    const referenceNumber = response.referenceNumber;
    const pollUrl = response.pollUrl;
    const redirectUrl = response.redirectUrl;
    log.info(referenceNumber, pollUrl, redirectUrl);
  } else {
    log.error(response.message);
  }
});
```

Reproduced down to the details that a paraphrase would have lost:

- **The two failures 1.x threw rather than folded.** A missing `resultUrl` or
  `returnUrl` still throws a plain `Error` — not a `PesepayConfigError` — with
  1.x's messages verbatim, `'Result url has not beeen specified.'` typo
  included, and before any request is sent.
- **The methods are own properties holding arrow functions**, so
  `const { checkPayment } = pesepay` still works.
- **Your objects are still mutated.** `initiateTransaction` writes both URLs
  onto the transaction; `makeSeamlessPayment` writes `resultUrl`, `returnUrl`,
  `reasonForPayment`, a fresh `amountDetails` and both required-field maps onto
  the payment. 1.x did, and callers could observe it.
- **`redirectUrl` is only ever set by `initiateTransaction`.** 1.x read it on
  polls too, where the gateway has the field commented out, so it was always
  `undefined` there. It stays `undefined` there.
- **`error.message ?? 'Something went wrong!'`**, including that a thrown
  non-`Error` produces the fallback.
- **Every 2.x error is folded back into `{ success: false, message }`.** 1.x code
  has no `catch`, so an error escaping this layer would be a crash in an
  application that used to keep running.
- The classes come too: `PesepayResponse`, `Transaction`, `Payment`, `Customer`,
  `Amount`, and the `BASE_URL` / `INITIATE_PAYMENT_URL` /
  `MAKE_SEAMLESS_PAYMENT_URL` / `CHECK_PAYMENT_URL` / `ALGORITHM` constants.

### What the compat layer cannot do

> [!WARNING]
> **It reports only `paid`.** That is a boolean, and the gateway has seventeen
> statuses. So the compat layer cannot tell `PENDING` from `DECLINED` from
> `REVERSED`: all three arrive as `{ success: true, paid: false }`.

Those three call for three different things — keep waiting, tell the customer
and stop, and claw back money you have already credited. A `paid: false` that
means "not yet" is indistinguishable from one that means "never" and from one
that means "not any more". That is the shape 2.x exists to fix, and no
compatibility layer can fix it while keeping 1.x's response object.

It also cannot give you: typed errors (everything is folded into a string
message), invoices, the currency and payment-method catalogue, `parseCallback`
for the webhook, or a configurable timeout on the calls 1.x already had.

### Migrating one call site at a time

`pesepay.client` is the modern client, built on first use from the same two
keys. Use it to move call sites gradually without constructing a second object
holding the same secrets:

```js
const { Pesepay } = require('pesepay/v1-compat');

const pesepay = new Pesepay('INTEGRATION KEY', '0123456789abcdef0123456789abcdef');
pesepay.resultUrl = 'https://example.com/result';

// Old call sites keep working…
pesepay.checkPayment('REF').then((response) => log.info(response.paid));

// …while new ones use the 2.x client, which throws and reports real statuses.
pesepay.client.checkPayment('REF').then((result) => {
  log.info(result.transactionStatus, result.isTerminal, result.amountDetails?.merchantAmount);
});
```

When the last v1 call site is gone, change the import to `require('pesepay')`
and delete the `.client`.

## Method by method

Every "before" below is 1.x code and still runs under
`require('pesepay/v1-compat')`.

### Construction

```js v1
const { Pesepay } = require('pesepay');

const pesepay = new Pesepay('INTEGRATION KEY', 'ENCRYPTION KEY');
pesepay.resultUrl = 'https://example.com/result';
pesepay.returnUrl = 'https://example.com/return';
```

```ts
import { Pesepay } from 'pesepay';

const pesepay = new Pesepay({
  integrationKey: 'INTEGRATION KEY',
  encryptionKey: '0123456789abcdef0123456789abcdef',
  resultUrl: 'https://example.com/result',
  returnUrl: 'https://example.com/return',
  timeoutMs: 15_000,
});
```

The positional form still works in 2.x, with the URLs as settable properties, so
this is the one change you can defer indefinitely.

What is new: `timeoutMs` (1.x had no timeout at all — a hung socket hung your
request), `baseUrl` for the sandbox, and `transport`.

What is stricter: **the encryption key is validated in the constructor.** It has
to be exactly 32 ASCII characters, and a bad one throws `PesepayConfigError`
before any socket rather than failing per call.

### Redirect payments

```js v1
const transaction = pesepay.createTransaction(10.5, 'USD', 'Order #1024', 'order-1024');

pesepay.initiateTransaction(transaction).then((response) => {
  if (response.success) {
    log.info(response.referenceNumber, response.pollUrl, response.redirectUrl);
  } else {
    log.error(response.message);
  }
});
```

```ts
const transaction = await pesepay.initiateTransaction({
  amount: 10.5,
  currencyCode: 'USD',
  reasonForPayment: 'Order #1024',
  merchantReference: 'order-1024',
});

log.info(transaction.referenceNumber, transaction.pollUrl, transaction.redirectUrl);
```

No `createTransaction` step, and no `response.success` to check — a failure
throws. `redirectUrl` is a required `string` here rather than possibly
`undefined`.

### Seamless payments

```js v1
const payment = pesepay.createPayment('USD', 'PZW211', 'customer@example.com', '0771111111', 'Tendai Moyo');
const requiredFields = { customerPhoneNumber: '0771111111' };

pesepay.makeSeamlessPayment(payment, 'Order #1024', 5, requiredFields).then((response) => {
  if (response.success) {
    log.info(response.referenceNumber, response.pollUrl, response.paid);
  } else {
    log.error(response.message);
  }
});
```

```ts
const result = await pesepay.makeSeamlessPayment({
  amount: 5,
  currencyCode: 'USD',
  paymentMethodCode: 'PZW211',
  reasonForPayment: 'Order #1024',
  customer: { email: 'customer@example.com', phoneNumber: '0771111111', name: 'Tendai Moyo' },
  requiredFields: { customerPhoneNumber: '0771111111' },
});

log.info(result.referenceNumber, result.transactionStatus, result.isTerminal);
```

One object instead of a two-step construction and four positional arguments —
the 1.x form put the amount third and the reason second, which was easy to
transpose and impossible for a compiler to catch.

`result.transactionStatus` is the change that matters: a seamless charge
normally comes back `PENDING`, and 1.x reported that as `paid: false`,
identically to a decline.

### Checking a payment

```js v1
pesepay.checkPayment(referenceNumber).then((response) => {
  if (response.success) {
    if (response.paid) {
      log.info('paid');
    }
  } else {
    log.error(response.message);
  }
});

pesepay.pollTransaction(pollUrl).then((response) => log.info(response.paid));
```

```ts
const result = await pesepay.checkPayment(referenceNumber);

if (result.paid) {
  log.info('paid', result.amountDetails?.merchantAmount);
} else if (result.isTerminal) {
  log.warn('will never be paid', result.transactionStatus);
} else {
  log.info('still in flight', result.transactionStatus);
}
```

The three-way answer is the point. `isTerminal` is what tells a poll loop to
stop; 1.x could only stop on `paid`, which meant a declined transaction polled
forever.

### Error handling

```js v1
pesepay.checkPayment(referenceNumber).then((response) => {
  if (!response.success) {
    // One string for a dead socket, a wrong key, and a malformed request.
    log.error(response.message);
  }
});
```

```ts
import { PesepayApiError, PesepayAuthError, PesepayTimeoutError } from 'pesepay';

try {
  const result = await pesepay.checkPayment(referenceNumber);
  log.info(result.transactionStatus);
} catch (error) {
  if (error instanceof PesepayTimeoutError) {
    log.warn('no answer — the payment may still have happened', error.timeoutMs);
  } else if (error instanceof PesepayAuthError) {
    log.error('integration key rejected', error.status);
  } else if (error instanceof PesepayApiError && error.isEncryptionKeyMismatch()) {
    log.error('wrong encryption key');
  } else {
    throw error;
  }
}
```

This is the largest behavioural difference in 2.x: **the methods throw.** 1.x
returned `{ success: false, message }` for everything, which collapsed "your key
is disabled", "the socket dropped" and "you sent a negative amount" into one
string.

If your 1.x code branches on `response.success`, you have a `catch` to write —
or you stay on `pesepay/v1-compat`, which writes it for you.

See the README's [error table](README.md#the-status-codes-read-backwards): a
`404` means your integration key is unknown rather than "no such endpoint", and
a `500` saying `"Failed to decrypt your data"` means your *encryption* key is
wrong.

### New in 2.x

None of these have a 1.x equivalent: `initiateInvoice`, `checkInvoice`,
`getActiveCurrencies`, `getPaymentMethods`, `getActivePaymentMethods`, and
`parseCallback` for the `resultUrl` webhook. The README covers each.

`parseCallback` is worth reading before anything else — 1.x gave you no help at
all with the callback, and the gateway's callback has no signature, no retries,
and sends a second one when a payment is reversed.

## What the compat layer deliberately does not reproduce

Two 1.x behaviours were not carried over, because reproducing them would have
meant reproducing a bug.

1. **`checkPayment` builds its query through `URL`.** 1.x concatenated the
   reference number into the query string raw, so a reference containing `&`,
   `#` or a space produced a silently different request — a lookup for something
   other than what you asked for. The compat layer encodes it. Reference numbers
   the gateway issues are unaffected either way; the difference shows only for
   input 1.x would have mangled.
2. **The constructor takes an optional third argument.** `new Pesepay(key,
   encryptionKey, { baseUrl, timeoutMs, transport })` — the sandbox, a request
   budget 1.x never had, and the injection seam the tests drive. Passing nothing
   leaves behaviour identical to 1.0.4 against production.

```js
const { Pesepay } = require('pesepay/v1-compat');

const pesepay = new Pesepay('INTEGRATION KEY', '0123456789abcdef0123456789abcdef', {
  baseUrl: 'https://api.test.pesepay.com/api/payments-engine',
  timeoutMs: 15_000,
});

pesepay.resultUrl = 'https://example.com/result';
log.info(pesepay.client.baseUrl, pesepay.client.timeoutMs);
```

### And one it could not

**2.x validates the encryption key eagerly; the compat layer defers it.**

2.x checks the key in its constructor, so a malformed one throws
`PesepayConfigError` before any socket. 1.x validated nothing: with a bad key it
failed on each call and returned `{ success: false }`.

Doing the eager thing inside the compat constructor would turn a degraded
integration into a crash at startup — the opposite of "change one line". So the
modern client is built on **first use**, inside the fold, and a malformed key
surfaces where 1.x surfaced it: as `{ success: false, message }` from the method
you called.

The cost is honest and worth naming: under the compat layer a bad encryption key
is still a per-call failure rather than a startup failure. Moving to
`require('pesepay')` is what turns it back into one.

## Reference: 1.x → 2.x

| 1.x | 2.x |
|---|---|
| `require('pesepay')` | `require('pesepay')`, or `require('pesepay/v1-compat')` unchanged |
| `new Pesepay(key, encryptionKey)` | `new Pesepay({ integrationKey, encryptionKey, resultUrl, returnUrl })` — the positional form still works |
| `createTransaction(amount, currency, reason, ref?)` | gone — pass the fields to `initiateTransaction` |
| `createPayment(currency, method, email?, phone?, name?)` | gone — pass `customer` to `makeSeamlessPayment` |
| `initiateTransaction(transaction)` | `initiateTransaction({ amount, currencyCode, reasonForPayment, … })` |
| `makeSeamlessPayment(payment, reason, amount, fields?)` | `makeSeamlessPayment({ amount, currencyCode, paymentMethodCode, reasonForPayment, customer, requiredFields })` |
| `checkPayment(ref)` | `checkPayment(ref)` — throws instead of `{ success: false }` |
| `pollTransaction(url)` | `pollTransaction(url)` — same |
| `response.success` | gone. A failure throws |
| `response.paid` | `result.paid`, plus `result.isTerminal` and the real `result.transactionStatus` |
| `response.message` | `error.message`, on a typed error with a `code` and a `status` |
| `response.redirectUrl` | `redirectUrl`, and only from `initiateTransaction` |
| — | `initiateInvoice`, `checkInvoice`, `getActiveCurrencies`, `getPaymentMethods`, `getActivePaymentMethods`, `parseCallback` |
| — | `timeoutMs`, `baseUrl`, `transport` |

## Staying on 1.x

1.0.4 remains installable and is unaffected by this release:

```shell
npm install pesepay@1.0.4
```

It receives security fixes only. `pesepay/v1-compat` is the better place to be:
it is the same API on top of a maintained client, with the timeout, the sandbox
switch, and the HTTP fix for the gateway's malformed response headers that 1.x
handled by disabling Node's strict parser for every request.
