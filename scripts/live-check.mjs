/**
 * The gateway, for real. Everything the unit suite cannot reach.
 *
 * All 279 tests run against `test/fixtures/raw-http-server.mts` — a byte-exact
 * reproduction of what we *believe* api.pesepay.com sends. This script is the
 * only thing that checks that belief against the server itself.
 *
 * Plain JavaScript, like scripts/smoke-installed.mjs, so it runs on the oldest
 * Node the `engines` field claims without type stripping.
 *
 *   PESEPAY_INTEGRATION_KEY=... PESEPAY_ENCRYPTION_KEY=... \
 *     node scripts/live-check.mjs
 *
 * Read-only by default: stages 1-3 move no money and create nothing. Pass
 * --initiate to add stage 4, which creates a REAL transaction on your merchant
 * account (unpaid, and abandoning it is harmless, but it is real). Pass
 * --check <reference> to re-poll one transaction after paying it in a browser.
 */
import { argv, env, exit, stderr, stdout } from 'node:process';

const {
  Pesepay,
  PesepayApiError,
  PesepayAuthError,
  PesepayCryptoError,
  PesepayNetworkError,
  VERSION,
} = await import('../dist/index.mjs');

const out = (line = '') => stdout.write(`${line}\n`);
const fail = (line) => stderr.write(`${line}\n`);

const CREATE = argv.includes('--initiate');
const CHECKING = argv.includes('--check');
const CHECK_REF = argv[argv.indexOf('--check') + 1];
const CURRENCY = 'USD';

const integrationKey = env.PESEPAY_INTEGRATION_KEY;
const encryptionKey = env.PESEPAY_ENCRYPTION_KEY;

if (!integrationKey || !encryptionKey) {
  fail('Set PESEPAY_INTEGRATION_KEY and PESEPAY_ENCRYPTION_KEY first.');
  fail('Never paste them into a file the repo tracks; .env is gitignored.');
  exit(2);
}

if (CHECKING && !CHECK_REF) {
  fail('--check needs a reference number: node scripts/live-check.mjs --check RN123');
  exit(2);
}

/** Describe a failure without ever echoing a key. */
const describe = (error) => {
  if (error instanceof PesepayAuthError) return `auth rejected (HTTP ${error.status})`;
  if (error instanceof PesepayApiError) {
    return `HTTP ${error.status}, retryable=${error.isRetryable()}: ${error.message}`;
  }
  if (error instanceof PesepayCryptoError) return `CRYPTO: ${error.message}`;
  if (error instanceof PesepayNetworkError) return `NETWORK: ${error.message}`;
  return `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`;
};

let failures = 0;
const stage = async (n, what, proves, run) => {
  out();
  out(`[${n}] ${what}`);
  out(`    proves: ${proves}`);
  try {
    out(`    \u2713 ${await run()}`);
  } catch (error) {
    failures += 1;
    out(`    \u2717 ${describe(error)}`);
  }
};

const pesepay = new Pesepay({
  integrationKey,
  encryptionKey,
  resultUrl: 'https://example.com/pesepay/webhook',
  returnUrl: 'https://example.com/checkout/done',
});

out(`pesepay ${VERSION} against ${pesepay.baseUrl}`);

// --check short-circuits everything else: it is the follow-up to a payment
// completed in a browser, not a fresh run of the suite.
if (CHECKING) {
  await stage(
    1,
    `checkPayment('${CHECK_REF}')`,
    'the terminal status after a real payment',
    async () => {
      const result = await pesepay.checkPayment(CHECK_REF);
      return `status ${result.status} (paid=${result.paid})`;
    },
  );
  exit(failures === 0 ? 0 : 1);
}

out(CREATE ? 'mode: --initiate (stage 4 creates a real transaction)' : 'mode: read-only');

// The plain GET. If the bare-LF header block still breaks Node's strict parser,
// this is where the insecureHTTPParser retry earns its place — and if the gateway
// has since fixed its headers, this passes on the strict attempt and we can plan
// to retire the workaround.
await stage(
  1,
  'getActiveCurrencies()',
  'TLS, the key header, the malformed-header retry',
  async () => {
    const currencies = await pesepay.getActiveCurrencies();
    const codes = currencies.map((c) => c.code ?? c.currencyCode).filter(Boolean);
    return `${currencies.length} currencies: ${codes.slice(0, 8).join(', ')}`;
  },
);

await stage(
  2,
  `getPaymentMethods('${CURRENCY}')`,
  'query handling and a second response shape',
  async () => {
    const methods = await pesepay.getPaymentMethods(CURRENCY);
    const shown = methods
      .slice(0, 6)
      .map((m) => `${m.code ?? m.paymentMethodCode}=${m.name ?? m.paymentMethodName}`)
      .join(', ');
    return `${methods.length} methods: ${shown}`;
  },
);

// The failure path, from the server rather than from a fixture. A wrong
// integration key is the one bad-credential case that is safe to provoke.
await stage(
  3,
  'a deliberately invalid integration key',
  'the real error shape, status and isRetryable()',
  async () => {
    const wrong = new Pesepay({
      integrationKey: '00000000-0000-0000-0000-000000000000',
      encryptionKey,
      resultUrl: 'https://example.com/pesepay/webhook',
      returnUrl: 'https://example.com/checkout/done',
    });
    try {
      await wrong.getActiveCurrencies();
    } catch (error) {
      if (error instanceof PesepayApiError) return `rejected as expected \u2014 ${describe(error)}`;
      throw error;
    }
    throw new Error('the gateway ACCEPTED an unknown integration key');
  },
);

// Stage 4 is the one that matters most: initiate encrypts the payload and the
// poll decrypts the reply, so a round trip proves the AES path against the
// server in both directions. The Java vectors say the cipher is right; only
// this says the server agrees.
if (CREATE) {
  let reference;
  let redirect;

  await stage(
    4,
    'initiateTransaction()',
    'AES ENCRYPT \u2014 the server accepts our payload',
    async () => {
      const result = await pesepay.initiateTransaction({
        amount: 1,
        currencyCode: CURRENCY,
        reasonForPayment: `live-check ${new Date().toISOString()}`,
        merchantReference: `live-check-${Date.now()}`,
      });
      reference = result.referenceNumber;
      redirect = result.redirectUrl;
      return `reference ${reference}`;
    },
  );

  if (reference) {
    await stage(
      5,
      `checkPayment('${reference}')`,
      'AES DECRYPT \u2014 we can read the server back',
      async () => {
        const result = await pesepay.checkPayment(reference);
        return `status ${result.status} (paid=${result.paid})`;
      },
    );

    if (redirect) {
      out();
      out('To confirm the money actually moves, open this and pay:');
      out(`  ${redirect}`);
      out();
      out('Then re-check with:');
      out(`  node scripts/live-check.mjs --check ${reference}`);
    }
  }
} else {
  out();
  out('[4] initiateTransaction() \u2014 SKIPPED');
  out('    the encrypt/decrypt round trip is the main thing mocks cannot prove.');
  out('    re-run with --initiate when you are ready to create a real transaction.');
}

out();
out(
  failures === 0
    ? 'All live checks passed.'
    : `${failures} live check(s) failed \u2014 do not publish until these are understood.`,
);
exit(failures === 0 ? 0 : 1);
