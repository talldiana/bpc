// Outgoing e-mail. Set RESEND_API_KEY and MAIL_FROM (wrangler secrets) to send
// mails. Without them, mails are only printed when ENVIRONMENT=development
// (.dev.vars, read by `wrangler dev`); anywhere else sending fails, so one-time
// links never end up in the production logs.

export function createMailer(env) {
  if (env.RESEND_API_KEY && env.MAIL_FROM) {
    return {
      async send({ to, subject, text }) {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: env.MAIL_FROM, to, subject, text }),
        });
        if (!response.ok) throw new Error(`Mail provider returned ${response.status}`);
      },
    };
  }
  if (env.ENVIRONMENT === 'development') {
    return {
      // Prints the mail body (with the link) but not the address.
      async send({ subject, text }) {
        console.log(`[mail not sent, no provider configured] ${subject}\n${text}`);
      },
    };
  }
  return {
    async send() {
      throw new Error('No mail provider configured (RESEND_API_KEY, MAIL_FROM)');
    },
  };
}
