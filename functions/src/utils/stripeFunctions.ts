/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// import { onRequest } from "firebase-functions/v2/https";
import { getEventarc } from 'firebase-admin/eventarc';
import * as functionsV2 from "firebase-functions";
import * as functions from "firebase-functions/v1";
import * as functionsV1 from 'firebase-functions/v1';
// import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { onCustomEventPublished } from "firebase-functions/v2/eventarc";
import { Timestamp } from 'firebase-admin/firestore';

// import { getEventarc } from 'firebase-admin/eventarc';
import Stripe from 'stripe';
import {
    Product,
    Price,
    Subscription,
    CustomerData,
    TaxRate,
} from '../interfaces';
import * as logs from '../logs';
import config from '../config';
// import { Timestamp } from 'firebase-admin/firestore';

const apiVersion = '2025-02-24.acacia';

const stripe = new Stripe(config.stripeSecretKey || 'fallback_key_here', {
    apiVersion: apiVersion,
    // Register extension as a Stripe plugin
    // https://stripe.com/docs/building-plugins#setappinfo
    appInfo: {
        name: 'Firebase Invertase firestore-stripe-payments',
        version: '0.3.5',
    },
});


// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// export const helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });


if (admin.apps.length === 0) {
    admin.initializeApp();
}

//##############################################################
//stripe functions

const eventChannel =
    process.env.EVENTARC_CHANNEL &&
    getEventarc().channel(process.env.EVENTARC_CHANNEL, {
        allowedEventTypes: process.env.EXT_SELECTED_EVENTS,
    });

/**
 * Create a customer object in Stripe when a user is created.
 */
const createCustomerRecord = async ({
    email,
    uid,
    phone,
}: {
    email?: string;
    phone?: string;
    uid: string;
}) => {
    try {
        logs.creatingCustomer(uid);
        const customerData: CustomerData = {
            metadata: {
                firebaseUID: uid,
            },
        };
        if (email) customerData.email = email;
        if (phone) customerData.phone = phone;
        const customer = await stripe.customers.create(customerData);

        // Add a mapping record in Cloud Firestore.
        const customerRecord = {
            email: customer.email,
            stripeId: customer.id,
            stripeLink: `https://dashboard.stripe.com${customer.livemode ? '' : '/test'
                }/customers/${customer.id}`,
        };
        if (phone) (customerRecord as any).phone = phone;
        await admin
            .firestore()
            .collection(config.customersCollectionPath || 'customers')
            .doc(uid)
            .set(customerRecord, { merge: true });
        logs.customerCreated(customer.id, customer.livemode);
        return customerRecord;
    } catch (error) {
        logs.customerCreationError(error as Error, uid);
        return null;
    }
};

export const createCustomer = functionsV1.auth
    .user()
    .onCreate(async (user): Promise<void> => {
        if (!config.syncUsersOnCreate) return;
        const { email, uid, phoneNumber } = user;
        await createCustomerRecord({
            email,
            uid,
            phone: phoneNumber,
        });
    });

/**
 * Create a CheckoutSession or PaymentIntent based on which client is being used.
 */
