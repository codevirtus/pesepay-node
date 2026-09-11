/**
 * AES interop against the Java gateway.
 *
 * Every expected ciphertext in `java-vectors.json` was produced by the server's
 * own cipher path (`scripts/java/GenerateVectors.java`). They are never
 * regenerated from this implementation: a fixture written by the code under
 * test proves only self-consistency, which was never in doubt.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { crypto, errors } from '../fixtures/modules.mts';

interface Vector {
  name: string;
  note: string;
  key: string;
  plaintext: string;
  plaintextByteLength: number;
  ciphertextBase64: string;
  ciphertextByteLength: number;
}

interface VectorFile {
  generator: { javaVersion: string };
  algorithm: { transformation: string; nodeAlgorithm: string };
  vectors: Vector[];
  tampered: {
    key: string;
    originalPlaintext: string;
    validCiphertextBase64: string;
    tamperedCiphertextBase64: string;
  };
}

const fixture: VectorFile = JSON.parse(
  readFileSync(new URL('../fixtures/java-vectors.json', import.meta.url), 'utf8'),
);

const KEY = '3d2f8c1a4b6e7f905a1c2d3e4f506172';

describe('crypto — interop with the Java gateway', () => {
  it('has vectors that really came from Java', () => {
    // Guards against someone "fixing" a failing vector by regenerating it here.
    assert.equal(fixture.algorithm.transformation, 'AES/CBC/PKCS5PADDING');
    assert.ok(fixture.generator.javaVersion.length > 0);
    assert.ok(fixture.vectors.length >= 10, 'expected the full vector set');
  });

  for (const vector of fixture.vectors) {
    it(`encrypts '${vector.name}' exactly as Java does`, () => {
      assert.equal(crypto.encryptPayload(vector.key, vector.plaintext), vector.ciphertextBase64);
    });

    it(`decrypts Java's '${vector.name}' ciphertext`, () => {
      assert.equal(crypto.decryptPayload(vector.key, vector.ciphertextBase64), vector.plaintext);
    });
  }

  it('adds a whole padding block on an exact block multiple', () => {
    // The classic PKCS#7 mistake is padding only when there is a remainder,
    // which yields 16 bytes here instead of 32 — and Java then rejects every
    // payload whose length happens to be a multiple of 16.
    const exact = fixture.vectors.find((v) => v.name === 'exact-one-block');
    assert.ok(exact, 'fixture must include an exact-block-multiple case');
    assert.equal(exact.plaintextByteLength, 16);
    assert.equal(exact.ciphertextByteLength, 32);

    const produced = Buffer.from(crypto.encryptPayload(exact.key, exact.plaintext), 'base64');
    assert.equal(produced.byteLength, 32);
  });

  it('grows every input to the next strictly larger multiple of 16', () => {
    for (const vector of fixture.vectors) {
      const bytes = Buffer.from(vector.ciphertextBase64, 'base64').byteLength;
      assert.equal(bytes, vector.plaintextByteLength + 16 - (vector.plaintextByteLength % 16));
      assert.ok(bytes > vector.plaintextByteLength, `${vector.name} must grow`);
    }
  });

  it('is deterministic, because the IV comes from the key', () => {
    // Not an oversight to be tidied up later: the gateway derives the IV the
    // same way, so a random IV would fail to decrypt server-side.
    assert.equal(crypto.encryptPayload(KEY, 'hello'), crypto.encryptPayload(KEY, 'hello'));

    // Keys sharing a 16-character prefix share an IV but not the AES key, so
    // the ciphertexts must still differ.
    const shared = '0'.repeat(16);
    assert.notEqual(
      crypto.encryptPayload(`${shared}${'a'.repeat(16)}`, 'hello'),
      crypto.encryptPayload(`${shared}${'b'.repeat(16)}`, 'hello'),
    );
  });

  it('round-trips through itself for every vector', () => {
    for (const vector of fixture.vectors) {
      assert.equal(
        crypto.decryptPayload(vector.key, crypto.encryptPayload(vector.key, vector.plaintext)),
        vector.plaintext,
      );
    }
  });
});

describe('crypto — tampered ciphertext', () => {
  it('decrypts the untampered control', () => {
    assert.equal(
      crypto.decryptPayload(fixture.tampered.key, fixture.tampered.validCiphertextBase64),
      fixture.tampered.originalPlaintext,
    );
  });

  it('throws rather than returning garbage when a byte is flipped', () => {
    // CBC has no integrity protection; the padding check is the only thing
    // between a mangled response and a garbage transactionStatus.
    assert.throws(
      () => crypto.decryptPayload(fixture.tampered.key, fixture.tampered.tamperedCiphertextBase64),
      (error: unknown) => {
        assert.ok(error instanceof errors.PesepayCryptoError);
        assert.equal(error.code, 'ERR_PESEPAY_CRYPTO');
        return true;
      },
    );
  });

  it('throws on a truncated payload', () => {
    const truncated = Buffer.from(fixture.tampered.validCiphertextBase64, 'base64')
      .subarray(0, 20)
      .toString('base64');
    assert.throws(
      () => crypto.decryptPayload(fixture.tampered.key, truncated),
      errors.PesepayCryptoError,
    );
  });

  it('throws when the wrong key is used', () => {
    assert.throws(
      () =>
        crypto.decryptPayload(
          'ffffffffffffffffffffffffffffffff',
          fixture.tampered.validCiphertextBase64,
        ),
      errors.PesepayCryptoError,
    );
  });

  it('names the real cause when a plain-JSON error body reaches the decryptor', () => {
    // A live failure mode, not hypothetical: Pesepay never encrypts errors. An
    // OpenSSL padding message would send the reader hunting for a key mismatch
    // that does not exist.
    assert.throws(
      () => crypto.decryptPayload(KEY, '{"message":"Invalid integration key"}'),
      /not valid base64/,
    );
  });
});

describe('crypto — key validation', () => {
  it('accepts a real 32-character key', () => {
    assert.doesNotThrow(() => crypto.assertValidEncryptionKey(KEY));
  });

  for (const [label, key] of [
    ['empty', ''],
    ['too short', '3d2f8c1a4b6e7f905a1c2d3e4f5061'],
    ['too long', `${KEY}00`],
  ] as const) {
    it(`rejects a key that is ${label}`, () => {
      assert.throws(() => crypto.assertValidEncryptionKey(key), errors.PesepayConfigError);
    });
  }

  it('rejects a non-ASCII key', () => {
    // 32 characters, but Java's substring(0, 16) and a byte slice disagree on
    // which bytes form the IV, so the two sides would silently desync.
    const key = `é${'0'.repeat(31)}`;
    assert.equal(key.length, 32);
    assert.throws(() => crypto.assertValidEncryptionKey(key), errors.PesepayConfigError);
    assert.throws(() => crypto.encryptPayload(key, 'x'), errors.PesepayConfigError);
    assert.throws(() => crypto.decryptPayload(key, 'x'), errors.PesepayConfigError);
  });

  it('never puts key material in an error message or stack', () => {
    // Covers the config path and the crypto path; the second is the one that
    // wraps an OpenSSL error whose detail fields can carry key material.
    const shortSecret = 'S3CRETKEYS3CRETKEYS3CRETKEYS3C';
    const validSecret = 'S3CRETKEYS3CRETKEYS3CRETKEYS3CRE';
    assert.equal(validSecret.length, 32);

    for (const [secret, run] of [
      [shortSecret, (): unknown => crypto.assertValidEncryptionKey(shortSecret)],
      [shortSecret, (): unknown => crypto.encryptPayload(shortSecret, 'x')],
      [validSecret, (): unknown => crypto.decryptPayload(validSecret, 'x')],
      [
        validSecret,
        (): unknown =>
          crypto.decryptPayload(validSecret, fixture.tampered.tamperedCiphertextBase64),
      ],
    ] as const) {
      assert.throws(run, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(secret), 'key leaked into the message');
        assert.ok(!(error.stack ?? '').includes(secret), 'key leaked into the stack');
        assert.ok(!JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(secret));
        return true;
      });
    }
  });
});
