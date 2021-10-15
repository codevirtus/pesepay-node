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
    // Save the poll url and reference number (used to check the status of a transaction)
    const pollUrl = response.pollUrl;
    const referenceNumber = response.referenceNumber

}).catch(err => {
    // Handle error
});
```

### Make payment
#### Step 1: Initiate a transaction

Create a transaction
```js
const transaction = pesepay.createTransaction('APP_ID', 'APP_CODE','APP_CODE', amount, 'CURRENCY_CODE', 'PAYMENT_REASON')
```

Initiate the transaction
```js
pesepay.initiateTransaction(transaction).then(response => {
    // Get the redirect url and use it as you see fit     
    redirectUrl = response.redirectUrl
    // Save the reference number (used to check the status of a transaction and to make the payment)
    referenceNumber = response.referenceNumber

}).catch(error => {
    // Handle error
});
```

#### Step 2: Make the payment

Create the payment 
##### NB: Customer email or number should be provided

```js
const payment = pesepay.createPayment('CURRECNCY_CODE', 'PAYMENT_METHOD_CODE', 'CUSTOMER_EMAIL(OPTIONAL)', 'CUSTOMER_PHONE_NUMBER(OPTIONAL)', 'CUSTOMER_NAME(OPTIONAL)')
```

Create a `object` of the required fields (if any)

```js
const requiredFields = {'requiredFieldName': 'requiredFieldValue'}
```

Send of the payment
```js
pesepay.makePayment(payment, referenceNumber, requiredFields).then(response => {
    // Save the poll url (used to check the status of a transaction)
    const pollUrl = response.pollUrl

}).catch(err => {
    // Handle error
});
```

### Check Payment Status
#### Method 1: Check using reference number
```js
pesepay.checkPayment(referenceNumber).then(response => {

    if (response.transactionStatus == 'SUCCESS') {
        // payment was successful
    }
}).catch(error => {
    // Handle error
});
```
#### Method 2: Check using poll url
```js
pesepay.checkPayment(pollUrl).then(response => {

    if (response.transactionStatus == 'SUCCESS') {
        // payment was successful
    }
}).catch(error => {
    // Handle error
});
```