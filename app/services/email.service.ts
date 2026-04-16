/**
 * Email service using nodemailer.
 * Behind EMAIL_ENABLED flag — when disabled, all calls throw.
 *
 * Config via env:
 *  - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 */

import nodemailer from "nodemailer";

export interface EmailSendInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer;
  }>;
}

export class EmailService {
  private transporter: nodemailer.Transporter;

  constructor() {
    if (process.env.EMAIL_ENABLED !== "true") {
      throw new Error("Envio de e-mail desabilitado (EMAIL_ENABLED=false)");
    }

    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!host || !user || !pass) {
      throw new Error(
        "Configuracao SMTP incompleta (SMTP_HOST, SMTP_USER, SMTP_PASS)",
      );
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  }

  async send(input: EmailSendInput): Promise<void> {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;

    await this.transporter.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
      })),
    });
  }
}
