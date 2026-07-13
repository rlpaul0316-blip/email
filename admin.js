// admin.js
// Operator control surface. Everything here is gated to admins.
//   - edit any setting (text) live
//   - edit tier prices (USD + Stars)
//   - add / list channels you own
//   - review queue: approve -> broadcast, or reject -> refund flag
//
// Editing model: /set <key> <value>  updates any string instantly.
//                /price <tier_id> <usd> [stars]  updates a tier's price.
//                /setstars <tier_id> <stars>
//                /addchannel  (forward a post from your channel, or run while bot is admin)
//                /queue  lists pending orders with approve/reject buttons.

const { Markup } = require('telegraf');
const settings = require('./settings');
const { pool } = require('./db');
const { registerChannel, listActiveChannels, broadcastOrder } = require('./channels');

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean).map(Number);

function isAdmin(ctx) {
  return ADMIN_IDS.includes(ctx.from?.id);
}

// ---- live text editing -------------------------------------------------
async function cmdSet(ctx) {
  if (!isAdmin(ctx)) return;
  // /set key the new value goes here
  const raw = ctx.message.text.replace(/^\/set(@\w+)?\s+/, '');
  const sp = raw.indexOf(' ');
  if (sp < 0) return ctx.reply('Usage: /set <key> <value>');
  const key = raw.slice(0, sp);
  const value = raw.slice(sp + 1);
  await settings.set(key, value);
  await ctx.reply(`✅ Updated "${key}".`);
}

async function cmdListKeys(ctx) {
  if (!isAdmin(ctx)) return;
  const { rows } = await pool.query('SELECT key FROM settings ORDER BY key');
  await ctx.reply('Editable keys:\n' + rows.map(r => '• ' + r.key).join('\n'));
}

async function cmdGet(ctx) {
  if (!isAdmin(ctx)) return;
  const key = ctx.message.text.split(/\s+/)[1];
  if (!key) return ctx.reply('Usage: /get <key>');
  const val = await settings.get(key, '(unset)');
  await ctx.reply(`${key} =\n${val}`);
}

// ---- price editing -----------------------------------------------------
async function cmdPrice(ctx) {
  if (!isAdmin(ctx)) return;
  const [, id, usd, stars] = ctx.message.text.split(/\s+/);
  if (!id || !usd) return ctx.reply('Usage: /price <tier_id> <usd> [stars]');
  if (stars) {
    await pool.query('UPDATE tiers SET price_usd = $2, price_stars = $3 WHERE id = $1',
      [id, usd, stars]);
  } else {
    await pool.query('UPDATE tiers SET price_usd = $2 WHERE id = $1', [id, usd]);
  }
  await ctx.reply(`✅ Tier ${id} price updated.`);
}

async function cmdSetStars(ctx) {
  if (!isAdmin(ctx)) return;
  const [, id, stars] = ctx.message.text.split(/\s+/);
  if (!id || !stars) return ctx.reply('Usage: /setstars <tier_id> <stars>');
  await pool.query('UPDATE tiers SET price_stars = $2 WHERE id = $1', [id, stars]);
  await ctx.reply(`✅ Tier ${id} set to ${stars} ⭐.`);
}

// ---- channel management ------------------------------------------------
async function cmdAddChannel(ctx, bot) {
  if (!isAdmin(ctx)) return;
  // If the admin forwarded a post from their channel, use that chat id.
  const fwd = ctx.message?.forward_from_chat;
  let chatId = fwd?.id;
  // Or allow /addchannel <chat_id>
  if (!chatId) {
    const arg = ctx.message.text.split(/\s+/)[1];
    if (arg) chatId = Number(arg);
  }
  if (!chatId) {
    return ctx.reply('Add the bot as admin to your channel, then forward a post from it here, or use /addchannel <chat_id>.');
  }
  const res = await registerChannel(bot, chatId);
  if (!res.ok) return ctx.reply('❌ ' + res.reason);
  await ctx.reply(`✅ Channel registered: ${res.title || chatId}`);
}

async function cmdChannels(ctx) {
  if (!isAdmin(ctx)) return;
  const chans = await listActiveChannels();
  if (!chans.length) return ctx.reply('No channels registered yet.');
  await ctx.reply('Active channels:\n' + chans.map(c => `• ${c.title || c.chat_id} (${c.chat_id})`).join('\n'));
}

