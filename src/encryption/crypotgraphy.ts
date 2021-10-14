import crypto, { Cipher } from 'crypto';
import { Buffer } from 'buffer';

enum EncryptionMode {
    DECRYPT, ENCRYPT
}

export class EncryptionContext {
    data: string;
    key: string;

    constructor(rawData: string, key: string) {
        this.data = rawData;
        this.key = key;
    }
}

export class Cryptography {
    private static ALGORITHM: string = 'aes-256-cbc';

    static encrypt(payload: EncryptionContext) {
        let cipher = this.buildCipher(payload.key, EncryptionMode.ENCRYPT);
        return cipher.update(payload.data, 'utf8', 'base64') + cipher.final('base64');
    }

    static decrypt(payload: EncryptionContext) {
        var cipher = this.buildCipher(payload.key, EncryptionMode.DECRYPT);
        return cipher.update(payload.data, 'base64', 'utf8') + cipher.final('utf8');
    }

    private static buildCipher(key: string, mode: EncryptionMode): Cipher {
        let iv = Buffer.from(key.substr(0, 16), 'utf8');
        let keyBuffer = Buffer.from(key, 'utf8');
        
        if (mode === EncryptionMode.ENCRYPT)
            return crypto.createCipheriv(this.ALGORITHM, keyBuffer, iv);
        else
            return crypto.createDecipheriv(this.ALGORITHM, keyBuffer, iv);
    }
}