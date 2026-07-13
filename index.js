'use strict';

/**
 * Ad Placement Bot (single file)
 * ------------------------------
 * Buyers pay to have THEIR OWN ad broadcast into channels YOU own.
 * - Fully editable user-facing text (DB-stored, live-editable via /settext)
 * - Tracks + tiers with editable prices (USD shown, Stars charged)
 * - Payments: BTC + SOL (manual confirm), Telegram Stars (auto)
 * - Admin review queue: Approve -> broadcast to your channels; Reject -> refund flag
 *
 * Deploy on Render as a Web Service. Env vars:
 *   BOT_TOKEN     - from @BotFather
 *   DATABASE_URL  - Render Postgres URL
 *   ADMIN_ID      - your numeric Telegram id (from @userinfobot)
 *   PORT          - provided by Render
 *
 * Tables auto-create and defaults auto-seed on first boot. No SQL files.
 */

const http = require('http');
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN env var');
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL env var');
if (!ADMIN_ID) throw new Error('Missing ADMIN_ID env var');

const bot = new Telegraf(BOT_TOKEN);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const isAdmin = (ctx) => ctx.from && ctx.from.id === ADMIN_ID;
const state = new Map();
const textCache = new Map();
const settingCache = new Map();

// ---------------------------------------------------------------------------
// Editable text. {curly} placeholders filled at send time.
// ---------------------------------------------------------------------------
const DEFAULT_TEXTS = {
  welcome:
    "👋 Welcome!\n\nWe place your ad in front of our audience. Pick a package to get started.",
  btn_track_1: "📢 Single Blast",
  btn_track_2: "🔁 Package",
  btn_help: "ℹ️ Help",
  choose_tier: "Choose a package:",
  ask_ad_text: "✍️ Send the text of your ad (what you want us to post).",
  ask_ad_link: "🔗 Optionally send a link/CTA, or tap Skip.",
  btn_skip: "Skip",
  payment_intro: "Your placement is ${price}. Choose how to pay:",
  btn_pay_stars: "⭐ Pay with Stars",
  btn_pay_btc: "🟠 Pay with BTC",
  btn_pay_sol: "🟣 Pay with SOL",
  buy_btc_msg:
    "🟠 BTC — {label}\n\nSend the BTC equivalent of ${price} to:\n{btc_address}\n\nRef: {code}\nThen tap 'I've paid'. Credits/placement go live after manual confirmation.",
  buy_sol_msg:
    "🟣 SOL — {label}\n\nSend the SOL equivalent of ${price} to:\n{sol_address}\n\nRef: {code}\nThen tap 'I've paid'. Credits/placement go live after manual confirmation.",
  btn_ipaid: "✅ I've paid",
  order_received: "✅ Payment noted. Your ad is in review — you'll get post links once it's live.",
  order_approved: "🚀 Your ad is live!\n{links}",
  order_rejected: "❌ Your ad wasn't approved. Reason: {reason}. A refund has been flagged.",
  pending_note: "Thanks — we'll confirm your payment shortly.",
  help_msg:
    "Pay to have your ad posted to our channels.\n\n• Pick a package\n• Send your ad copy\n• Pay with BTC, SOL, or Stars\n• We review and post it, then send you the links.",
};

const DEFAULT_SETTINGS = {
  btc_address: 'bc1qtywy82n2hwrdvwstx0unf8p35draw7xhsljzgn',
  sol_address: 'FzjU9RVrN7zwNc2q7itWw3XAMVC35e17zxpp4nFhB6cV',
  // tiers: track, label, price_usd, price_stars, reach (how many channels)
  tiers: JSON.stringify([
    { track: 'single', label: '1 Channel', price: 5, stars: 250, reach: 1 },
    { track: 'single', label: '3 Channels', price: 5, stars: 250, reach: 3 },
    { track: 'package', label: 'All Channels', price: 5, stars: 250, reach: 99 },
  ]),
};