// ---- review queue ------------------------------------------------------
async function notifyAdmins(bot, orderId) {
  const { rows } = await pool.query(
    `SELECT o.*, t.label AS tier_label, t.reach_channels
       FROM orders o LEFT JOIN tiers t ON t.id = o.tier_id
      WHERE o.id = $1`, [orderId]);
  const o = rows[0];
  if (!o) return;

  const preview =
    `🆕 Order #${o.id}\n` +
    `Tier: ${o.tier_label || '—'} ($${o.price_usd}, ${o.payment_method})\n` +
    `Reach: ${o.reach_channels} channel(s)\n\n` +
    `Ad text:\n${o.ad_text || '(none)'}\n` +
    (o.ad_link ? `Link: ${o.ad_link}\n` : '');

  for (const adminId of ADMIN_IDS) {
    await bot.telegram.sendMessage(adminId, preview, Markup.inlineKeyboard([
      [Markup.button.callback('Approve ✅', `admin:approve:${o.id}`),
       Markup.button.callback('Reject ❌', `admin:reject:${o.id}`)],
    ])).catch(() => {});
  }
}

async function approveOrder(ctx, bot, orderId) {
  if (!isAdmin(ctx)) return;
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const order = rows[0];
  if (!order) return ctx.answerCbQuery('Order gone.');
  if (order.status !== 'pending_review') return ctx.answerCbQuery('Already handled.');

  const { rows: tierRows } = await pool.query('SELECT * FROM tiers WHERE id = $1', [order.tier_id]);
  const tier = tierRows[0];
  const allChannels = await listActiveChannels();
  const targets = allChannels.slice(0, tier?.reach_channels || 1);

  if (!targets.length) {
    return ctx.answerCbQuery('No channels registered — add one first.', { show_alert: true });
  }

  const results = await broadcastOrder(bot, order, targets);
  const ok = results.filter(r => r.ok);

  await pool.query(`UPDATE orders SET status = 'broadcast', updated_at = now() WHERE id = $1`, [orderId]);

  // Build post links for the buyer
  const links = ok.map(r => {
    const c = r.channel;
    if (c.title && String(c.chat_id).startsWith('-100')) {
      const internal = String(c.chat_id).replace('-100', '');
      return `https://t.me/c/${internal}/${r.message_id}`;
    }
    return `${c.title || c.chat_id}: posted`;
  }).join('\n');

  const buyerMsg = await settings.render('order_approved', { links });
  const { rows: urows } = await pool.query('SELECT telegram_id FROM users WHERE id = $1', [order.user_id]);
  if (urows[0]) await bot.telegram.sendMessage(urows[0].telegram_id, buyerMsg).catch(() => {});

  await ctx.editMessageText(`✅ Order #${orderId} broadcast to ${ok.length}/${targets.length} channel(s).`);
}

async function rejectOrder(ctx, bot, orderId) {
  if (!isAdmin(ctx)) return;
  await pool.query(`UPDATE orders SET status = 'rejected', updated_at = now() WHERE id = $1`, [orderId]);
  const reason = await settings.get('default_reject_reason', 'Did not meet our guidelines');
  const msg = await settings.render('order_rejected', { reason });
  const { rows } = await pool.query(
    `SELECT u.telegram_id FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1`, [orderId]);
  if (rows[0]) await bot.telegram.sendMessage(rows[0].telegram_id, msg).catch(() => {});
  await ctx.editMessageText(`❌ Order #${orderId} rejected + refund flagged.`);
}

async function cmdQueue(ctx) {
  if (!isAdmin(ctx)) return;
  const { rows } = await pool.query(
    `SELECT id, price_usd, payment_method FROM orders WHERE status = 'pending_review' ORDER BY id`);
  if (!rows.length) return ctx.reply('Queue empty.');
  for (const o of rows) {
    await ctx.reply(`Order #${o.id} — $${o.price_usd} (${o.payment_method})`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Approve ✅', `admin:approve:${o.id}`),
         Markup.button.callback('Reject ❌', `admin:reject:${o.id}`)],
      ]));
  }
}

module.exports = {
  isAdmin, ADMIN_IDS,
  cmdSet, cmdGet, cmdListKeys, cmdPrice, cmdSetStars,
  cmdAddChannel, cmdChannels,
  notifyAdmins, approveOrder, rejectOrder, cmdQueue,
};
