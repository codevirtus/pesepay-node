export class AmountDetails {
    amount: number;
    currencyCode: string;
    // defaultCurrencyAmount: number;
    // defaultCurrencyCode: string;
    // transactionServiceFee: number;
    // totalTransactionAmount: number;
    // merchantAmount: number;

    constructor(amount: number, currencyCode: string) {
        this.amount = amount;
        this.currencyCode = currencyCode;
    }
}