// ---------------------------------------------------------------------------
// DB init — everything auto-creates on boot
// ---------------------------------------------------------------------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username    TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      chat_id   BIGINT PRIMARY KEY,
      title     TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      added_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id          SERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL,
      tier_label  TEXT,
      reach       INTEGER NOT NULL DEFAULT 1,
      ad_text     TEXT,
      ad_link     TEXT,
      price       NUMERIC(10,2) NOT NULL DEFAULT 0,
      method      TEXT,
      status      TEXT NOT NULL DEFAULT 'draft',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_texts (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

  for (const [k, v] of Object.entries(DEFAULT_TEXTS))
    await pool.query('INSERT INTO bot_texts(key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [k, v]);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS))
    await pool.query('INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [k, v]);

  await refreshCaches();
  console.log('DB initialized and caches loaded.');
}

async function refreshCaches() {
  const t = await pool.query('SELECT key, value FROM bot_texts');
  textCache.clear();
  for (const r of t.rows) textCache.set(r.key, r.value);
  const s = await pool.query('SELECT key, value FROM settings');
  settingCache.clear();
  for (const r of s.rows) settingCache.set(r.key, r.value);
}

function t(key, params = {}) {
  let str = textCache.get(key);
  if (str === undefined) str = DEFAULT_TEXTS[key] || `[${key}]`;
  for (const [k, v] of Object.entries(params)) str = str.split(`{${k}}`).join(String(v));
  return str.split('\\n').join('\n');
}
function setting(key) {
  return settingCache.get(key) ?? DEFAULT_SETTINGS[key] ?? '';
}
function getTiers() {
  try { return JSON.parse(setting('tiers')); }
  catch { return JSON.parse(DEFAULT_SETTINGS.tiers); }
}
function shortCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

async function ensureUser(ctx) {
  await pool.query(
    `INSERT INTO users(telegram_id, username) VALUES ($1,$2)
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username`,
    [ctx.from.id, ctx.from.username || null]
  );
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t('btn_track_1'), 'track:single')],
    [Markup.button.callback(t('btn_track_2'), 'track:package')],
    [Markup.button.callback(t('btn_help'), 'help')],
  ]);
}

// ---------------------------------------------------------------------------
// Buyer flow
// ---------------------------------------------------------------------------
bot.start(async (ctx) => {
  await ensureUser(ctx);
  state.delete(ctx.from.id);
  await ctx.reply(t('welcome'), mainMenu());
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(t('help_msg'), mainMenu());
});

bot.action(/^track:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const track = ctx.match[1];
  const tiers = getTiers().map((tier, i) => ({ ...tier, i })).filter((tier) => tier.track === track);
  if (!tiers.length) return ctx.reply('No packages available right now.');
  const rows = tiers.map((tier) => [
    Markup.button.callback(`${tier.label} — $${tier.price}`, `tier:${tier.i}`),
  ]);
  await ctx.reply(t('choose_tier'), Markup.inlineKeyboard(rows));
});

bot.action(/^tier:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const tier = getTiers()[Number(ctx.match[1])];
  if (!tier) return ctx.reply('That package is no longer available.');
  state.set(ctx.from.id, { mode: 'await_ad_text', tier });
  await ctx.reply(t('ask_ad_text'));
});

bot.action('creative:skiplink', async (ctx) => {
  await ctx.answerCbQuery();
  const st = state.get(ctx.from.id);
  if (st && st.mode === 'await_ad_link') { st.adLink = null; await finalizeToPayment(ctx, st); }
});

