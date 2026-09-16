import "server-only";

/**
 * Connection-request email delivery.
 *
 * Delivery is best effort by design: a failed or unconfigured email provider
 * must never fail the connection request itself, because the in-app
 * notification is the source of truth.
 */

import { Resend } from "resend";

export interface ConnectionRequestEmail {
  to: string;
  senderName: string;
  senderUsername: string;
  receiverName: string | null;
}

export type EmailOutcome =
  | { delivered: true }
  | { delivered: false; reason: "not_configured" | "failed" };

// Imported rather than redeclared: this string reaches people's inboxes, and it
// used to disagree with the name in the app's own header.
import { APP_NAME } from "@/lib/brand";

function appUrl(): string {
  const configured =
    process.env.NEXT_PUBLIC_APP_URL ?? process.env.TRUSTED_APP_ORIGIN ?? "";
  const first = configured.split(",")[0]?.trim() ?? "";
  return first.length > 0 ? first.replace(/\/+$/, "") : "http://localhost:3000";
}

function renderHtml(params: ConnectionRequestEmail): string {
  const link = `${appUrl()}/dashboard?tab=requests`;
  const greeting =
    params.receiverName === null ? "Hello," : `Hello ${params.receiverName},`;

  return `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;">
      <tr>
        <td style="padding:28px 28px 8px 28px;">
          <p style="margin:0;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;color:#2563eb;font-weight:bold;">
            ${APP_NAME}
          </p>
          <h1 style="margin:12px 0 0 0;font-size:22px;line-height:1.35;">
            ${params.senderName} wants to connect with you
          </h1>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 28px 0 28px;font-size:15px;line-height:1.6;color:#374151;">
          <p style="margin:0 0 12px 0;">${greeting}</p>
          <p style="margin:0 0 12px 0;">
            <strong>${params.senderName}</strong> (@${params.senderUsername})
            sent you a connection request. Once you accept, the two of you can
            message each other and start video calls.
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 28px 28px 28px;">
          <a href="${link}"
             style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:8px;">
            View the request
          </a>
          <p style="margin:16px 0 0 0;font-size:12px;color:#6b7280;">
            Or open this link: <span style="color:#374151;">${link}</span>
          </p>
        </td>
      </tr>
    </table>
    <p style="max-width:520px;margin:16px auto 0 auto;font-size:11px;color:#9ca3af;text-align:center;">
      You received this because someone requested to connect with you on ${APP_NAME}.
    </p>
  </body>
</html>`;
}

/** Never throws. Returns why delivery did not happen so callers can log it. */
export async function sendConnectionRequestEmail(
  params: ConnectionRequestEmail,
): Promise<EmailOutcome> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;

  if (
    apiKey === undefined ||
    apiKey.trim().length === 0 ||
    from === undefined ||
    from.trim().length === 0
  ) {
    return { delivered: false, reason: "not_configured" };
  }

  try {
    const resend = new Resend(apiKey);

    const response = await resend.emails.send({
      from,
      to: params.to,
      subject: `${params.senderName} wants to connect with you on ${APP_NAME}`,
      html: renderHtml(params),
    });

    if (response.error !== null) {
      console.error("connection_request_email_failed", {
        name: response.error.name,
        message: response.error.message,
      });
      return { delivered: false, reason: "failed" };
    }

    return { delivered: true };
  } catch (error: unknown) {
    console.error("connection_request_email_threw", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return { delivered: false, reason: "failed" };
  }
}
