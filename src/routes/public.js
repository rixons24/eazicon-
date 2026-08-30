const express = require('express');
const QRCode = require('qrcode');
const { query } = require('../db/pool');
const { loadHotel } = require('../middleware/auth');

const router = express.Router();

// GET /chat/:hotelId — branded standalone page for QR code / bio-link flow.
// This is the "no website access" path: a hotel can be live even without
// touching their own site by sharing this URL or printing the QR code.
router.get('/chat/:hotelId', loadHotel, (req, res) => {
  const b = req.hotel.branding || {};
  const primary = b.primaryColor || '#0a2e4a';
  const accent = b.accentColor || '#a6f5c0';
  const logo = b.logoUrl || '';
  const tagline = b.tagline || 'Your stay, your way';
  const name = req.hotel.name;
  const agentName = b.agentName || `${name} Assistant`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(agentName)}</title>
${logo ? `<link rel="icon" href="${escapeAttr(logo)}">` : ''}
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  body {
    background: linear-gradient(to top, ${accent} 0%, #ffffff 100%);
    min-height: 100vh; display: flex; flex-direction: column;
  }
  #brand-header {
    padding: 28px 20px 20px; text-align: center; background: transparent; color: ${primary};
  }
  #brand-header img { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; margin-bottom: 10px; background: white; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  #brand-header h1 { font-size: 18px; font-weight: 600; }
  #brand-header p { font-size: 13px; opacity: 0.75; margin-top: 2px; }
  /* Center the chat panel with a sensible max width instead of stretching
     full-bleed on wide desktop screens — this was the "too wide" bug. */
  #chat-frame-wrap { flex: 1; padding: 16px; display: flex; justify-content: center; }
  #chat-frame {
    width: 100%; max-width: 460px; border: none; border-radius: 16px;
    background: white; box-shadow: 0 24px 60px -12px rgba(0,0,0,0.22), 0 8px 24px rgba(0,0,0,0.08);
  }
  #powered-by { text-align: center; padding: 10px; font-size: 11px; color: rgba(0,0,0,0.4); }
</style>
</head>
<body>
  <div id="brand-header">
    ${logo ? `<img src="${escapeAttr(logo)}" alt="${escapeAttr(name)} logo">` : ''}
    <h1>${escapeHtml(agentName)}</h1>
    <p>${escapeHtml(tagline)}</p>
  </div>
  <div id="chat-frame-wrap">
    <iframe id="chat-frame" title="Chat with ${escapeAttr(agentName)}"
      src="/widget-ui?hotelId=${encodeURIComponent(req.hotel.id)}&standalone=1"></iframe>
  </div>
  <div id="powered-by">Powered by Ezicon</div>
</body>
</html>`);
});

// GET /qr/:hotelId — PNG QR code pointing at the branded page above
router.get('/qr/:hotelId', loadHotel, async (req, res) => {
  const primary = req.hotel.branding?.primaryColor || '#0a2e4a';
  const chatUrl = `${req.protocol}://${req.get('host')}/chat/${req.hotel.id}`;
  try {
    const buffer = await QRCode.toBuffer(chatUrl, {
      width: 512, margin: 2, color: { dark: primary, light: '#FFFFFF' },
    });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (e) {
    console.error('[qr] failed', e);
    res.status(500).json({ error: 'qr generation failed' });
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

module.exports = router;
