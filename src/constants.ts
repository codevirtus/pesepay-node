/**
 * Base Url for the payment gateway
 */
 export const BASE_URL = 'https://api.pesepay.com/api/payments-engine';

/**
 * Check payment status API endpoint
 */
 export const CHECK_PAYMENT_URL = `${BASE_URL}/v1/payments/check-payment`;

/**
 * Make Seamless payment API Endpoint
 */
 export const MAKE_SEAMLESS_PAYMENT_URL = `${BASE_URL}/v2/payments/make-payment`;

/**
 * Initiate payment API Endpoint
 */
 export const INITIATE_PAYMENT_URL = `${BASE_URL}/v1/payments/initiate`;

/**
 * Encryption algorithm
 */
export const ALGORITHM = 'aes-256-cbc';