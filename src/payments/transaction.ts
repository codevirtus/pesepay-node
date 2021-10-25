import { Amount } from "./amount";

export class Transaction {
    resultUrl?: string;
    returnUrl?: string;
    merchantReference?: string;
    amountDetails: Amount;
    transactionType: string;
    reasonForPayment: string;

    constructor(amount: number, currencyCode: string, reasonForPayment: string, merchantReference?: string) {
        this.amountDetails = new Amount(amount, currencyCode);
        this.transactionType = "BASIC";
        this.reasonForPayment = reasonForPayment;
        this.merchantReference = merchantReference;
    }
}