async function finalizeToPayment(ctx, st) {
  await ensureUser(ctx);
  const ins = await pool.query(
    `INSERT INTO orders(user_id, tier_label, reach, ad_text, ad_link, price, status)
     VALUES ($1,$2,$3,$4,$5,$6,'awaiting_payment') RETURNING id`,
    [ctx.from.id, st.tier.label, st.tier.reach, st.adText || null, st.adLink || null, st.tier.price]
  );
  st.orderId = ins.rows[0].id;
  st.mode = 'await_payment';
  state.set(ctx.from.id, st);
  await ctx.reply(
    t('payment_intro', { price: st.tier.price }),
    Markup.inlineKeyboard([
      [Markup.button.callback(t('btn_pay_stars'), `pay:stars:${st.orderId}`)],
      [Markup.button.callback(t('btn_pay_btc'), `pay:btc:${st.orderId}`)],
      [Markup.button.callback(t('btn_pay_sol'), `pay:sol:${st.orderId}`)],
    ])
  );
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
async function getOrder(id) {
  const r = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  return r.rows[0] || null;
}

bot.action(/^pay:stars:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const order = await getOrder(Number(ctx.match[1]));
  if (!order) return ctx.reply('Order not found.');
  const tier = getTiers().find((x) => x.label === order.tier_label);
  const stars = tier ? tier.stars : 250;
  await ctx.replyWithInvoice({
    title: 'Ad Placement',
    description: order.tier_label || 'Ad placement',
    payload: `order:${order.id}`,
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: order.tier_label || 'Placement', amount: stars }],
  });
});

bot.on('pre_checkout_query', async (ctx) => {
  try { await ctx.answerPreCheckoutQuery(true); }
  catch { await ctx.answerPreCheckoutQuery(false, 'Something went wrong.'); }
});

bot.on('successful_payment', async (ctx) => {
  const payload = ctx.message.successful_payment.invoice_payload || '';
  const m = payload.match(/^order:(\d+)$/);
  if (!m) return;
  const orderId = Number(m[1]);
  await pool.query("UPDATE orders SET status='pending_review', method='stars' WHERE id=$1", [orderId]);
  await ctx.reply(t('order_received'));
  await notifyAdmin(orderId);
});

bot.action(/^pay:(btc|sol):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const method = ctx.match[1];
  const order = await getOrder(Number(ctx.match[2]));
  if (!order) return ctx.reply('Order not found.');
  const code = shortCode();
  const key = method === 'btc' ? 'buy_btc_msg' : 'buy_sol_msg';
  await ctx.reply(
    t(key, {
      label: order.tier_label,
      price: order.price,
      btc_address: setting('btc_address'),
      sol_address: setting('sol_address'),
      code,
    }),
    Markup.inlineKeyboard([[Markup.button.callback(t('btn_ipaid'), `ipaid:${method}:${order.id}`)]])
  );
});

bot.action(/^ipaid:(btc|sol):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const method = ctx.match[1];
  const orderId = Number(ctx.match[2]);
  await pool.query(
    "UPDATE orders SET status='pending_review', method=$2 WHERE id=$1 AND status='awaiting_payment'",
    [orderId, method]
  );
  await ctx.reply(t('pending_note'));
  await notifyAdmin(orderId);
});

// ---------------------------------------------------------------------------
// Admin: review queue + broadcast + channel management + editing
// ---------------------------------------------------------------------------
async function notifyAdmin(orderId) {
  const o = await getOrder(orderId);
  if (!o) return;
  const preview =
    `🆕 Order #${o.id}\n` +
    `Tier: ${o.tier_label} ($${o.price}, ${o.method})\n` +
    `Reach: ${o.reach} channel(s)\n\n` +
    `Ad text:\n${o.ad_text || '(none)'}\n` +
    (o.ad_link ? `Link: ${o.ad_link}` : '');
  await bot.telegram
    .sendMessage(ADMIN_ID, preview, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Approve', `approve:${o.id}`),
       Markup.button.callback('❌ Reject', `reject:${o.id}`)],
    ]))
    .catch(() => {});
}

async function activeChannels() {
  const r = await pool.query('SELECT * FROM channels WHERE is_active ORDER BY added_at');
  return r.rows;
}

