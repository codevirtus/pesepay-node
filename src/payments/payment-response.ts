import { AmountDetails } from "./amount-details";

export interface PaymentResponse {
    referenceNumber: string;
    dateOfTransaction: Date;
    applicationId: number;
    applicationName: string;
    amountDetails: AmountDetails;
    reasonForPayment: string;
    transactionStatus: string;
    transactionStatusCode: number;
    transactionStatusDescription: string;
    resultUrl: string;
    returnUrl: string;
    pollUrl: string;
    redirectUrl: string;
}