export const createCheckoutSession = functionsV1
    .runWith({
        minInstances: config.minCheckoutInstances,
    })
    .firestore.document(
        `/${config.customersCollectionPath}/{uid}/checkout_sessions/{id}`
    )
    .onCreate(async (snap, context) => {
        const {
            client = 'web',
            amount,
            currency,
            mode = 'subscription',
            price,
            success_url,
            cancel_url,
            quantity = 1,
            payment_method_types,
            shipping_rates = [],
            metadata = {},
            automatic_payment_methods = { enabled: true },
            automatic_tax = false,
            invoice_creation = false,
            tax_rates = [],
            tax_id_collection = false,
            allow_promotion_codes = false,
            trial_period_days,
            line_items,
            billing_address_collection = 'required',
            collect_shipping_address = false,
            customer_update = {},
            locale = 'auto',
            promotion_code,
            client_reference_id,
            setup_future_usage,
            after_expiration = {},
            consent_collection = {},
            expires_at,
            phone_number_collection = {},
            payment_method_collection = 'always',
        } = snap.data();
        try {
            logs.creatingCheckoutSession(context.params.id);
            // Get stripe customer id
            let customerRecord = (await snap.ref.parent.parent?.get())?.data();
            if (!customerRecord?.stripeId) {
                const { email, phoneNumber } = await admin
                    .auth()
                    .getUser(context.params.uid);
                const newCustomerRecord = await createCustomerRecord({
                    uid: context.params.uid,
                    email,
                    phone: phoneNumber,
                });
                if (!newCustomerRecord) {
                    throw new Error('Failed to create customer record');
                }
                customerRecord = newCustomerRecord;
            }
            if (!customerRecord?.stripeId) {
                throw new Error('Failed to get stripeId from customer record');
            }
            const customer = customerRecord.stripeId;

            if (client === 'web') {
                // Get shipping countries
                const shippingCountries: Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[] =
                    collect_shipping_address
                        ? (
                            await admin
                                .firestore()
                                .collection(
                                    (config.stripeConfigCollectionPath ?? 'default_stripe_config_path') ||
                                    (config.productsCollectionPath ?? 'default_products_path')
                                )
                                .doc('shipping_countries')
                                .get()
                        ).data()?.['allowed_countries'] ?? []
                        : [];
                const sessionCreateParams: Stripe.Checkout.SessionCreateParams = {
                    billing_address_collection,
                    shipping_address_collection: { allowed_countries: shippingCountries },
                    // shipping_rates,
                    customer,
                    customer_update,
                    line_items: line_items
                        ? line_items
                        : [
                            {
                                price,
                                quantity,
                            },
                        ],
                    mode,
                    success_url,
                    cancel_url,
                    locale,
                    after_expiration,
                    consent_collection,
                    phone_number_collection,
                    ...(expires_at && { expires_at }),
                };
                if (payment_method_types) {
                    sessionCreateParams.payment_method_types = payment_method_types;
                }
                if (mode === 'subscription') {
                    sessionCreateParams.payment_method_collection =
                        payment_method_collection;
                    sessionCreateParams.subscription_data = {
                        metadata,
                    };
                    if (trial_period_days) {
                        sessionCreateParams.subscription_data.trial_period_days =
                            trial_period_days;
                    }
                    if (!automatic_tax) {
                        sessionCreateParams.subscription_data.default_tax_rates = tax_rates;
                    }
                } else if (mode === 'payment') {
                    sessionCreateParams.payment_intent_data = {
                        metadata,
                        ...(setup_future_usage && { setup_future_usage }),
                    };
                    if (invoice_creation) {
                        sessionCreateParams.invoice_creation = {
                            enabled: true,
                        };
                    }
                }
                if (automatic_tax) {
                    sessionCreateParams.automatic_tax = {
                        enabled: true,
                    };
                    sessionCreateParams.customer_update = sessionCreateParams.customer_update || {};
                    sessionCreateParams.customer_update.name = 'auto';
                    sessionCreateParams.customer_update.address = 'auto';
                    sessionCreateParams.customer_update.shipping = 'auto';
                }
                if (tax_id_collection) {
                    sessionCreateParams.tax_id_collection = {
                        enabled: true,
                    };
                    sessionCreateParams.customer_update = sessionCreateParams.customer_update || {};
                    sessionCreateParams.customer_update.name = 'auto';
                    sessionCreateParams.customer_update.address = 'auto';
                    sessionCreateParams.customer_update.shipping = 'auto';
                }
                if (promotion_code) {
                    sessionCreateParams.discounts = [{ promotion_code }];
                } else {
                    sessionCreateParams.allow_promotion_codes = allow_promotion_codes;
                }
                if (client_reference_id)
                    sessionCreateParams.client_reference_id = client_reference_id;
                const session = await stripe.checkout.sessions.create(
                    sessionCreateParams,
                    { idempotencyKey: context.params.id }
                );
                await snap.ref.set(
                    {
                        client,
                        mode,
                        sessionId: session.id,
                        url: session.url,
                        created: Timestamp.now(),
                    },
                    { merge: true }
                );
            } else if (client === 'mobile') {
                let paymentIntentClientSecret = null;
                let setupIntentClientSecret = null;
                if (mode === 'payment') {
                    if (!amount || !currency) {
                        throw new Error(
                            `When using 'client:mobile' and 'mode:payment' you must specify amount and currency!`
                        );
                    }
                    const paymentIntentCreateParams: Stripe.PaymentIntentCreateParams = {
                        amount,
                        currency,
                        customer,
                        metadata,
                        ...(setup_future_usage && { setup_future_usage }),
                    };
                    if (payment_method_types) {
                        paymentIntentCreateParams.payment_method_types =
                            payment_method_types;
                    } else {
                        paymentIntentCreateParams.automatic_payment_methods =
                            automatic_payment_methods;
                    }
                    const paymentIntent = await stripe.paymentIntents.create(
                        paymentIntentCreateParams
                    );
                    paymentIntentClientSecret = paymentIntent.client_secret;
                } else if (mode === 'setup') {
                    const setupIntent = await stripe.setupIntents.create({
                        customer,
                        metadata,
                        payment_method_types: payment_method_types ?? ['card'],
                    });
                    setupIntentClientSecret = setupIntent.client_secret;
                } else if (mode === 'subscription') {
                    const subscription = await stripe.subscriptions.create({
                        customer,
                        items: [{ price }],
                        trial_period_days: trial_period_days,
                        payment_behavior: 'default_incomplete',
                        expand: ['latest_invoice.payment_intent'],
                        metadata: {
                            firebaseUserUID: context.params.id,
                        },
                    });

                    paymentIntentClientSecret =
                        //@ts-ignore
                        subscription.latest_invoice.payment_intent.client_secret;
                } else {
                    throw new Error(
                        `Mode '${mode} is not supported for 'client:mobile'!`
                    );
                }
                const ephemeralKey = await stripe.ephemeralKeys.create(
                    { customer },
                    { apiVersion }
                );
                await snap.ref.set(
                    {
                        client,
                        mode,
                        customer,
                        created: Timestamp.now(),
                        ephemeralKeySecret: ephemeralKey.secret,
                        paymentIntentClientSecret,
                        setupIntentClientSecret,
                    },
                    { merge: true }
                );
            } else {
                throw new Error(
                    `Client ${client} is not supported. Only 'web' or ' mobile' is supported!`
                );
            }
            logs.checkoutSessionCreated(context.params.id);
            return;
        } catch (error: any) {
            logs.checkoutSessionCreationError(context.params.id, error);
            await snap.ref.set(
                { error: { message: error.message } },
                { merge: true }
            );
        }
    });

