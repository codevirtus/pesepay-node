/**
 * Payload encryption, matching the Pesepay server byte for byte.
 *
 * | | |
 * |---|---|
 * | cipher | `AES-256-CBC` (`AES/CBC/PKCS5PADDING` on the server) |
 * | key | the encryption key's 32 UTF-8 bytes, used directly — no KDF |
 * | IV | **the first 16 characters of that same key** |
 * | padding | PKCS#7 |
 * | encoding | standard base64, with `=` padding — not base64url |
 *
 * Two consequences worth being clear-eyed about:
 *
 * **The IV is derived from the key, so it is constant** — identical plaintext
 * always yields identical ciphertext, leaking equality between payloads. That
 * is the gateway's protocol, not a choice available here: the server derives
 * the IV the same way, so a random IV would simply fail to decrypt.
 *
 * **CBC has no integrity protection.** The PKCS#7 padding check is the only
 * thing between a corrupted response and a garbage `transactionStatus`, so
 * {@link decryptPayload} treats every failure as fatal.
 *
 * ## Why the key must be 32 ASCII characters
 *
 * The server derives the IV with `key.substring(0, 16)` — **UTF-16
 * characters**; this module slices **bytes**. Identical for ASCII, different
 * for anything else, and the two sides would then encrypt under different IVs,
 * producing plausible-looking garbage in the first block and correct data
 * afterwards. Real keys are 32-character hex UUIDs, so the check costs nothing.
 *
 * @packageDocumentation
 */

import { createCipheriv, createDecipheriv } from 'node:crypto';
import { PesepayConfigError, PesepayCryptoError } from './errors.js';

const ALGORITHM = 'aes-256-cbc';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

/** Standard base64 alphabet with optional padding, and nothing else. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Throws unless `key` is exactly 32 ASCII characters. Call once at
 * construction — failing at startup beats failing mid-checkout. The error names
 * the problem but never echoes the key.
 *
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
    if (key.charCodeAt(i) > 0x7f) {
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
 * @throws {PesepayConfigError} If the key is not 32 ASCII characters.
 * @throws {PesepayCryptoError} If the cipher itself fails.
 */
export function encryptPayload(key: string, plaintext: string): string {
  assertValidEncryptionKey(key);

  try {
    const cipher = createCipheriv(ALGORITHM, keyBytes(key), ivBytes(key));
    return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
  } catch {
    // The underlying error is dropped on purpose: an OpenSSL error can carry
    // key material in its detail fields, and this object may be logged.
    throw new PesepayCryptoError('Failed to encrypt the request payload.');
  }
}

/**
 * Decrypts a `payload` from the gateway.
 *
 * Checks the base64 and the block alignment before touching the cipher, so a
 * plain-JSON error body routed here fails with a message that says so rather
 * than with an OpenSSL padding error.
 *
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
    // The padding check is CBC's only integrity signal, so this is the branch
    // that catches a wrong key or a tampered response.
    throw new PesepayCryptoError(
      'Failed to decrypt the gateway payload. The encryption key does not match ' +
        'the one registered for this integration key, or the response was altered ' +
        'in transit.',
    );
  }

  return plaintext.toString('utf8');
}

function keyBytes(key: string): Buffer {
  return Buffer.from(key, 'utf8');
}

/**
 * Safe to slice as bytes only because {@link assertValidEncryptionKey} has
 * established the key is ASCII, where one character is one byte.
 */
function ivBytes(key: string): Buffer {
  return Buffer.from(key.slice(0, IV_LENGTH), 'utf8');
}
