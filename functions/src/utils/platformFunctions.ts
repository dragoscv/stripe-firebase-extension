/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

import { sendEmail, sendPushNotification } from ".";

if (admin.apps.length === 0) {
    admin.initializeApp();
}

export const onOfferCreated = onDocumentCreated(
    {
        region: "europe-west1",
        document: "licitatii/{licitatieId}/oferte/{offerId}"
    },
    async (event) => {
        if (!event.data) {
            console.log("No data associated with the event");
            return;
        }

        const data = event.data.data();
        const context = { params: event.params };
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
    }
);

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