/**
 * Create a billing portal link
 */
export const createPortalLink = functionsV1.https.onCall(
    async (data, context) => {
        // Checking that the user is authenticated.
        const uid = context.auth?.uid;
        if (!uid) {
            // Throwing an HttpsError so that the client gets the error details.
            throw new functions.https.HttpsError(
                'unauthenticated',
                'The function must be called while authenticated!'
            );
        }
        try {
            const {
                returnUrl: return_url,
                locale = 'auto',
                configuration,
                flow_data,
            } = data;

            // Get stripe customer id
            let customerRecord = (
                await admin
                    .firestore()
                    .collection(config.customersCollectionPath || 'customers')
                    .doc(uid)
                    .get()
            ).data();

            if (!customerRecord?.stripeId) {
                // Create Stripe customer on-the-fly
                const { email, phoneNumber } = await admin.auth().getUser(uid);
                const newCustomerRecord = await createCustomerRecord({
                    uid,
                    email,
                    phone: phoneNumber,
                });

                if (!newCustomerRecord) {
                    throw new functions.https.HttpsError(
                        'internal',
                        'Failed to create customer record'
                    );
                }

                customerRecord = newCustomerRecord;
            }
            const customer = customerRecord.stripeId;

            const params: Stripe.BillingPortal.SessionCreateParams = {
                customer,
                return_url,
                locale,
            };
            if (configuration) {
                params.configuration = configuration;
            }
            if (flow_data) {
                // Ignore type-checking because `flow_data` was added to
                // `Stripe.BillingPortal.SessionCreateParams` in
                // stripe@11.2.0 (API version 2022-12-06)
                (params as any).flow_data = flow_data;
            }
            const session = await stripe.billingPortal.sessions.create(params);
            logs.createdBillingPortalLink(uid);
            return session;
        } catch (error: any) {
            logs.billingPortalLinkCreationError(uid, error);
            throw new functions.https.HttpsError('internal', error.message);
        }
    }
);

/**
 * Prefix Stripe metadata keys with `stripe_metadata_` to be spread onto Product and Price docs in Cloud Firestore.
 */
const prefixMetadata = (metadata: { [key: string]: any }) =>
    Object.keys(metadata).reduce((prefixedMetadata: { [key: string]: any }, key) => {
        prefixedMetadata[`stripe_metadata_${key}`] = metadata[key];
        return prefixedMetadata;
    }, {});

/**
 * Create a Product record in Firestore based on a Stripe Product object.
 */
const createProductRecord = async (product: Stripe.Product): Promise<void> => {
    const { firebaseRole, ...rawMetadata } = product.metadata;

    const productData: Product = {
        active: product.active,
        name: product.name,
        description: product.description,
        role: firebaseRole ?? null,
        images: product.images,
        metadata: product.metadata,
        tax_code: product.tax_code ?? null,
        ...prefixMetadata(rawMetadata),
    };
    await admin
        .firestore()
        .collection(config.productsCollectionPath || 'products')
        .doc(product.id)
        .set(productData, { merge: true });
    logs.firestoreDocCreated(config.productsCollectionPath || 'products', product.id);
};

/**
 * Create a price (billing price plan) and insert it into a subcollection in Products.
 */
