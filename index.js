// index.js
// Ad-placement bot entry point.
// Stack: Node.js + Telegraf + PostgreSQL, deployable on Render.

const { Telegraf } = require('telegraf');
const settings = require('./settings');
const buyer = require('./buyerFlow');
const pay = require('./payments');
const admin = require('./admin');

const bot = new Telegraf(process.env.BOT_TOKEN);

// notify wrapper so payment layer can reach admins
const notify = (orderId) => admin.notifyAdmins(bot, orderId);

// ---- buyer commands ----
bot.start(async (ctx) => buyer.sendWelcome(ctx));

bot.action(/^track:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await buyer.showTiers(ctx, ctx.match[1]);
});

bot.action(/^tier:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await buyer.startCreative(ctx, Number(ctx.match[1]));
});

bot.action('creative:skiplink', async (ctx) => {
  await ctx.answerCbQuery();
  const d = buyer.drafts.get(ctx.from.id);
  if (d) { d.adLink = null; await buyer.finalizeToPayment(ctx, d); }
});

// ---- payment actions ----
bot.action(/^pay:stars:(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); await pay.sendStarsInvoice(ctx, Number(ctx.match[1])); });
bot.action(/^pay:btc:(\d+)$/,   async (ctx) => { await ctx.answerCbQuery(); await pay.sendCryptoInstructions(ctx, 'btc', Number(ctx.match[1])); });
bot.action(/^pay:sol:(\d+)$/,   async (ctx) => { await ctx.answerCbQuery(); await pay.sendCryptoInstructions(ctx, 'sol', Number(ctx.match[1])); });
bot.action(/^paid:(\w+):(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); await pay.claimPaid(ctx, ctx.match[1], Number(ctx.match[2]), notify); });

bot.on('pre_checkout_query', (ctx) => pay.onPreCheckout(ctx));
bot.on('successful_payment', (ctx) => pay.onSuccessfulPayment(ctx, notify));

// ---- admin commands ----
bot.command('set',        admin.cmdSet);
bot.command('get',        admin.cmdGet);
bot.command('keys',       admin.cmdListKeys);
bot.command('price',      admin.cmdPrice);
bot.command('setstars',   admin.cmdSetStars);
bot.command('addchannel', (ctx) => admin.cmdAddChannel(ctx, bot));
bot.command('channels',   admin.cmdChannels);
bot.command('queue',      admin.cmdQueue);

bot.action(/^admin:approve:(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); await admin.approveOrder(ctx, bot, Number(ctx.match[1])); });
bot.action(/^admin:reject:(\d+)$/,  async (ctx) => { await ctx.answerCbQuery(); await admin.rejectOrder(ctx, bot, Number(ctx.match[1])); });

// ---- free-text router (drafts in progress; forwarded channel posts) ----
bot.on('message', async (ctx, next) => {
  // channel registration via forwarded post
  if (ctx.message?.forward_from_chat && admin.isAdmin(ctx)) {
    return admin.cmdAddChannel(ctx, bot);
  }
  // buyer creative capture
  if (ctx.message?.text && !ctx.message.text.startsWith('/')) {
    const handled = await buyer.handleDraftMessage(ctx);
    if (handled) return;
  }
  return next();
});

// ---- boot ----
(async () => {
  await settings.loadAll();
  await bot.telegram.getMe().then(me => { bot.botInfo = me; });
  await bot.launch();
  console.log('Ad-placement bot running.');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
