export class PesepayResponse {
    public success: boolean;
    public message?: string;
    public referenceNumber?: string;
    public pollUrl?: string;
    public redirectUrl?: string;
    public paid: boolean;

    constructor(success: boolean = false, message?: string, referenceNumber?: string, 
        pollUrl?: string, redirectUrl?: string, paid: boolean = false) {
        this.success = success;
        this.message = message;
        this.referenceNumber = referenceNumber;
        this.pollUrl = pollUrl;
        this.redirectUrl = redirectUrl;
        this.paid = paid;
    }
}