bot.action(/^approve:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const orderId = Number(ctx.match[1]);
  const order = await getOrder(orderId);
  if (!order || order.status !== 'pending_review')
    return ctx.reply('Already handled or not found.');

  const targets = (await activeChannels()).slice(0, order.reach);
  if (!targets.length)
    return ctx.reply('No channels registered. Add the bot as admin to a channel you own, then forward a post from it here.');

  const posted = [];
  for (const ch of targets) {
    try {
      const caption = [order.ad_text, order.ad_link].filter(Boolean).join('\n\n');
      const msg = await bot.telegram.sendMessage(ch.chat_id, caption || order.ad_text);
      posted.push({ ch, message_id: msg.message_id });
    } catch (e) {
      // skip channels the bot can't post to
    }
  }
  await pool.query("UPDATE orders SET status='broadcast' WHERE id=$1", [orderId]);

  const links = posted.map((p) => {
    const internal = String(p.ch.chat_id).replace('-100', '');
    return `https://t.me/c/${internal}/${p.message_id}`;
  }).join('\n') || '(posted)';

  await bot.telegram.sendMessage(order.user_id, t('order_approved', { links })).catch(() => {});
  await ctx.reply(`✅ Order #${orderId} posted to ${posted.length}/${targets.length} channel(s).`);
});

bot.action(/^reject:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const orderId = Number(ctx.match[1]);
  const order = await getOrder(orderId);
  if (!order) return ctx.reply('Not found.');
  await pool.query("UPDATE orders SET status='rejected' WHERE id=$1", [orderId]);
  await bot.telegram
    .sendMessage(order.user_id, t('order_rejected', { reason: 'did not meet guidelines' }))
    .catch(() => {});
  await ctx.reply(`❌ Order #${orderId} rejected + refund flagged.`);
});

// Register a channel: admin forwards a post from a channel they own, or /addchannel <id>
async function registerChannel(ctx, chatId) {
  let member;
  try { member = await bot.telegram.getChatMember(chatId, bot.botInfo.id); }
  catch { return ctx.reply('Bot is not in that channel. Add it as admin first.'); }
  const canPost = member.status === 'creator' ||
    (member.status === 'administrator' && member.can_post_messages !== false);
  if (!canPost) return ctx.reply('Bot is in the channel but lacks Post Messages permission.');
  let title = String(chatId);
  try { const chat = await bot.telegram.getChat(chatId); title = chat.title || title; } catch {}
  await pool.query(
    `INSERT INTO channels(chat_id, title, is_active) VALUES ($1,$2,TRUE)
     ON CONFLICT (chat_id) DO UPDATE SET title=EXCLUDED.title, is_active=TRUE`,
    [chatId, title]
  );
  await ctx.reply(`✅ Channel registered: ${title}`);
}

bot.command('addchannel', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = ctx.message.text.split(/\s+/)[1];
  if (!arg) return ctx.reply('Add the bot as admin to your channel, then forward a post from it here, or use /addchannel <chat_id>.');
  await registerChannel(ctx, Number(arg));
});

bot.command('channels', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const chans = await activeChannels();
  if (!chans.length) return ctx.reply('No channels registered.');
  await ctx.reply(chans.map((c) => `• ${c.title} (${c.chat_id})`).join('\n'));
});

bot.command('queue', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const r = await pool.query("SELECT id, price, method FROM orders WHERE status='pending_review' ORDER BY id");
  if (!r.rows.length) return ctx.reply('Queue empty.');
  for (const o of r.rows) {
    await ctx.reply(`Order #${o.id} — $${o.price} (${o.method})`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Approve', `approve:${o.id}`),
         Markup.button.callback('❌ Reject', `reject:${o.id}`)],
      ]));
  }
});

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply(
    'Admin:\n\n' +
    '/addchannel <chat_id> — or forward a post from your channel\n' +
    '/channels — list channels\n' +
    '/queue — pending orders\n' +
    '/setaddr btc|sol <address>\n' +
    '/settiers <json>\n' +
    '/settext <key> <value...>\n' +
    '/gettext <key>\n' +
    '/listtexts'
  );
});

