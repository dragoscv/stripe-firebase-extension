import * as functions from "firebase-functions";
import * as functionsV1 from "firebase-functions/v1";
// import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
if (admin.apps.length === 0) {
    admin.initializeApp();
}

export interface Notification {
    tokens: string[];
    title: string;
    body: string;
    data: { [key: string]: string };
}
export const sendPushNotification = async (notificationData: Notification, context: functionsV1.https.CallableContext) => {
    const { tokens, title, body, data } = notificationData;

    const payload = {
        notification: {
            title,
            body,
        },
        data,
    };

    admin.messaging().sendEachForMulticast({
        tokens: tokens,
        notification: payload.notification,
        data: payload.data
    })
        .then((response) => {
            console.log('Successfully sent message:', response);
        })
        .catch((error) => {
            console.error('Error sending message:', error);
        });
};