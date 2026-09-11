/**
 * Transaction statuses, checked against the gateway's own enum.
 *
 * The values, codes and descriptions here were transcribed from
 * `TransactionStatus.java` in `pesepay-cloud-utilities`. These tests mostly
 * guard the transcription — and the one place where the obvious approach is
 * wrong.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { status } from '../fixtures/modules.mts';

const { TransactionStatus, TRANSACTION_STATUS_CODES, TRANSACTION_STATUS_DESCRIPTIONS } = status;

describe('status — the vocabulary', () => {
  it('has all 17 values the server defines', () => {
    assert.equal(Object.keys(TransactionStatus).length, 17);
  });

  it('maps every key to its own name, so wire strings compare equal', () => {
    for (const [key, value] of Object.entries(TransactionStatus)) {
      assert.equal(key, value);
    }
  });

  it('has a code and a description for every status', () => {
    for (const value of Object.values(TransactionStatus)) {
      assert.equal(typeof TRANSACTION_STATUS_CODES[value], 'number');
      assert.ok((TRANSACTION_STATUS_DESCRIPTIONS[value] ?? '').length > 0);
    }
  });
});

describe('status — terminality', () => {
  it('treats exactly four statuses as still in flight', () => {
    assert.deepEqual([...status.NON_TERMINAL_TRANSACTION_STATUSES].sort(), [
      'INITIATED',
      'PARTIALLY_PAID',
      'PENDING',
      'PROCESSING',
    ]);
  });

  it('splits the 17 into 4 non-terminal and 13 terminal', () => {
    assert.equal(status.NON_TERMINAL_TRANSACTION_STATUSES.size, 4);
    assert.equal(status.TERMINAL_TRANSACTION_STATUSES.size, 13);

    for (const value of Object.values(TransactionStatus)) {
      assert.notEqual(
        status.NON_TERMINAL_TRANSACTION_STATUSES.has(value),
        status.TERMINAL_TRANSACTION_STATUSES.has(value),
        `${value} must be in exactly one set`,
      );
    }
  });

  it('agrees with isTerminal() for every status', () => {
    for (const value of Object.values(TransactionStatus)) {
      assert.equal(status.isTerminal(value), status.TERMINAL_TRANSACTION_STATUSES.has(value));
    }
  });

  it('treats an unrecognised status as terminal', () => {
    // Fail-safe direction: a status the gateway adds later is far more likely
    // to be a new terminal outcome than a new in-flight one, and guessing
    // "pending" turns a poll loop into an infinite one.
    assert.equal(status.isTerminal('SOMETHING_NEW'), true);
    assert.equal(status.isPaid('SOMETHING_NEW'), false);
  });

  it('counts only SUCCESS as paid', () => {
    const paid = Object.values(TransactionStatus).filter((value) => status.isPaid(value));
    assert.deepEqual(paid, ['SUCCESS']);
  });

  it('does not treat PARTIALLY_PAID or REVERSED as paid', () => {
    // PARTIALLY_PAID is money received but not the amount asked for, and is
    // still in flight. REVERSED was successful and then was not.
    assert.equal(status.isPaid('PARTIALLY_PAID'), false);
    assert.equal(status.isTerminal('PARTIALLY_PAID'), false);
    assert.equal(status.isPaid('REVERSED'), false);
    assert.equal(status.isTerminal('REVERSED'), true);
  });
});

describe('status — the code is not a discriminator', () => {
  it('gives CLOSED and CLOSED_PERIOD_ELAPSED the same code', () => {
    // The trap this whole module exists to stop anyone walking into: branching
    // on transactionStatusCode conflates two different outcomes.
    assert.equal(TRANSACTION_STATUS_CODES.CLOSED, 307);
    assert.equal(TRANSACTION_STATUS_CODES.CLOSED_PERIOD_ELAPSED, 307);
  });

  it('has 307 as the only duplicated code', () => {
    const counts = new Map<number, string[]>();
    for (const [name, code] of Object.entries(TRANSACTION_STATUS_CODES)) {
      counts.set(code, [...(counts.get(code) ?? []), name]);
    }
    const duplicated = [...counts.entries()].filter(([, names]) => names.length > 1);
    assert.deepEqual(duplicated, [[307, ['CLOSED', 'CLOSED_PERIOD_ELAPSED']]]);
  });
});

describe('status — narrowing', () => {
  it('accepts every known status', () => {
    for (const value of Object.values(TransactionStatus)) {
      assert.equal(status.isTransactionStatus(value), true);
    }
  });

  it('rejects anything else', () => {
    for (const value of ['success', 'SOMETHING_NEW', '', 304, null, undefined, {}]) {
      assert.equal(status.isTransactionStatus(value), false);
    }
  });

  it('is not fooled by inherited Object properties', () => {
    // `'toString' in obj` would answer true here; `Object.hasOwn` does not.
    assert.equal(status.isTransactionStatus('toString'), false);
    assert.equal(status.isTransactionStatus('constructor'), false);
  });
});
