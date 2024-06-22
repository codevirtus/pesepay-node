### Installation
```shell
npm install pesepay
```

### Getting Started
Import the library into your project/application

```js  
const { Pesepay } = require('pesepay')
```

Create an instance of the `Pesepay` class using your integration key and encryption key as supplied by Pesepay.

```js 
const pesepay = new Pesepay("INTEGRATION KEY", "ENCRYPTION KEY");
```

Set return and result urls

```js 
pesepay.resultUrl = 'https://example.com/result'
pesepay.returnUrl = 'https://example.com/return'
```

### Make seamless payment

Create the payment 
##### NB: Customer email or number should be provided

Obtain active currency codes from this api

https://api.pesepay.com/api/payments-engine/v1/currencies/active

obtain active payment methods for desired currency from this api
https://api.pesepay.com/api/payments-engine/v1/payment-methods/for-currency?currencyCode={CURRECNCY_CODE}


```js
const payment = pesepay.createPayment('CURRECNCY_CODE', 'PAYMENT_METHOD_CODE', 'CUSTOMER_EMAIL(OPTIONAL)', 'CUSTOMER_PHONE_NUMBER(OPTIONAL)', 'CUSTOMER_NAME(OPTIONAL)')
```

Create an `object` of the required fields (if any)
```js
const requiredFields = {'requiredFieldName': 'requiredFieldValue'}
```

Send of the payment
```js
pesepay.makeSeamlessPayment(payment, 'PAYMENT_REASON', AMOUNT, requiredFields).then(response => {
    if (response.success) {
        // Save the reference number and/or poll url (used to check the status of a transaction)
        const referenceNumber = response.referenceNumber;
        const pollUrl = response.pollUrl

    } else {
        // Get Error Message  
        const message = res.message;
    }
});
```

### Make redirect payment
Create a transaction
```js
const transaction = pesepay.createTransaction(amount, 'CURRENCY_CODE', 'PAYMENT_REASON')
```

Initiate the transaction
```js
pesepay.initiateTransaction(transaction).then(response => {
    if (response.success) {
        // Save the reference number and/or poll url (used to check the status of a transaction)
        const referenceNumber = response.referenceNumber;
        const pollUrl = response.pollUrl

        // Get the redirect url and redirect user to complete transaction 
        const redirectUrl = response.redirectUrl

    } else {
        // Get Error Message  
        const message = res.message;
    }
});
```

### Check Payment Status
#### Method 1: Check using reference number
```js
pesepay.checkPayment(referenceNumber).then(response => {
    if (response.success) {
        if (response.paid) {
            // Payment was successful
        }
    } else {
        // Get Error Message  
        const message = res.message;
    }
});
```
#### Method 2: Check using poll url
```js
pesepay.pollTransaction(pollUrl).then(response => {
    if (response.success) {
        if (response.paid) {
            // Payment was successful
        }
    } else {
        // Get Error Message  
        const message = res.message;
    }
});
```