/**
 * Payload encryption for the Pesepay payment endpoints: AES-256-CBC with
 * PKCS#7 padding and standard base64, keyed by the 32-character encryption
 * key. Any decryption failure is treated as fatal.
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
        `${label} must contain only ASCII characters, but character ${i + 1} is not ASCII.`,
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
    // A wrong key or an altered response fails the padding check here.
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
