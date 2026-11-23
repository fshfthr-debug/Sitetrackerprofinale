// Outbound email, used for account recovery.
//
// The backend has no SMTP library installed, so this talks to a mail provider over
// HTTPS. Set ONE of these on the host and reset emails are delivered to the inbox:
//
//   RESEND_API_KEY    https://resend.com  (free tier; the default sender below
//                     works without verifying a domain, but the provider only
//                     delivers to the address that owns the account)
//   SENDGRID_API_KEY  https://sendgrid.com
//
// MAIL_FROM overrides the sender, e.g. "SiteTrackerPro <no-reply@yourdomain.com>".
//
// With no key configured the app still recovers accounts: the reset link is written
// to the server log, where the person running the deployment can read it. That is
// the only fallback, and it never exposes anything to the browser.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SENDGRID_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';
const TIMEOUT_MS = 10000;

// Which delivery path a reset email would take right now. Read by the API so the
// screen can tell the person where to look for the link.
function emailDeliveryChannel() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SENDGRID_API_KEY) return 'sendgrid';
  return 'log';
}

const mailFrom = () => (process.env.MAIL_FROM || 'SiteTrackerPro <onboarding@resend.dev>').trim();

// "Name <address>" -> { name, email }. SendGrid wants the two apart.
function splitFrom(from) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (match) return { name: match[1] || undefined, email: match[2] };
  return { email: from };
}

function resetEmailBody({ link, minutes }) {
  const text = [
    'Someone asked to reset the password for your SiteTrackerPro account.',
    '',
    'Open this link to choose a new password:',
    link,
    '',
    'The link works once and expires in ' + minutes + ' minutes.',
    'If you did not ask for this, you can ignore this email - your password stays as it is.'
  ].join('\n');

  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c211d;line-height:1.6">',
    '<p>Someone asked to reset the password for your SiteTrackerPro account.</p>',
    '<p><a href="' + link + '" style="display:inline-block;padding:11px 18px;background:#a45f30;color:#fff;border-radius:8px;text-decoration:none">Choose a new password</a></p>',
    '<p style="font-size:13px;color:#5c6360">Or paste this address into your browser:<br>' + link + '</p>',
    '<p style="font-size:13px;color:#5c6360">The link works once and expires in ' + minutes + ' minutes.<br>',
    'If you did not ask for this, you can ignore this email - your password stays as it is.</p>',
    '</div>'
  ].join('');

  return { text, html };
}

async function postJson(url, headers, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'SiteTrackerPro/1.0', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  if (!response.ok) {
    // Provider error text is useful in the server log and harmless there.
    const detail = await response.text().catch(() => '');
    throw new Error('mail provider answered ' + response.status + ': ' + detail.slice(0, 400));
  }
}

// Sends the reset email and reports the channel that was used:
// 'resend' / 'sendgrid' when it was accepted, 'log' when no provider is set,
// 'failed' when the provider refused it. Never throws - recovery must not 500.
async function sendPasswordResetEmail({ to, link, minutes }) {
  const channel = emailDeliveryChannel();
  if (channel === 'log') return 'log';

  const subject = 'Reset your SiteTrackerPro password';
  const { text, html } = resetEmailBody({ link, minutes });

  try {
    if (channel === 'resend') {
      await postJson(
        RESEND_ENDPOINT,
        { Authorization: 'Bearer ' + process.env.RESEND_API_KEY },
        { from: mailFrom(), to: [to], subject, text, html }
      );
    } else {
      const from = splitFrom(mailFrom());
      await postJson(
        SENDGRID_ENDPOINT,
        { Authorization: 'Bearer ' + process.env.SENDGRID_API_KEY },
        {
          personalizations: [{ to: [{ email: to }] }],
          from,
          subject,
          content: [
            { type: 'text/plain', value: text },
            { type: 'text/html', value: html }
          ]
        }
      );
    }
    return channel;
  } catch (err) {
    console.error('[' + new Date().toISOString() + '] Password reset email via ' + channel + ' failed:', err.message);
    return 'failed';
  }
}

module.exports = { emailDeliveryChannel, sendPasswordResetEmail, splitFrom };