const insertPriceRecord = async (price: Stripe.Price): Promise<void> => {
    if (price.billing_scheme === 'tiered')
        // Tiers aren't included by default, we need to retireve and expand.
        price = await stripe.prices.retrieve(price.id, { expand: ['tiers'] });

    const priceData: Price = {
        active: price.active,
        billing_scheme: price.billing_scheme,
        tiers_mode: price.tiers_mode,
        tiers: price.tiers ?? null,
        currency: price.currency,
        description: price.nickname,
        type: price.type,
        unit_amount: price.unit_amount ?? 0,
        recurring: price.recurring,
        interval: price.recurring?.interval ?? null,
        interval_count: price.recurring?.interval_count ?? null,
        trial_period_days: price.recurring?.trial_period_days ?? null,
        transform_quantity: price.transform_quantity,
        tax_behavior: price.tax_behavior ?? null,
        metadata: price.metadata,
        product: price.product,
        ...prefixMetadata(price.metadata),
    };
    const dbRef = admin
        .firestore()
        .collection(config.productsCollectionPath || 'products')
        .doc(price.product as string)
        .collection('prices');
    await dbRef.doc(price.id).set(priceData, { merge: true });
    logs.firestoreDocCreated('prices', price.id);
};

/**
 * Insert tax rates into the products collection in Cloud Firestore.
 */
const insertTaxRateRecord = async (taxRate: Stripe.TaxRate): Promise<void> => {
    const taxRateData: TaxRate = {
        ...taxRate,
        ...prefixMetadata(taxRate.metadata || {}),
    };

    Object.keys(taxRateData).forEach((key) => {
        if (taxRateData[key] === null) delete taxRateData[key];
    });

    await admin
        .firestore()
        .collection(config.productsCollectionPath || 'products')
        .doc('tax_rates')
        .collection('tax_rates')
        .doc(taxRate.id)
        .set(taxRateData);
    logs.firestoreDocCreated('tax_rates', taxRate.id);
};

/**
 * Copies the billing details from the payment method to the customer object.
 */
const copyBillingDetailsToCustomer = async (
    payment_method: Stripe.PaymentMethod
): Promise<void> => {
    const customer = payment_method.customer as string;
    const { name, phone, address } = payment_method.billing_details;

    // Convert null values to undefined to satisfy TypeScript
    let processedAddress;
    if (address !== null) {
        // Convert any null properties within address to undefined
        processedAddress = Object.fromEntries(
            Object.entries(address || {}).map(([key, value]) => [key, value === null ? undefined : value])
        );
    }

    await stripe.customers.update(customer, {
        name: name === null ? undefined : name,
        phone: phone === null ? undefined : phone,
        address: processedAddress
    });
};

/**
 * Manage subscription status changes.
 */
