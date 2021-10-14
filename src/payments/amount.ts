export class Amount {
    amount: number;
    currencyCode: string;
    
    constructor(amount: number, currencyCode: string) {
        this.amount = amount;
        this.currencyCode = currencyCode;
    }
}