/**
 * Payload encryption, matching the Pesepay server byte for byte.
 *
 * ## The scheme
 *
 * | | |
 * |---|---|
 * | cipher | `AES-256-CBC` (`AES/CBC/PKCS5PADDING` on the server) |
 * | key | the encryption key's 32 UTF-8 bytes, used directly — no KDF |
 * | IV | **the first 16 characters of that same key** |
 * | padding | PKCS#7 (identical to PKCS#5 at a 16-byte block) |
 * | encoding | standard base64, with `=` padding — not base64url |
 *
 * ## Two things to be clear-eyed about
 *
 * **The IV is derived from the key, so it is constant.** Encrypting the same
 * plaintext under the same key always produces the same ciphertext, which
 * leaks equality between payloads to anyone who can see them. This is a
 * property of the gateway's protocol, not a choice available to this package —
 * the server derives the IV the same way, and a random IV would simply fail to
 * decrypt. It is one more reason the transport is HTTPS-only.
 *
 * **CBC has no integrity protection.** Nothing here authenticates the
 * ciphertext; the PKCS#7 padding check is the only thing standing between a
 * corrupted response and a garbage `transactionStatus`. So
 * {@link decryptPayload} treats every decryption failure as fatal and never
 * returns a best-effort string.
 *
 * ## Why the key must be 32 ASCII characters
 *
 * The server derives the IV with `key.substring(0, 16)`, which slices **UTF-16
 * characters**; this module slices **bytes**. For any key in ASCII those are
 * the same 16 bytes. For a key containing so much as one accented character
 * they are not, and the two sides encrypt under different IVs — producing
 * ciphertext that decrypts to plausible-looking garbage in the first block and
 * correct data afterwards. {@link assertValidEncryptionKey} rejects that case
 * up front instead of letting it surface as a mystery 500 in production.
 *
 * Real Pesepay keys are 32-character hex UUIDs, so this costs nothing.
 *
 * @packageDocumentation
 */

import { createCipheriv, createDecipheriv } from 'node:crypto';
import { PesepayConfigError, PesepayCryptoError } from './errors.js';

/** Node's name for the server's `AES/CBC/PKCS5PADDING`. */
const ALGORITHM = 'aes-256-cbc';

/** AES-256 takes a 32-byte key; the gateway issues it as 32 ASCII characters. */
const KEY_LENGTH = 32;

/** AES block size, and therefore the IV length. */
const IV_LENGTH = 16;

/** Standard base64 alphabet, with optional `=` padding, and nothing else. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Throws unless `key` is exactly 32 ASCII characters.
 *
 * Call this once, when the client is constructed — failing at startup is far
 * cheaper than failing halfway through a checkout. The thrown error names the
 * problem and the observed length but **never echoes the key itself**.
 *
 * @param key - The encryption key from your Pesepay dashboard.
 * @param label - What to call the key in the error message.
 * @throws {PesepayConfigError} If the key is missing, mis-sized, or non-ASCII.
 */
export function assertValidEncryptionKey(key: string, label = 'encryptionKey'): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new PesepayConfigError(`${label} is required.`);
  }

  if (key.length !== KEY_LENGTH) {
    throw new PesepayConfigError(
      `${label} must be exactly ${KEY_LENGTH} characters, but is ${key.length}. ` +
        'Pesepay issues it as a 32-character hex string; check for a truncated ' +
        'copy-paste or surrounding whitespace.',
    );
  }

  for (let i = 0; i < key.length; i++) {
    const codePoint = key.charCodeAt(i);
    if (codePoint > 0x7f) {
      throw new PesepayConfigError(
        `${label} must contain only ASCII characters, but character ${i + 1} is not ASCII. ` +
          'The gateway derives the AES initialisation vector from the first 16 ' +
          'characters of the key, and does so by character while this SDK does so ' +
          'by byte — a non-ASCII key makes the two disagree and every payload ' +
          'decrypt to garbage.',
      );
    }
  }
}

/**
 * Encrypts a JSON string for the `{ payload }` envelope.
 *
 * @param key - A 32-character ASCII encryption key.
 * @param plaintext - The JSON document to encrypt, as a string.
 * @returns Standard base64 ciphertext, ready to place in `payload`.
 * @throws {PesepayConfigError} If the key is not 32 ASCII characters.
 * @throws {PesepayCryptoError} If the cipher itself fails.
 */
export function encryptPayload(key: string, plaintext: string): string {
  assertValidEncryptionKey(key);

  try {
    const cipher = createCipheriv(ALGORITHM, keyBytes(key), ivBytes(key));
    return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
  } catch {
    // Deliberately swallows the underlying error: an OpenSSL error can carry key
    // material in its detail fields, and this object may be logged.
    throw new PesepayCryptoError('Failed to encrypt the request payload.');
  }
}

/**
 * Decrypts a `payload` from the gateway.
 *
 * Validates the base64 and the ciphertext length before touching the cipher, so
 * that a plain-JSON error body accidentally routed through here fails with a
 * message that says so rather than with an OpenSSL padding error.
 *
 * @param key - The same 32-character ASCII key used to encrypt.
 * @param ciphertextBase64 - The `payload` field, verbatim.
 * @returns The decrypted plaintext, as UTF-8.
 * @throws {PesepayConfigError} If the key is not 32 ASCII characters.
 * @throws {PesepayCryptoError} If the payload is malformed, truncated, altered,
 *   or was encrypted under a different key.
 */
export function decryptPayload(key: string, ciphertextBase64: string): string {
  assertValidEncryptionKey(key);

  if (typeof ciphertextBase64 !== 'string' || ciphertextBase64.length === 0) {
    throw new PesepayCryptoError('The gateway returned an empty payload.');
  }

  if (!BASE64.test(ciphertextBase64)) {
    throw new PesepayCryptoError(
      'The gateway payload is not valid base64. This usually means a plain-JSON ' +
        'body reached the decryption path — errors are never encrypted.',
    );
  }

  const ciphertext = Buffer.from(ciphertextBase64, 'base64');

  if (ciphertext.length === 0 || ciphertext.length % IV_LENGTH !== 0) {
    throw new PesepayCryptoError(
      `The gateway payload is ${ciphertext.length} bytes, which is not a whole ` +
        `number of ${IV_LENGTH}-byte AES blocks. The response was truncated.`,
    );
  }

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(ALGORITHM, keyBytes(key), ivBytes(key));
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // The padding check is the only integrity signal CBC offers, so this is
    // the branch that catches a wrong key or a tampered response. The underlying error is
    // dropped for the same reason as in encryptPayload.
    throw new PesepayCryptoError(
      'Failed to decrypt the gateway payload. The encryption key does not match ' +
        'the one registered for this integration key, or the response was altered ' +
        'in transit.',
    );
  }

  return plaintext.toString('utf8');
}

/** The key's own bytes are the AES key — there is no key derivation step. */
function keyBytes(key: string): Buffer {
  return Buffer.from(key, 'utf8');
}

/**
 * The IV is the first 16 characters of the key.
 *
 * Safe to slice as bytes only because {@link assertValidEncryptionKey} has
 * already established the key is ASCII, where one character is one byte.
 */
function ivBytes(key: string): Buffer {
  return Buffer.from(key.slice(0, IV_LENGTH), 'utf8');
}
