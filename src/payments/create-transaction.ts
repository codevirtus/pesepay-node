import { AmountDetails } from "./amount-details";

export class CreateTransactionCommand {
    resultUrl?: string;
    returnUrl?: string;
    merchantReference?: string;
    applicationId: number;
    applicationName: string;
    applicationCode: string;
    amountDetails: AmountDetails;
    transactionType: string;
    reasonForPayment: string;
    // internalReference: string

    constructor(applicationId: number, applicationCode: string, applicationName: string, amount: number, currencyCode: string, reasonForPayment: string, merchantReference?: string) {
        this.applicationId = applicationId;
        this.applicationCode = applicationCode;
        this.applicationName = applicationName;
        this.amountDetails = new AmountDetails(amount, currencyCode);
        this.transactionType = "BASIC";
        this.reasonForPayment = reasonForPayment;
        this.merchantReference = merchantReference;
    }
        
}