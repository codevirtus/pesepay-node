## Getting Started
Import the library into your project/application

```js  
const { Pesepay } = require('pesepay');
```

Create an instance of the `Pesepay` class using your integration key and encryption key as supplied by Pesepay.

```js 
const pesepay = new Pesepay("INTEGRATION KEY", "ENCRYPTION KEY");
```

Set return and result urls

```js 
pesepay.resultUrl ='http://example.com/result';
pesepay.returnUrl ='http://example.com/return';
```

## Make seamless payment

Create an instance of the `CustomerDetails` class passing in the email, phoneNumber and/or name respectively.

```js 
const customer = new CustomerDetails('example@example.com');
```

Create a `Map` of the payment required fields and set the required fields.

```js
let requiredFields = new Map<string, string>();
requiredFields.set('Required field name/key', 'Required field value');
```

Create an instance of the `PesepaySeamlessTransaction` class passing in the payment reason, currency code, payment method code, customer details and required fields.

```js 
const transaction = new PesepaySeamlessTransaction('Payment Reason', 'Currency Code', 'Payment Method Code', amount, customer, requiredFields)
```

Send of the payment to Pesepay

```js 
pesepay.makeSeamlessPayment(transaction).then(response => {
    // Get the link to redirect the user to, then use it as you see fit. Note: The link can be null.
    const redirectLink = response.redirectUrl;

    // Save referenceNumber (This step is optional)
    const referenceNumber = response.referenceNumber;

}).catch(err => {
    // Handle error response
})
```

## Initiate transaction

Create an instance of the `CreateTransactionCommand` class passing it your application id, application code, application name, transaction amount, currency code and reason for payment.

```js
const transaction = new CreateTransactionCommand('APP_ID', 'APP_CODE', 'APP_NAME', AMOUNT, 'CURRENCY_CODE', 'REASON_FOR_PAYMENT');
```

Invoke the `initiateTransaction()` method to send of the transaction

```js
pesepay.initiateTransaction(transaction).then(res => {
    // Save reference number
    const referenceNumber = res.referenceNumber;        
    
    // Get redirect url and redirect user to complete transaction if no custom payment page available
    const redirectUrl = res.redirectUrl;       

}).catch(error => {
    // Handle error response                
})
```

## Make payment 

Create an instance of the `CustomerDetails` class passing in the email, phoneNumber and/or name respectively.

```js 
const customer = new CustomerDetails('example@example.com');
```

Create a `Map` of the payment required fields and set the required fields (if any).

```js
let requiredFields = new Map<string, string>();
requiredFields.set('Required field name/key', 'Required field value');
```

Create an instance of the `PaymentProcessingContext` class passing in the referenceNumber, currencyCode, paymentMethodCode, and customerDetails.

```js
const payment = new PaymentProcessingContext(referenceNumber, 'ZWL', 'PZW201', customer);
```

Send of the payment to Pesepay for processing

```js
pesepay.makePayment(payment).then(res => {
    // Save the reference number
    const referenceNumber = res.referenceNumber;   
}).catch(err => {
    // Handle error response        
});
```

## Check Payment 

Invoke the `checkPayment()` method passing in the reference number

```js
pesepay.checkPayment('20211014121606536-FD119981').then(res => {
   // Get the status        
   const status = res.transactionStatus;

}).catch(error => {
   // Handle error response
})
```
