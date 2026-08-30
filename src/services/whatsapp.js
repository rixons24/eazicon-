// WhatsApp Business Cloud API client. Each hotel connects their own
// WhatsApp Business number (phone_number_id + access token, both issued by
// Meta), so every call here is scoped to a specific hotel's credentials —
// there's no shared Ezicon WhatsApp number.
//
// Scope note: text-only for v1. WhatsApp also supports voice notes, images,
// and rich templates, none of which are handled here yet. A voice note from
// a guest will currently be ignored by the webhook rather than transcribed.

const GRAPH_BASE = 'https://graph.facebook.com/v19.0';

// Sends a plain text message to a guest's WhatsApp number.
async function sendMessage({ phoneNumberId, accessToken, to, text }) {
  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WhatsApp send failed: ${res.status} ${errText}`);
  }
  return res.json();
}

module.exports = { sendMessage };
