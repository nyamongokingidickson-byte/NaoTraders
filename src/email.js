// Transactional email. Credentials live only in the backend environment and are never
// sent to the browser. Output is a multipart (HTML + text) message with a branded template.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const mask = (s) => (s ? `${s.slice(0, 3)}…${s.slice(-2)}` : '');

/** Dev-only ring buffer so tests and the local UI can inspect what was "sent". */
const outbox = [];
export const recentOutbox = (limit = 20) => outbox.slice(-limit).reverse();
export const outboxLength = () => outbox.length;

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderOtpEmail({ purpose, code, name, expiresMinutes }) {
  const isReset = purpose === 'reset';
  const title = isReset ? 'Reset your password' : 'Verify your email address';
  const lead = isReset
    ? 'We received a request to reset the password for your NovaTrade KE account. Enter this code to choose a new password.'
    : `Welcome to NovaTrade KE. Enter this code to finish creating your account${name ? `, ${esc(name.split(' ')[0])}` : ''}.`;
  const cta = isReset ? 'Reset password' : 'Verify email';

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;padding:0;background:#0b1020;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b1020;padding:32px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#121a30;border:1px solid #22304d;border-radius:16px;overflow:hidden;">
    <tr><td style="padding:28px 28px 8px 28px;">
      <div style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#4fd1c5;font-weight:700;">NovaTrade KE</div>
      <h1 style="margin:12px 0 0;font-size:22px;line-height:1.3;color:#f1f5ff;font-weight:700;">${title}</h1>
    </td></tr>
    <tr><td style="padding:12px 28px 0;color:#a9b6d0;font-size:15px;line-height:1.6;">${lead}</td></tr>
    <tr><td align="center" style="padding:24px 28px 8px;">
      <div style="background:#0b1020;border:1px dashed #3b82f6;border-radius:12px;padding:20px 12px;">
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:34px;letter-spacing:12px;font-weight:700;color:#f1f5ff;padding-left:12px;">${esc(code)}</div>
      </div>
      <div style="color:#7f8eb0;font-size:12px;padding-top:10px;">This code expires in ${expiresMinutes} minutes.</div>
    </td></tr>
    <tr><td style="padding:12px 28px 0;color:#a9b6d0;font-size:14px;line-height:1.6;">
      <strong style="color:#f1f5ff;">How to ${cta.toLowerCase()}:</strong>
      <ol style="margin:8px 0 0;padding-left:20px;color:#a9b6d0;">
        <li>Return to the NovaTrade KE sign-in page.</li>
        <li>Enter the 6-digit code above exactly as shown.</li>
        <li>${isReset ? 'Choose a new password of at least 8 characters.' : 'Complete verification to activate your account.'}</li>
      </ol>
    </td></tr>
    <tr><td style="padding:20px 28px 0;color:#7f8eb0;font-size:13px;line-height:1.6;">
      For your security this code can be used once and cannot be reissued before the resend cooldown.
      If you did not request this, you can ignore this email — your account is unchanged.
    </td></tr>
    <tr><td style="padding:22px 28px 26px;">
      <div style="border-top:1px solid #22304d;padding-top:16px;color:#63729a;font-size:12px;line-height:1.6;">
        NovaTrade KE · Nairobi, Kenya<br>
        Need help? Reply to this email or contact ${esc(config.email.replyTo)}.<br>
        Never share this code with anyone — our team will never ask for it.
      </div>
    </td></tr>
  </table>
  <div style="color:#4a577a;font-size:11px;padding-top:16px;">This is an automated message.</div>
</td></tr></table>
</body></html>`;

  const text = [
    `NovaTrade KE — ${title}`,
    '',
    lead.replace(/<[^>]+>/g, ''),
    '',
    `   ${code}`,
    '',
    `This code expires in ${expiresMinutes} minutes and can be used once.`,
    `How to ${cta.toLowerCase()}: return to the sign-in page, enter the code, then continue.`,
    '',
    'If you did not request this, ignore this email — your account is unchanged.',
    `Never share this code. Support: ${config.email.replyTo}`,
    'NovaTrade KE · Nairobi, Kenya',
  ].join('\n');

  return { subject: `${title} — NovaTrade KE (code ${code.slice(0, 2)}••••)`.replace(/code \d\d••••/, 'your verification code'), html, text, title };
}

function buildMime({ to, subject, html, text, messageId }) {
  const boundary = `nt_${crypto.randomBytes(8).toString('hex')}`;
  return [
    `From: ${config.email.from}`,
    `Reply-To: ${config.email.replyTo}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${messageId}>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/**
 * Send an email. Throws if the transport is misconfigured — a silent failure here would
 * leave a user stuck on an OTP screen with no code.
 */
export async function sendMail({ to, subject, html, text, tag = 'mail' }) {
  const messageId = `${crypto.randomUUID()}@novatrade.ke`;
  const message = { to, subject, html, text, messageId, from: config.email.from };
  const transport = config.email.transport;

  if (transport === 'console') {
    // Serverless filesystems are read-only except /tmp; never fail a signup over it.
    const dir = process.env.VERCEL ? '/tmp/novatrade-outbox' : config.email.outboxDir;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(dir, `${stamp}-${tag}-${to.replace(/[^a-z0-9]/gi, '_')}`);
    fs.writeFileSync(`${base}.eml`, buildMime(message), 'utf8');
    fs.writeFileSync(`${base}.json`, JSON.stringify(message, null, 2), 'utf8');
    outbox.push({ ...message, sentAt: Date.now(), transport });
    if (outbox.length > 200) outbox.shift();
    console.log(`[mail:console] ${subject} -> ${to} (${base}.eml)`);
    return { id: messageId, transport };
  }

  if (transport === 'smtp') {
    if (!config.email.smtp.host || !config.email.smtp.user || !config.email.smtp.pass) {
      throw Object.assign(new Error('EMAIL_NOT_CONFIGURED: set SMTP_HOST, SMTP_USER and SMTP_PASS'), { status: 500 });
    }
    const nodemailer = await import('nodemailer').then((m) => m.default ?? m);
    const tx = nodemailer.createTransport({
      host: config.email.smtp.host,
      port: config.email.smtp.port,
      secure: config.email.smtp.secure,
      auth: { user: config.email.smtp.user, pass: config.email.smtp.pass },
    });
    const info = await tx.sendMail({ from: config.email.from, replyTo: config.email.replyTo, to, subject, text, html, messageId });
    return { id: info.messageId || messageId, transport };
  }

  if (transport === 'resend') {
    if (!config.email.resendApiKey) throw Object.assign(new Error('EMAIL_NOT_CONFIGURED: set RESEND_API_KEY'), { status: 500 });
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.email.resendApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.email.from, reply_to: config.email.replyTo, to: [to], subject, html, text }),
    });
    if (!res.ok) throw Object.assign(new Error(`email provider rejected the message (${res.status})`), { status: 502 });
    const data = await res.json().catch(() => ({}));
    return { id: data.id || messageId, transport };
  }

  throw Object.assign(new Error(`unknown EMAIL_TRANSPORT "${transport}"`), { status: 500 });
}

/** Startup sanity check — fail loudly instead of at the first signup. */
export function emailStatus() {
  const t = config.email.transport;
  const configured = t === 'console' ? true : t === 'smtp' ? !!(config.email.smtp.host && config.email.smtp.user) : t === 'resend' ? !!config.email.resendApiKey : false;
  return { transport: t, configured, from: config.email.from, smtpHost: t === 'smtp' ? mask(config.email.smtp.host) : undefined };
}
