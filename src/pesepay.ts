import axios from 'axios';
import { Buffer } from 'buffer';
import { Cipher,createCipheriv,createDecipheriv} from 'crypto';
import { Transaction } from "./payments/transaction";
import { Customer } from "./payments/customer";
import { Payment } from "./payments/payment";
import { Amount } from "./payments/amount";
import { PesepayResponse } from './response';
import { ALGORITHM, CHECK_PAYMENT_URL, MAKE_SEAMLESS_PAYMENT_URL, INITIATE_PAYMENT_URL } from "./constants";


export class Pesepay {

    private readonly integrationKey: string;
    private readonly encryptionKey: string;
    private readonly headers: {};
    public resultUrl?: string;
    public returnUrl?: string;

    constructor(integrationKey: string, encryptionKey: string) {
        this.integrationKey = integrationKey;
        this.encryptionKey = encryptionKey;
        this.headers = { 'key': this.integrationKey,  'Content-Type': 'application/json' }
    }

    initiateTransaction = async(transaction: Transaction): Promise<PesepayResponse> => {
      
        if (this.resultUrl == null)
            throw new Error('Result url has not beeen specified.');

        if (this.returnUrl == null)
            throw new Error('Return url has not been specified.');

        transaction.resultUrl = this.resultUrl;
        transaction.returnUrl = this.returnUrl;
        let payload = this.payloadEncrypt(JSON.stringify(transaction));
        try {
            const response = await axios.post(INITIATE_PAYMENT_URL, { payload }, { headers: this.headers, insecureHTTPParser:true });
            const resObj = JSON.parse(this.payloadDecrypt(response.data.payload));
            return new PesepayResponse(true, undefined, resObj.referenceNumber, resObj.pollUrl, resObj.redirectUrl);
        } catch(error: any) {
            const message = error.message ?? 'Something went wrong!';
            return new PesepayResponse(false, message);
        }
    }

    checkPayment = async(referenceNumber: string): Promise<PesepayResponse> => {
        const url = `${CHECK_PAYMENT_URL}?referenceNumber=${referenceNumber}`
        return this.pollTransaction(url)
    }

    pollTransaction = async(pollUrl: string): Promise<PesepayResponse> => {
        try {
            let response = await axios.get(pollUrl, { headers: this.headers , insecureHTTPParser:true});
            let payload = response.data['payload'];
            const resObj = JSON.parse(this.payloadDecrypt(payload)); 
            const paid = resObj.transactionStatus == 'SUCCESS';
            return new PesepayResponse(true, undefined, resObj.referenceNumber, resObj.pollUrl, resObj.redirectUrl, paid);
        } catch (error: any) {
            const message = error.message ?? 'Something went wrong!';
            return new PesepayResponse(false, message);
        }
    }

    makeSeamlessPayment = async(payment: Payment, reasonForPayment: string, amount: number, requiredFields?: {}): Promise<PesepayResponse> => {
        if (this.resultUrl == null)
            throw new Error('Result url has not beeen specified.');
        
        payment.resultUrl = this.resultUrl;
        payment.returnUrl = this.returnUrl;
        payment.reasonForPayment = reasonForPayment;
        payment.amountDetails = new Amount(amount, payment.currencyCode);

        payment.setRequiredFields({...requiredFields});

        let payload = this.payloadEncrypt(JSON.stringify(payment));

        try {
            let response = await axios.post(MAKE_SEAMLESS_PAYMENT_URL, { payload }, { headers: this.headers, insecureHTTPParser:true });
            const resObj = JSON.parse(this.payloadDecrypt(response.data.payload));            
            const paid = resObj.transactionStatus == 'SUCCESS';
            return new PesepayResponse(true, undefined, resObj.referenceNumber, resObj.pollUrl, resObj.redirectUrl, paid);
        } catch(error: any) {
            const message = error.message ?? 'Something went wrong!';
            return new PesepayResponse(false, message);          
        }
    }

    createPayment = (currencyCode: string, paymentMethodCode: string, email?: string, phone?: string, name?: string): Payment => {
        if (email == null && phone == null)
            throw new Error('Email and/or phone number should be provided');

        const customer = new Customer(email, phone, name);
        
        return new Payment(currencyCode, paymentMethodCode, customer);
    }

    createTransaction = (amount: number, currencyCode: string, paymentReason: string, merchantReference?: string): Transaction => {
        return new Transaction(amount, currencyCode, paymentReason, merchantReference);
    }

    private payloadEncrypt(payload: string) {
        const cipher = this.buildCipher(this.encryptionKey, "encrypt");
        return cipher.update(payload, 'utf8', 'base64') + cipher.final('base64');
    }

    private payloadDecrypt(payload: string) {
        var cipher = this.buildCipher(this.encryptionKey, "decrypt");
        return cipher.update(payload, 'base64', 'utf8') + cipher.final('utf8');
    }

    private buildCipher(key: string, mode: "encrypt" | "decrypt"): Cipher {
        let iv = Buffer.from(key.substr(0, 16), 'utf8');
        let keyBuffer = Buffer.from(key, 'utf8');
        
        if (mode === "encrypt")
            return createCipheriv(ALGORITHM, keyBuffer, iv);
        else
            return createDecipheriv(ALGORITHM, keyBuffer, iv);
    }
}