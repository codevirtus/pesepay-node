import { Cryptography, EncryptionContext } from "./encryption/crypotgraphy";
import { InvalidRequestError } from "./exceptions/invalid-request-error";
import { PesepaySeamlessTransaction } from "./payments/pesepay-seamless-transaction";
import axios from 'axios';
import { PaymentResponse } from "./payments/payment-response";
import { AmountDetails } from "./payments/amount-details";
import { PaymentProcessingContext } from "./payments/payment-processing-context";
import { CreateTransactionCommand } from "./payments/create-transaction";


const BASE_URL = 'https://api.test.pesepay.com/api/payments-engine';

export class Pesepay {

    private readonly integrationKey: string;
    private readonly encryptionKey: string;
    private readonly headers: {};
    public resultUrl?: string;
    public returnUrl?: string;

    constructor(integrationKey: string, encryptionKey: string) {
        this.integrationKey = integrationKey;
        this.encryptionKey = encryptionKey;
        this.headers = { 'key': this.integrationKey }
    }

    initiateTransaction = async(transaction: CreateTransactionCommand): Promise<any> => {
        if (this.resultUrl == null)
            throw new InvalidRequestError('Result url has not beeen specified.');

        if (this.returnUrl == null)
            throw new InvalidRequestError('Return url has not been specified.');

        transaction.resultUrl = this.resultUrl;
        transaction.returnUrl = this.returnUrl;

        let ecnryptioncontext = new EncryptionContext(JSON.stringify(transaction), this.encryptionKey);

        let payload = Cryptography.encrypt(ecnryptioncontext);

        try {
            let response = await axios.post(`${BASE_URL}/v1/payments/initiate`, { payload }, { headers: this.headers });
            let decryptionContext = new EncryptionContext(response.data.payload, this.encryptionKey);
            return JSON.parse(Cryptography.decrypt(decryptionContext));
        } catch(error: any) {
            throw new Error(error.response.data.message || 'Something went wrong!');
        }
    }

    makePayment = async(paymentProcessing: PaymentProcessingContext): Promise<any> => {
        let paymentProcessingJson = JSON.parse(JSON.stringify(paymentProcessing));

        let requiredFieldsObject: {[k: string]: string} = {};
        paymentProcessing.paymentRequestFields?.forEach((v, k) => {
            requiredFieldsObject[k] = v;
        });

        paymentProcessingJson.paymentRequestFields = requiredFieldsObject;      
        
        let ecnryptioncontext = new EncryptionContext(JSON.stringify(paymentProcessing), this.encryptionKey);

        let payload = Cryptography.encrypt(ecnryptioncontext);

        try {
            return await axios.post(`${BASE_URL}/v1/payments/make-payment/secure`, { payload }, { headers: this.headers });
        } catch(error: any) {
            throw new Error(error.response.data.message || 'Something went wrong!');
        }
    }

    makeSeamlessPayment = async(pesepaySeamlessTransaction: PesepaySeamlessTransaction): Promise<PaymentResponse> => {
        if (this.resultUrl == null)
            throw new InvalidRequestError('Result url has not beeen specified.');
        
        pesepaySeamlessTransaction.resultUrl = this.resultUrl;
        pesepaySeamlessTransaction.returnUrl = this.returnUrl;

        let transactionJson = JSON.parse(JSON.stringify(pesepaySeamlessTransaction));

        let requiredFieldsObject: {[k: string]: string} = {};
        pesepaySeamlessTransaction.paymentMethodRequiredFields?.forEach((v, k) => {
            requiredFieldsObject[k] = v;
        });

        transactionJson.paymentMethodRequiredFields = requiredFieldsObject;      
        
        let ecnryptioncontext = new EncryptionContext(JSON.stringify(transactionJson), this.encryptionKey);

        let payload = Cryptography.encrypt(ecnryptioncontext);

        let response = await axios.post(`${BASE_URL}/v2/payments/make-payment`, { payload }, { headers: this.headers });

        try {
            let decryptionContext = new EncryptionContext(response.data.payload, this.encryptionKey);
            return JSON.parse(Cryptography.decrypt(decryptionContext));
        } catch(error: any) {
            throw new Error(error.response.data.message || 'Something went wrong!');            
        }
    }

    checkPayment = async(referenceNumber: string): Promise<any> => {
        try {
            let response = await axios.get(`${BASE_URL}/v1/payments/check-payment?referenceNumber=${referenceNumber}`, { headers: this.headers });
            let decryptContext = new EncryptionContext(response.data['payload'], this.encryptionKey);
            return JSON.parse(Cryptography.decrypt(decryptContext));
        } catch (error: any) {
            throw new Error(error.response.data.message || 'Something went wrong!');
        }
    }
}