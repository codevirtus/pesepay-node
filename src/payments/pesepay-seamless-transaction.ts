import { AmountDetails } from "./amount-details";
import { CustomerDetails } from "./customer-details";

export class PesepaySeamlessTransaction {
    reasonForPayment: string;
    paymentMethodCode: string;
    customer: CustomerDetails;
    resultUrl?: string;
    merchantReference?: string;
    returnUrl?: string;
    paymentMethodRequiredFields?: Map<string, string>;
    amountDetails: AmountDetails;
        
    constructor(reason: string, currency: string, paymentMethod: string, amount: number, customer: CustomerDetails, paymentMethodRequiredFields?: Map<string, string>, merchantReference?: string) {
        this.reasonForPayment = reason;
        this.paymentMethodCode = paymentMethod;
        this.amountDetails = new AmountDetails(amount, currency);
        this.customer = customer;
        this.paymentMethodRequiredFields = paymentMethodRequiredFields;
        this.merchantReference = merchantReference;
    }
}