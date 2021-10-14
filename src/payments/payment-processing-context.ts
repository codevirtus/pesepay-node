import { CustomerDetails } from "./customer-details";

export class PaymentProcessingContext {
    referenceNumber: string;
    currencyCode: string;
    paymentMethodCode: string;
    customer: CustomerDetails;
    paymentRequestFields?: Map<string, string>;

    constructor(referenceNumber: string, currencyCode: string, paymentMethodCode: string, customer: CustomerDetails) {
        this.referenceNumber = referenceNumber;
        this.currencyCode = currencyCode;
        this.paymentMethodCode = paymentMethodCode;
        this.customer = customer;
    }
}