const manageSubscriptionStatusChange = async (
    subscriptionId: string,
    customerId: string,
    createAction: boolean
): Promise<void> => {
    // Get customer's UID from Firestore
    const customersSnap = await admin
        .firestore()
        .collection(config.customersCollectionPath || 'customers')
        .where('stripeId', '==', customerId)
        .get();
    if (customersSnap.size !== 1) {
        throw new Error('User not found!');
    }
    const uid = customersSnap.docs[0].id;
    // Retrieve latest subscription status and write it to the Firestore
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['default_payment_method', 'items.data.price.product'],
    });
    const price: Stripe.Price = subscription.items.data[0].price;
    const prices = [];
    for (const item of subscription.items.data) {
        prices.push(
            admin
                .firestore()
                .collection(config.productsCollectionPath || 'products')
                .doc((item.price.product as Stripe.Product).id)
                .collection('prices')
                .doc(item.price.id)
        );
    }
    const product: Stripe.Product = price.product as Stripe.Product;
    const role = product.metadata.firebaseRole ?? null;
    // Get reference to subscription doc in Cloud Firestore.
    const subsDbRef = customersSnap.docs[0].ref
        .collection('subscriptions')
        .doc(subscription.id);
    // Update with new Subscription status
    const subscriptionData: Subscription = {
        metadata: subscription.metadata,
        role,
        status: subscription.status,
        stripeLink: `https://dashboard.stripe.com${subscription.livemode ? '' : '/test'
            }/subscriptions/${subscription.id}`,
        product: admin
            .firestore()
            .collection(config.productsCollectionPath || 'products')
            .doc(product.id),
        price: admin
            .firestore()
            .collection(config.productsCollectionPath || 'products')
            .doc(product.id)
            .collection('prices')
            .doc(price.id),
        prices,
        quantity: subscription.items.data[0].quantity ?? 0,
        items: subscription.items.data,
        cancel_at_period_end: subscription.cancel_at_period_end,
        cancel_at: subscription.cancel_at
            ? Timestamp.fromMillis(subscription.cancel_at * 1000)
            : null,
        canceled_at: subscription.canceled_at
            ? Timestamp.fromMillis(subscription.canceled_at * 1000)
            : null,
        current_period_start: Timestamp.fromMillis(
            subscription.current_period_start * 1000
        ),
        current_period_end: Timestamp.fromMillis(
            subscription.current_period_end * 1000
        ),
        created: Timestamp.fromMillis(subscription.created * 1000),
        ended_at: subscription.ended_at
            ? Timestamp.fromMillis(subscription.ended_at * 1000)
            : null,
        trial_start: subscription.trial_start
            ? Timestamp.fromMillis(subscription.trial_start * 1000)
            : null,
        trial_end: subscription.trial_end
            ? Timestamp.fromMillis(subscription.trial_end * 1000)
            : null,
    };
    await subsDbRef.set(subscriptionData);

    logs.firestoreDocCreated('subscriptions', subscription.id);

    // Update their custom claims
    if (role) {
        try {
            // Get existing claims for the user
            const { customClaims } = await admin.auth().getUser(uid);
            // Set new role in custom claims as long as the subs status allows
            if (['trialing', 'active'].includes(subscription.status)) {
                logs.userCustomClaimSet(uid, 'stripeRole', role);
                await admin
                    .auth()
                    .setCustomUserClaims(uid, { ...customClaims, stripeRole: role });
            } else {
                logs.userCustomClaimSet(uid, 'stripeRole', 'null');
                await admin
                    .auth()
                    .setCustomUserClaims(uid, { ...customClaims, stripeRole: null });
            }
        } catch (error) {
            // User has been deleted, simply return.
            return;
        }
    }

    // NOTE: This is a costly operation and should happen at the very end.
    // Copy the billing deatils to the customer object.
    if (createAction && subscription.default_payment_method) {
        await copyBillingDetailsToCustomer(
            subscription.default_payment_method as Stripe.PaymentMethod
        );
    }

    return;
};

/**
 * Add invoice objects to Cloud Firestore.
 */
const insertInvoiceRecord = async (invoice: Stripe.Invoice) => {
    // Get customer's UID from Firestore
    const customersSnap = await admin
        .firestore()
        .collection(config.customersCollectionPath || 'customers')
        .where('stripeId', '==', invoice.customer)
        .get();
    if (customersSnap.size !== 1) {
        throw new Error('User not found!');
    }
    // Write to invoice to a subcollection on the subscription doc.
    await customersSnap.docs[0].ref
        .collection('subscriptions')
        .doc(invoice.subscription as string)
        .collection('invoices')
        .doc(invoice.id)
        .set(invoice);

    const prices = [];
    for (const item of invoice.lines.data) {
        if (!item.price) continue;
        prices.push(
            admin
                .firestore()
                .collection(config.productsCollectionPath || 'products')
                .doc(item.price.product as string)
                .collection('prices')
                .doc(item.price.id)
        );
    }

    // An Invoice object does not always have an associated Payment Intent
    const recordId: string = (invoice.payment_intent as string) ?? invoice.id;

    // Update subscription payment with price data
    await customersSnap.docs[0].ref
        .collection('payments')
        .doc(recordId)
        .set({ prices }, { merge: true });
    logs.firestoreDocCreated('invoices', invoice.id);
};

/**
 * Add PaymentIntent objects to Cloud Firestore for one-time payments.
 */
const insertPaymentRecord = async (
    payment: Stripe.PaymentIntent,
    checkoutSession?: Stripe.Checkout.Session
) => {
    // Get customer's UID from Firestore
    const customersSnap = await admin
        .firestore()
        .collection(config.customersCollectionPath || 'customers')
        .where('stripeId', '==', payment.customer)
        .get();
    if (customersSnap.size !== 1) {
        throw new Error('User not found!');
    }
    if (checkoutSession) {
        const lineItems = await stripe.checkout.sessions.listLineItems(
            checkoutSession.id
        );
        const prices = [];
        for (const item of lineItems.data) {
            // Add null/undefined check before accessing item.price.product
            if (item.price && item.price.product) {
                prices.push(
                    admin
                        .firestore()
                        .collection(config.productsCollectionPath || 'products')
                        .doc(item.price.product as string)
                        .collection('prices')
                        .doc(item.price.id)
                );
            }
        }
        const paymentWithExtras = payment as Stripe.PaymentIntent & {
            prices?: FirebaseFirestore.DocumentReference[];
            items?: Stripe.LineItem[]
        };
        paymentWithExtras.prices = prices;
        paymentWithExtras.items = lineItems.data;
    }
    // Write to invoice to a subcollection on the customer doc.
    await customersSnap.docs[0].ref
        .collection('payments')
        .doc(payment.id)
        .set(payment, { merge: true });
    logs.firestoreDocCreated('payments', payment.id);
};

