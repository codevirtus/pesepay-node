# Migrating from pesepay 1.x to 2.0

You can upgrade in two steps:

1. **Change one import** to keep your 1.x code running unchanged.
2. **Move to the 2.x API** one call site at a time, to get real transaction
   statuses and typed errors.

## Step 1: change one import

```js v1
const { Pesepay } = require('pesepay');
```

becomes

```js
const { Pesepay } = require('pesepay/v1-compat');
```

Nothing else changes. Your existing code keeps working:

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

`pesepay/v1-compat` keeps the 1.x methods, argument order, response object
(`{ success, message, … }`), error messages and exported classes
(`PesepayResponse`, `Transaction`, `Payment`, `Customer`, `Amount`) and
constants.

It has two small differences from 1.x:

- **Reference numbers are URL-encoded** in `checkPayment`. 1.x sent them
  unencoded, so a reference containing `&`, `#` or a space looked up the wrong
  transaction. References issued by Pesepay are unaffected.
- **The constructor accepts optional settings** as a third argument:
  `{ baseUrl, timeoutMs, transport }`. Without it, behaviour is unchanged.

```js
const { Pesepay } = require('pesepay/v1-compat');

const pesepay = new Pesepay('INTEGRATION KEY', '0123456789abcdef0123456789abcdef', {
  baseUrl: 'https://api.test.pesepay.com/api/payments-engine',
  timeoutMs: 15_000,
});

pesepay.resultUrl = 'https://example.com/result';
log.info(pesepay.client.baseUrl, pesepay.client.timeoutMs);
```

### Why you should keep going

> [!WARNING]
> The compatibility layer reports only `paid`. `PENDING`, `DECLINED` and
> `REVERSED` all come back as `{ success: true, paid: false }`.

Those need different handling: keep waiting, tell the customer the payment
failed, or take back credit you already gave. Only the 2.x API tells them
apart.

The compatibility layer also doesn't include typed errors, invoices, currency
and payment-method lookups, or `parseCallback`.

## Step 2: move to the 2.x API

### One call site at a time

`pesepay.client` is a 2.x client that uses the same keys. Move call sites to it
one by one:

```js
const { Pesepay } = require('pesepay/v1-compat');

const pesepay = new Pesepay('INTEGRATION KEY', '0123456789abcdef0123456789abcdef');
pesepay.resultUrl = 'https://example.com/result';

// Old call sites keep working...
pesepay.checkPayment('REF').then((response) => log.info(response.paid));

// ...while new ones use the 2.x client.
pesepay.client.checkPayment('REF').then((result) => {
  log.info(result.transactionStatus, result.isTerminal, result.amountDetails?.merchantAmount);
});
```

When no 1.x calls are left, change the import back to `require('pesepay')` and
drop `.client`.

In each example below, the first block is 1.x code and the second is its 2.x
replacement.

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

The 1.x positional constructor still works in 2.x.

- **New options:** `timeoutMs`, `baseUrl` (for the sandbox) and `transport`.
- **The encryption key is checked in the constructor.** It must be exactly 32
  ASCII characters, or the constructor throws `PesepayConfigError`.

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

There is no `createTransaction` step, and no `response.success`: failures
throw.

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

Named options replace `createPayment` and the four positional arguments.

A seamless payment usually comes back `PENDING`. 1.x reported that as
`paid: false`, the same as a decline. 2.x gives you the actual
`transactionStatus`.

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
  log.info('still in progress', result.transactionStatus);
}
```

Use `isTerminal` to know when to stop polling. In 1.x, a declined payment
looked the same as one still in progress.

### Error handling

```js v1
pesepay.checkPayment(referenceNumber).then((response) => {
  if (!response.success) {
    // One message for every kind of failure.
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
    log.warn('no response; the payment may still have gone through', error.timeoutMs);
  } else if (error instanceof PesepayAuthError) {
    log.error('integration key rejected', error.status);
  } else if (error instanceof PesepayApiError && error.isEncryptionKeyMismatch()) {
    log.error('wrong encryption key');
  } else {
    throw error;
  }
}
```

**This is the biggest change: 2.x methods throw.** If your code checks
`response.success`, replace that with a `try`/`catch`.

See [Troubleshooting status codes](README.md#troubleshooting-status-codes) in
the README. In particular, `404` means your integration key isn't recognised,
not that the URL is wrong.

### New in 2.x

These have no 1.x equivalent, and the [README](README.md) covers each:

- `initiateInvoice` and `checkInvoice`
- `getActiveCurrencies`, `getPaymentMethods` and `getActivePaymentMethods`
- `parseCallback`, for [payment notifications](README.md#payment-notifications-webhook)

## Quick reference

| 1.x | 2.x |
|---|---|
| `new Pesepay(key, encryptionKey)` | `new Pesepay({ integrationKey, encryptionKey, resultUrl, returnUrl })` (the positional form still works) |
| `createTransaction(amount, currency, reason, ref?)` | removed: pass the fields to `initiateTransaction` |
| `createPayment(currency, method, email?, phone?, name?)` | removed: pass `customer` to `makeSeamlessPayment` |
| `initiateTransaction(transaction)` | `initiateTransaction({ amount, currencyCode, reasonForPayment, … })` |
| `makeSeamlessPayment(payment, reason, amount, fields?)` | `makeSeamlessPayment({ amount, currencyCode, paymentMethodCode, reasonForPayment, customer, requiredFields })` |
| `checkPayment(ref)` | `checkPayment(ref)`, which throws on failure |
| `pollTransaction(url)` | `pollTransaction(url)`, which throws on failure |
| `response.success` | removed: failures throw |
| `response.paid` | `result.paid`, plus `result.isTerminal` and `result.transactionStatus` |
| `response.message` | `error.message` on a typed error, with `code` and `status` |
| `response.redirectUrl` | `redirectUrl`, returned by `initiateTransaction` only |
| (none) | `initiateInvoice`, `checkInvoice`, `getActiveCurrencies`, `getPaymentMethods`, `getActivePaymentMethods`, `parseCallback` |
| (none) | `timeoutMs`, `baseUrl`, `transport` |

2.x also requires Node.js 22.12 or newer, and the package no longer has a
`default` export. Use the named `Pesepay` export.

## Staying on 1.x

Publishing 2.0 doesn't change 1.0.4. Existing lockfiles and ranges like
`pesepay@^1` keep resolving to it. To install it explicitly:

```shell
npm install pesepay@1
```

1.x receives security fixes only. `pesepay/v1-compat` gives you the same API on
the maintained 2.x code.
