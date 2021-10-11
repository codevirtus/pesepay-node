import { AmountDetails } from "./amount-details";

export class CreateTransactionCommand {
    applicationId: number;
    applicationName: string;
    applicationCode: string;
    amountDetails: AmountDetails;
    reasonForPayment: string;
    resultUrl: string;
    returnUrl: string;
    // chargeType: string;
    merchantReference?: string;
    transactionType: string;
    internalReference?: string;

    constructor(applicationId: number, applicationName: string, applicationCode: string, reasonForPayment: string, resultUrl: string, returnUrl: string, amountDetails: AmountDetails) {
        this.transactionType = 'BASIC';
        this.applicationId = applicationId;
        this.applicationCode = applicationCode;
        this.applicationName = applicationName;
        this.reasonForPayment = reasonForPayment;
        this.resultUrl = resultUrl;
        this.returnUrl = returnUrl;
        this.amountDetails = amountDetails;
    }
}