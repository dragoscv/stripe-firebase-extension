/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// import { onRequest } from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
// import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { onCustomEventPublished } from "firebase-functions/v2/eventarc";

// import { getEventarc } from 'firebase-admin/eventarc';
import Stripe from 'stripe';
// import {
//     Product,
//     Price,
//     Subscription,
//     CustomerData,
//     TaxRate,
// } from './interfaces';
// import * as logs from './logs';
import config from '../config';
// import { Timestamp } from 'firebase-admin/firestore';

// const apiVersion = '2022-11-15';
const stripe = new Stripe(config.stripeSecretKey || 'fallback_key_here', {
    apiVersion: '2022-11-15',
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


//stripe functions
exports.handleInvoicePaymentSucceeded = onCustomEventPublished(
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

exports.onCustomerCreated = functions.region('europe-west1').firestore
    .document('customers/{customerId}')
    .onCreate(async (snap, context) => {

        admin.firestore().collection('stats').doc('customers').update({
            customersCount: admin.firestore.FieldValue.increment(1)
        });

    });

exports.onCustomerDeleted = functions.region('europe-west1').firestore
    .document('customers/{customerId}')
    .onDelete(async (snap, context) => {

        admin.firestore().collection('stats').doc('customers').update({
            customersCount: admin.firestore.FieldValue.increment(-1)
        });

    });

exports.onCustomerSubscriptionCreated = functions.region('europe-west1').firestore
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

exports.cancelSubscription = functions.https.onCall(async (data, context) => {
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