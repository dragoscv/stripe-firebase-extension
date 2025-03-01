/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// import { onRequest } from "firebase-functions/v2/https";
import * as functions from "firebase-functions/v1";
// import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
// import { onCustomEventPublished } from "firebase-functions/v2/eventarc";

// import { getEventarc } from 'firebase-admin/eventarc';
// import Stripe from 'stripe';
// import {
//     Product,
//     Price,
//     Subscription,
//     CustomerData,
//     TaxRate,
// } from './interfaces';
// import * as logs from './logs';
// import config from './config';
// import { Timestamp } from 'firebase-admin/firestore';

import { sendEmail, sendPushNotification } from ".";

// const apiVersion = '2022-11-15';
// const stripe = new Stripe(config.stripeSecretKey, {
//     apiVersion: '2024-09-30.acacia',
//     // Register extension as a Stripe plugin
//     // https://stripe.com/docs/building-plugins#setappinfo
//     appInfo: {
//         name: 'Firebase Invertase firestore-stripe-payments',
//         version: '0.3.5',
//     },
// });


// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// export const helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });


if (admin.apps.length === 0) {
    admin.initializeApp();
}




export const onOfferCreated = functions.region("europe-west1").firestore
    .document("licitatii/{licitatieId}/oferte/{offerId}")
    .onCreate(async (snap, context) => {
        const data = snap.data();
        console.log(data);

        try {
            await admin.firestore().collection("statistics").doc("offers").update({
                totalCount: admin.firestore.FieldValue.increment(1)
            });
            await admin.firestore().collection("licitatii").doc(context.params.licitatieId).update({
                offersCount: admin.firestore.FieldValue.increment(1)
            });
        } catch (error) {
            console.error(error);
            await admin.firestore().collection("statistics").doc("offers").set({
                totalCount: 1
            });
            await admin.firestore().collection("licitatii").doc(context.params.licitatieId).set({
                offersCount: 1
            });
        }


        //notify user
        try {
            await notifyUser(data.uid, "Ofertare noua", `Ofertare noua pentru licitatia ${data.licitatieTitle}`, {
                senderEmail: "no-reply@bursax.ro",
                action: "offer",
                licitatieId: context.params.licitatieId,
                offerId: context.params.offerId
            });
        } catch (error) {
            console.error(error);
        }


    });


const notifyUser = async (uid: string, title: string, body: string, props: any) => {
    const userDoc = await admin.firestore().collection("users").doc(uid).get();
    const userData = userDoc.data();

    if (userData && userData.pushToken) {
        await sendPushNotification({
            tokens: [userData.pushToken],
            title,
            body,
            data: props
        }, {} as functions.https.CallableContext);
    }

    //send email
    if (userData && userData.email) {
        await sendEmail({
            receiver: [{ name: userData.displayName, email: userData.email }],
            subject: title,
            body,
            htmlContent: body,
            sender: { name: "Licitatii", email: props.senderEmail },
            replyTo: { name: "Licitatii", email: props.senderEmail },
            headers: {},
            params: {}
        });
    }
}