/**
 * A webhook handler function for the relevant Stripe events.
 */
export const handleWebhookEvents = functionsV1.https.onRequest(
    async (req: functionsV1.https.Request, resp) => {
        const relevantEvents = new Set([
            'product.created',
            'product.updated',
            'product.deleted',
            'price.created',
            'price.updated',
            'price.deleted',
            'checkout.session.completed',
            'checkout.session.async_payment_succeeded',
            'checkout.session.async_payment_failed',
            'customer.subscription.created',
            'customer.subscription.updated',
            'customer.subscription.deleted',
            'tax_rate.created',
            'tax_rate.updated',
            'invoice.paid',
            'invoice.payment_succeeded',
            'invoice.payment_failed',
            'invoice.upcoming',
            'invoice.marked_uncollectible',
            'invoice.payment_action_required',
            'payment_intent.processing',
            'payment_intent.succeeded',
            'payment_intent.canceled',
            'payment_intent.payment_failed',
        ]);
        let event: Stripe.Event;

        // Instead of getting the `Stripe.Event`
        // object directly from `req.body`,
        // use the Stripe webhooks API to make sure
        // this webhook call came from a trusted source
        try {
            const signature = req.headers['stripe-signature'];
            if (!signature) {
                throw new Error('Missing stripe-signature header');
            }
            if (!config.stripeWebhookSecret) {
                throw new Error('Missing Stripe webhook secret');
            }
            event = stripe.webhooks.constructEvent(
                req.rawBody,
                signature,
                config.stripeWebhookSecret
            );
        } catch (error: any) {
            logs.badWebhookSecret(error);
            resp.status(401).send('Webhook Error: Invalid Secret');
            return;
        }

        if (relevantEvents.has(event.type)) {
            logs.startWebhookEventProcessing(event.id, event.type);
            try {
                switch (event.type) {
                    case 'product.created':
                    case 'product.updated':
                        await createProductRecord(event.data.object as Stripe.Product);
                        break;
                    case 'price.created':
                    case 'price.updated':
                        await insertPriceRecord(event.data.object as Stripe.Price);
                        break;
                    case 'product.deleted':
                        await deleteProductOrPrice(event.data.object as Stripe.Product);
                        break;
                    case 'price.deleted':
                        await deleteProductOrPrice(event.data.object as Stripe.Price);
                        break;
                    case 'tax_rate.created':
                    case 'tax_rate.updated':
                        await insertTaxRateRecord(event.data.object as Stripe.TaxRate);
                        break;
                    case 'customer.subscription.created':
                    case 'customer.subscription.updated':
                    case 'customer.subscription.deleted':
                        const subscription = event.data.object as Stripe.Subscription;
                        await manageSubscriptionStatusChange(
                            subscription.id,
                            subscription.customer as string,
                            event.type === 'customer.subscription.created'
                        );
                        break;
                    case 'checkout.session.completed':
                    case 'checkout.session.async_payment_succeeded':
                    case 'checkout.session.async_payment_failed':
                        const checkoutSession = event.data
                            .object as Stripe.Checkout.Session;
                        if (checkoutSession.mode === 'subscription') {
                            const subscriptionId = checkoutSession.subscription as string;
                            await manageSubscriptionStatusChange(
                                subscriptionId,
                                checkoutSession.customer as string,
                                true
                            );
                        } else {
                            const paymentIntentId = checkoutSession.payment_intent as string;
                            const paymentIntent = await stripe.paymentIntents.retrieve(
                                paymentIntentId
                            );
                            await insertPaymentRecord(paymentIntent, checkoutSession);
                        }
                        if (checkoutSession.tax_id_collection?.enabled && checkoutSession.customer_details) {
                            const customersSnap = await admin
                                .firestore()
                                .collection(config.customersCollectionPath || 'customers')
                                .where('stripeId', '==', checkoutSession.customer as string)
                                .get();
                            if (customersSnap.size === 1) {
                                customersSnap.docs[0].ref.set(
                                    checkoutSession.customer_details,
                                    { merge: true }
                                );
                            }
                        }
                        break;
                    case 'invoice.paid':
                    case 'invoice.payment_succeeded':
                    case 'invoice.payment_failed':
                    case 'invoice.upcoming':
                    case 'invoice.marked_uncollectible':
                    case 'invoice.payment_action_required':
                        const invoice = event.data.object as Stripe.Invoice;
                        await insertInvoiceRecord(invoice);
                        break;
                    case 'payment_intent.processing':
                    case 'payment_intent.succeeded':
                    case 'payment_intent.canceled':
                    case 'payment_intent.payment_failed':
                        const paymentIntent = event.data.object as Stripe.PaymentIntent;
                        await insertPaymentRecord(paymentIntent);
                        break;
                    default:
                        logs.webhookHandlerError(
                            new Error('Unhandled relevant event!'),
                            event.id,
                            event.type
                        );
                }

                if (eventChannel) {
                    await eventChannel.publish({
                        type: `com.stripe.v1.${event.type}`,
                        data: event.data.object,
                    });
                }

                logs.webhookHandlerSucceeded(event.id, event.type);
            } catch (error: any) {
                logs.webhookHandlerError(error, event.id, event.type);
                resp.json({
                    error: 'Webhook handler failed. View function logs in Firebase.',
                });
                return;
            }
        }

        // Return a response to Stripe to acknowledge receipt of the event.
        resp.json({ received: true });
    }
);