bot.command('setaddr', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [, kind, addr] = ctx.message.text.trim().split(/\s+/);
  if (!['btc', 'sol'].includes(kind) || !addr) return ctx.reply('Usage: /setaddr btc|sol <address>');
  const key = kind === 'btc' ? 'btc_address' : 'sol_address';
  await pool.query('INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, addr]);
  await refreshCaches();
  await ctx.reply(`✅ ${kind.toUpperCase()} address updated.`);
});

bot.command('settiers', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const json = ctx.message.text.replace(/^\/settiers\s+/, '').trim();
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error('not array');
    await pool.query('INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', ['tiers', JSON.stringify(parsed)]);
    await refreshCaches();
    await ctx.reply(`✅ Tiers updated (${parsed.length}).`);
  } catch {
    await ctx.reply('Invalid JSON. Example:\n' + DEFAULT_SETTINGS.tiers);
  }
});

bot.command('settext', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const raw = ctx.message.text.replace(/^\/settext\s+/, '');
  const i = raw.indexOf(' ');
  if (i === -1) return ctx.reply('Usage: /settext <key> <value...>');
  const key = raw.slice(0, i).trim();
  const value = raw.slice(i + 1);
  await pool.query('INSERT INTO bot_texts(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
  await refreshCaches();
  await ctx.reply(`✅ Updated text "${key}".`);
});

bot.command('gettext', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const key = ctx.message.text.replace(/^\/gettext\s+/, '').trim();
  if (!key) return ctx.reply('Usage: /gettext <key>');
  await ctx.reply(`"${key}":\n\n${t(key)}`);
});

bot.command('listtexts', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply('Editable keys:\n\n' + Object.keys(DEFAULT_TEXTS).join('\n') + '\n\nEdit with /settext <key> <value>');
});

// ---------------------------------------------------------------------------
// Text + forward handler (after commands)
// ---------------------------------------------------------------------------
bot.on('message', async (ctx, next) => {
  // Admin forwards a post from a channel they own -> register it
  if (ctx.message?.forward_from_chat && isAdmin(ctx)) {
    return registerChannel(ctx, ctx.message.forward_from_chat.id);
  }
  const text = ctx.message?.text;
  if (!text || text.startsWith('/')) return next();

  const st = state.get(ctx.from.id);
  if (!st) { await ensureUser(ctx); return ctx.reply('Use the menu below:', mainMenu()); }

  if (st.mode === 'await_ad_text') {
    st.adText = text;
    st.mode = 'await_ad_link';
    state.set(ctx.from.id, st);
    return ctx.reply(t('ask_ad_link'),
      Markup.inlineKeyboard([[Markup.button.callback(t('btn_skip'), 'creative:skiplink')]]));
  }
  if (st.mode === 'await_ad_link') {
    st.adLink = text;
    return finalizeToPayment(ctx, st);
  }
  return next();
});

// ---------------------------------------------------------------------------
// Boot (webhook on Render, polling locally) — mirrors the commission bot
// ---------------------------------------------------------------------------
async function main() {
  await initDb();
  const domain = process.env.RENDER_EXTERNAL_URL;

  if (domain) {
    const secretPath = '/tg/' + crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32);
    bot.botInfo = await bot.telegram.getMe();
    console.log(`Authenticated as @${bot.botInfo.username}`);
    const webhookHandler = bot.webhookCallback(secretPath);
    http.createServer((req, res) => {
      const path = (req.url || '').split('?')[0];
      if (path === secretPath) return webhookHandler(req, res);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Bot is running.');
    }).listen(PORT, () => console.log(`Webhook server on ${PORT}`));
    await bot.telegram.setWebhook(`${domain}${secretPath}`, { drop_pending_updates: true });
    console.log(`Bot launched (webhook) → ${domain}${secretPath}`);
  } else {
    http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Bot is running.');
    }).listen(PORT, () => console.log(`HTTP keepalive on ${PORT}`));
    await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    await bot.launch({ dropPendingUpdates: true });
    console.log('Bot launched (polling).');
  }
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
