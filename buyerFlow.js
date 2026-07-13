// buyerFlow.js
// Buyer journey: /start -> pick track -> pick tier -> submit OWN ad creative -> pay.
// All user-facing strings come from settings (editable live).

const { Markup } = require('telegraf');
const settings = require('./settings');
const { pool } = require('./db');

// in-memory per-user draft state (keyed by telegram id)
const drafts = new Map();

async function ensureUser(ctx) {
  const tg = ctx.from;
  const { rows } = await pool.query(
    `INSERT INTO users (telegram_id, username)
     VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET username = $2
     RETURNING *`,
    [tg.id, tg.username || null]
  );
  return rows[0];
}

async function sendWelcome(ctx) {
  await ensureUser(ctx);
  const text = await settings.render('welcome_message');
  const t1 = await settings.get('btn_track_1_label', 'Single Blast 📢');
  const t2 = await settings.get('btn_track_2_label', 'Package 🔁');
  await ctx.reply(text, Markup.inlineKeyboard([
    [Markup.button.callback(t1, 'track:single')],
    [Markup.button.callback(t2, 'track:package')],
  ]));
}

async function showTiers(ctx, track) {
  const { rows: tiers } = await pool.query(
    `SELECT * FROM tiers WHERE track = $1 AND is_active ORDER BY sort_order`,
    [track]
  );
  if (!tiers.length) {
    return ctx.reply('No packages available right now. Check back soon.');
  }
  const prompt = await settings.render('choose_tier_prompt');
  const buttons = tiers.map(t => ([
    Markup.button.callback(`${t.label} — $${t.price_usd}`, `tier:${t.id}`)
  ]));
  await ctx.reply(prompt, Markup.inlineKeyboard(buttons));
}

async function startCreative(ctx, tierId) {
  const { rows } = await pool.query('SELECT * FROM tiers WHERE id = $1', [tierId]);
  const tier = rows[0];
  if (!tier) return ctx.reply('That package is no longer available.');

  drafts.set(ctx.from.id, { tierId: tier.id, price: tier.price_usd, step: 'await_text' });
  const ask = await settings.render('ask_creative_text');
  await ctx.reply(ask);
}

// Handles free-text messages while a draft is mid-creation
async function handleDraftMessage(ctx) {
  const d = drafts.get(ctx.from.id);
  if (!d) return false; // not in a flow; let other handlers run

  if (d.step === 'await_text') {
    d.adText = ctx.message.text;
    d.step = 'await_link';
    const ask = await settings.render('ask_creative_link');
    await ctx.reply(ask, Markup.inlineKeyboard([[Markup.button.callback('Skip', 'creative:skiplink')]]));
    return true;
  }

  if (d.step === 'await_link') {
    d.adLink = ctx.message.text;
    return finalizeToPayment(ctx, d);
  }
  return false;
}

async function finalizeToPayment(ctx, d) {
  // create the order row in awaiting_payment
  const user = await ensureUser(ctx);
  const { rows } = await pool.query(
    `INSERT INTO orders (user_id, tier_id, ad_text, ad_link, price_usd, status)
     VALUES ($1, $2, $3, $4, $5, 'awaiting_payment')
     RETURNING *`,
    [user.id, d.tierId, d.adText || null, d.adLink || null, d.price]
  );
  d.orderId = rows[0].id;
  drafts.set(ctx.from.id, d);

  const intro = await settings.render('payment_intro', { price: d.price });
  await ctx.reply(intro, Markup.inlineKeyboard([
    [Markup.button.callback('Pay with Stars ⭐', `pay:stars:${d.orderId}`)],
    [Markup.button.callback('Pay with BTC ₿', `pay:btc:${d.orderId}`)],
    [Markup.button.callback('Pay with SOL ◎', `pay:sol:${d.orderId}`)],
  ]));
  return true;
}

module.exports = {
  drafts, ensureUser, sendWelcome, showTiers, startCreative,
  handleDraftMessage, finalizeToPayment,
};