const deleteProductOrPrice = async (pr: Stripe.Product | Stripe.Price) => {
    if (pr.object === 'product') {
        await admin
            .firestore()
            .collection(config.productsCollectionPath || 'products')
            .doc(pr.id)
            .delete();
        logs.firestoreDocDeleted(config.productsCollectionPath || 'products', pr.id);
    }
    if (pr.object === 'price') {
        await admin
            .firestore()
            .collection(config.productsCollectionPath || 'products')
            .doc((pr as Stripe.Price).product as string)
            .collection('prices')
            .doc(pr.id)
            .delete();
        logs.firestoreDocDeleted('prices', pr.id);
    }
};

const deleteStripeCustomer = async ({
    uid,
    stripeId,
}: {
    uid: string;
    stripeId: string;
}) => {
    try {
        // Delete their customer object.
        // Deleting the customer object will immediately cancel all their active subscriptions.
        await stripe.customers.del(stripeId);
        logs.customerDeleted(stripeId);
        // Mark all their subscriptions as cancelled in Firestore.
        const update = {
            status: 'canceled',
            ended_at: Timestamp.now(),
        };
        // Set all subscription records to canceled.
        const subscriptionsSnap = await admin
            .firestore()
            .collection(config.customersCollectionPath || 'customers')
            .doc(uid)
            .collection('subscriptions')
            .where('status', 'in', ['trialing', 'active'])
            .get();
        subscriptionsSnap.forEach((doc) => {
            doc.ref.set(update, { merge: true });
        });
    } catch (error: any) {
        logs.customerDeletionError(error, uid);
    }
};

/*
 * The `onUserDeleted` deletes their customer object in Stripe which immediately cancels all their subscriptions.
export const onUserDeleted = functionsV1.auth.user().onDelete(async (user) => {
export const onUserDeleted = functions.auth.user().onDelete(async (user) => {
  if (!config.autoDeleteUsers) return;
  // Get the Stripe customer id.
  const customer = (
    await admin
      .firestore()
      .collection(config.customersCollectionPath)
      .doc(user.uid)
      .get()
  ).data();
  // If you use the `delete-user-data` extension it could be the case that the customer record is already deleted.
  // In that case, the `onCustomerDataDeleted` function below takes care of deleting the Stripe customer object.
  if (customer) {
    await deleteStripeCustomer({ uid: user.uid, stripeId: customer.stripeId });
  }
});

/*
 * The `onCustomerDataDeleted` deletes their customer object in Stripe which immediately cancels all their subscriptions.
 */
export const onCustomerDataDeleted = functionsV1.firestore
    .document(`/${config.customersCollectionPath}/{uid}`)
    .onDelete(async (snap, context) => {
        if (!config.autoDeleteUsers) return;
        const { stripeId } = snap.data();
        await deleteStripeCustomer({ uid: context.params.uid, stripeId });
    });



