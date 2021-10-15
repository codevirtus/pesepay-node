import { Customer } from "./customer";
import { Amount } from "./amount";

export class Payment {
    currencyCode: string;
    paymentMethodCode: string;
    customer: Customer;
    referenceNumber?: string;
    amountDetails?: Amount;
    reasonForPayment?: string;
    paymentRequestFields?: {};
    paymentMethodRequiredFields?: {};
    merchantReference?: string;
    returnUrl?: string;
    resultUrl?: string;

    constructor(currencyCode: string, paymentMethodCode: string, customer: Customer) {
        this.currencyCode = currencyCode;
        this.paymentMethodCode = paymentMethodCode
        this.customer = customer;
    }

    setRequiredFields({...requiredFields}) {
        this.paymentMethodRequiredFields = requiredFields;
        this.paymentRequestFields = requiredFields;
    }
}