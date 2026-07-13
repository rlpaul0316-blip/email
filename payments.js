// payments.js
// Payment layer:
//   - Telegram Stars: native inline invoice (XTR currency), auto-confirmed on success
//   - BTC / SOL: show address, buyer taps "I've paid", order flagged for MANUAL review
//
// On successful payment the order moves to 'pending_review' and the operator
// is notified to approve -> broadcast.

const { Markup } = require('telegraf');
const settings = require('./settings');
const { pool } = require('./db');

async function getOrder(orderId) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  return rows[0];
}

async function getTier(tierId) {
  const { rows } = await pool.query('SELECT * FROM tiers WHERE id = $1', [tierId]);
  return rows[0];
}

// ---- Telegram Stars ----------------------------------------------------
async function sendStarsInvoice(ctx, orderId) {
  const order = await getOrder(orderId);
  if (!order) return ctx.answerCbQuery('Order not found.');
  const tier = await getTier(order.tier_id);
  const stars = tier?.price_stars || 250;

  // Stars invoices use currency 'XTR'; amount is the star count, provider_token empty.
  await ctx.replyWithInvoice({
    title: 'Ad Placement',
    description: tier?.label ? `Placement: ${tier.label}` : 'Ad placement',
    payload: `order_${orderId}`,
    provider_token: '',            // empty for Stars
    currency: 'XTR',
    prices: [{ label: 'Placement', amount: stars }],
  });
}

// Telegram requires answering the pre-checkout within 10s
async function onPreCheckout(ctx) {
  await ctx.answerPreCheckoutQuery(true);
}

// Fired when Stars payment completes
async function onSuccessfulPayment(ctx, notifyAdmins) {
  const payload = ctx.message?.successful_payment?.invoice_payload || '';
  const m = payload.match(/^order_(\d+)$/);
  if (!m) return;
  const orderId = Number(m[1]);

  await pool.query(
    `UPDATE orders SET status = 'pending_review', payment_method = 'stars',
        payment_ref = $2, updated_at = now()
     WHERE id = $1`,
    [orderId, ctx.message.successful_payment.telegram_payment_charge_id]
  );

  const note = await settings.render('order_received');
  await ctx.reply(note);
  await notifyAdmins(orderId);
}

// ---- Manual BTC / SOL --------------------------------------------------
async function sendCryptoInstructions(ctx, method, orderId) {
  const order = await getOrder(orderId);
  if (!order) return ctx.answerCbQuery('Order not found.');

  const addrKey = method === 'btc' ? 'btc_address' : 'sol_address';
  const address = await settings.get(addrKey);
  const key = method === 'btc' ? 'payment_btc_instructions' : 'payment_sol_instructions';
  const text = await settings.render(key, {
    price: order.price_usd,
    btc_address: address,
    sol_address: address,
  });

  await ctx.reply(text, Markup.inlineKeyboard([
    [Markup.button.callback("I've paid ✅", `paid:${method}:${orderId}`)],
  ]));
}

// Buyer claims they've paid -> flag for manual operator review
async function claimPaid(ctx, method, orderId, notifyAdmins) {
  await pool.query(
    `UPDATE orders SET status = 'pending_review', payment_method = $2, updated_at = now()
     WHERE id = $1 AND status = 'awaiting_payment'`,
    [orderId, method]
  );
  const note = await settings.render('payment_pending_note');
  await ctx.editMessageText(note).catch(() => ctx.reply(note));
  await notifyAdmins(orderId);
}

module.exports = {
  sendStarsInvoice, onPreCheckout, onSuccessfulPayment,
  sendCryptoInstructions, claimPaid,
};
