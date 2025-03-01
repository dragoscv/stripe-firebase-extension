import * as brevo from '@getbrevo/brevo';

const apiKey = process.env.BREVO_API_KEY as string;


export interface Email {
    sender: { name: string; email: string };
    receiver: { name: string; email: string }[];
    subject: string;
    body: string;
    htmlContent: string;
    replyTo: { name: string; email: string };
    headers: { [key: string]: string };
    params: { [key: string]: any };
}

export const sendEmail = async (email: Email) => {
    let apiInstance = new brevo.TransactionalEmailsApi();

    apiInstance.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, apiKey);

    let sendSmtpEmail = new brevo.SendSmtpEmail();

    sendSmtpEmail.subject = email.subject;
    sendSmtpEmail.htmlContent = email.htmlContent;
    sendSmtpEmail.sender = email.sender;
    sendSmtpEmail.to = email.receiver;
    sendSmtpEmail.replyTo = email.replyTo;
    sendSmtpEmail.headers = email.headers;
    sendSmtpEmail.params = email.params;

    try {
        const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log('API called successfully. Returned data: ' + JSON.stringify(data));
    } catch (error) {
        console.error(error);
    }
}
