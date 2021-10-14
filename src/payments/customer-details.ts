import { InvalidRequestError } from "../exceptions/invalid-request-error";

export class CustomerDetails {
    email?: string;
    phoneNumber?: string;
    name?: string;

    constructor(email?: string, phoneNumber?: string, name?: string) {
        if (email == null && phoneNumber == null)
            throw new InvalidRequestError('Customer details should have an email and/or phone number');

        this.email = email;
        this.phoneNumber = phoneNumber;
        this.name = name;
    }
}