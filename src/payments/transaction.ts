import { Amount } from "./amount";

export class Transaction {
    resultUrl?: string;
    returnUrl?: string;
    merchantReference?: string;
    applicationId: number;
    applicationName: string;
    applicationCode: string;
    amountDetails: Amount;
    transactionType: string;
    reasonForPayment: string;
    // internalReference: string

    constructor(applicationId: number, applicationCode: string, applicationName: string, amount: number, currencyCode: string, reasonForPayment: string, merchantReference?: string) {
        this.applicationId = applicationId;
        this.applicationCode = applicationCode;
        this.applicationName = applicationName;
        this.amountDetails = new Amount(amount, currencyCode);
        this.transactionType = "BASIC";
        this.reasonForPayment = reasonForPayment;
        this.merchantReference = merchantReference;
    }
}