//##############################################################
//my stripe functions
export const handleInvoicePaymentSucceeded = onCustomEventPublished(
    "com.stripe.v1.invoice.payment_succeeded",
    async (event) => {
        const invoice = event.data;
        console.log('invoice payment succeeded received', invoice.id);
        const amount = invoice.amount_paid;

        try {
            //add or increment to firebase stats collection in document 'earnings' field 'totalEarnings' with the amount paid
            await admin.firestore().collection('stats').doc('earnings').update({
                totalEarnings: admin.firestore.FieldValue.increment(amount)
            });
            console.log(`Added ${amount} to total earnings`);
        } catch (error) {
            console.error('Error updating to total earnings:', error);

            try {
                //add to firebase stats collection in document 'earnings' field 'totalEarnings' with the amount paid
                await admin.firestore().collection('stats').doc('earnings').set({
                    totalEarnings: amount
                });
                console.log(`Set total earnings to ${amount}`);
            } catch (error) {
                console.error('Error adding total earnings:', error);
            }
        }


        // Extract customer ID from the event data
        const customerId = invoice.customer;

        if (customerId) {
            try {
                console.log('begin looking for customer', customerId);
                // Query Firestore to find the document with the corresponding stripeId
                const customerQuerySnapshot = await admin.firestore()
                    .collection('customers')
                    .where('stripeId', '==', customerId)
                    .get();

                if (!customerQuerySnapshot.empty) {
                    const customerDoc = customerQuerySnapshot.docs[0]; // Assuming stripeId is unique, get the first matching document
                    // const customerData = customerDoc.data();
                    const userId = customerDoc.id;
                    console.log('found user', userId);

                    try {
                        console.log('begin looking for user', userId);
                        // Extract the affiliateUserId from the users document
                        const userQuerySnapshot = await admin.firestore()
                            .collection('users')
                            .where('uid', '==', userId)
                            .get();

                        if (!userQuerySnapshot.empty) {
                            const userDoc = userQuerySnapshot.docs[0]; // Assuming stripeId is unique, get the first matching document
                            const userData = userDoc.data();
                            const affiliateUserId = userData.affiliateUserId;
                            console.log('found affiliate user', affiliateUserId);

                            if (affiliateUserId) {

                                try {
                                    // Add to the affiliate user's history
                                    await admin.firestore().collection(`users/${affiliateUserId}/affiliate`).add({
                                        amount: invoice.amount_paid,
                                        currency: invoice.currency,
                                        invoiceId: invoice.id,
                                        affiliateUserId: userId,
                                        customer: customerId,
                                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                                        type: 'earnings',
                                        uid: affiliateUserId,
                                    });

                                    console.log(`Added ${invoice.amount_paid} to affiliate user ${affiliateUserId}`);

                                    //update the affiliate user's balance
                                    await admin.firestore().collection('users').doc(affiliateUserId).update({
                                        affiliateBalance: {
                                            amount: admin.firestore.FieldValue.increment(invoice.amount_paid),
                                            currency: invoice.currency,
                                        }
                                    });

                                    console.log(`Updated affiliate user ${affiliateUserId} balance`);
                                } catch (error) {
                                    console.error('Error adding to affiliate user history:', error);
                                }
                            }
                        }
                    } catch (error) {
                        console.error('Error fetching user document:', error);
                    }

                } else {
                    console.error(`No customer found with stripeId ${customerId}`);
                }
            } catch (error) {
                console.error('Error fetching customer document:', error);
            }
        } else {
            console.error('Customer ID not found in invoice');
        }

    });

export const onCustomerCreated = functions.region('europe-west1').firestore
    .document('customers/{customerId}')
    .onCreate(async (snap, context) => {

        admin.firestore().collection('stats').doc('customers').update({
            customersCount: admin.firestore.FieldValue.increment(1)
        });

    });

export const onCustomerDeleted = functions.region('europe-west1').firestore
    .document('customers/{customerId}')
    .onDelete(async (snap, context) => {

        admin.firestore().collection('stats').doc('customers').update({
            customersCount: admin.firestore.FieldValue.increment(-1)
        });

    });

export const onCustomerSubscriptionCreated = functions.region('europe-west1').firestore
    .document('customers/{customerId}/subscriptions/{subscriptionId}')
    .onCreate(async (snap, context) => {
        const docData = snap.data();
        console.log(docData.status);
        if (docData.status === 'active' || docData.status === 'trialing') {
            console.log('incrementing');
            admin.firestore().collection('stats').doc('customers').update({
                subscribedCustomersCount: admin.firestore.FieldValue.increment(1)
            });
        } else {
            console.log('not incrementing');
        }

    });

export const cancelSubscription = functions.https.onCall(async (data, context) => {
    const { subscriptionId, customerId } = data;

    // Checking that the user is authenticated.
    const uid = context.auth?.uid;
    if (!uid) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError(
            "unauthenticated",
            "The function must be called while authenticated!"
        );
    }

    try {
        // Step 1: Retrieve the subscription from Stripe
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        // Step 2: Check if the subscription's customerId matches the provided customerId
        if (subscription.customer !== customerId) {
            throw new functions.https.HttpsError(
                "permission-denied",
                "The subscription does not belong to the provided customer."
            );
        }

        // Step 3: Cancel the subscription if the customerId matches
        const canceledSubscription = await stripe.subscriptions.cancel(subscriptionId);

        return canceledSubscription;
    } catch (error: any) {
        throw new functions.https.HttpsError("internal", error.message);
    }
});