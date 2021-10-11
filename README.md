### Getting Started
Import the library into your project/application

```javascript  
const { Pesepay } = require('pesepay');
```

Create an instance of the `Pesepay` class using your integration key and encryption key as supplied by Pesepay.

```javascript 
let pesepay = new Pesepay("INTEGRATION KEY", "ENCRYPTION KEY");
```

Set return and result urls

```javascript 
pesepay.resultUrl ='http://example.com/result';
pesepay.returnUrl ='http://example.com/return';
```

### Make seamless payment

Create an instance of the `CustomerDetails` class passing in the email, phoneNumber and/or name respectively.

```javascript 
let customer = new CustomerDetails('example@example.com');
```

Create a `Map` of the payment required fields and set the required fields.

```javascript
let requiredFields = new Map<string, string>();
requiredFields.set('Required field name/key', 'Required field value');
```

Create an instance of the `PesepaySeamlessTransaction` class passing in the payment reason, currency code, payment method code, customer details and required fields.

```javascript 
    let transaction = new PesepaySeamlessTransaction('Payment Reason', 'Currency Code', 'Payment Method Code', amount, customer, requiredFields)
```

Send of the payment to Pesepay

```javascript 
    pesepay.makeSeamlessPayment(transaction).then(response => {
        // Get the link to redirect the user to, then use it as you see fit. Note: The link can be null.
        let redirectLink = response.redirectUrl;

        // // Save poll url (This step is optional)
        let pollUrl = response.pollUrl;

    }).catch(err => {
        // Process error response
    })
```