// channels.js
// Channel registration + broadcast engine.
// A channel only becomes a valid target if the bot is actually an
// admin there and can post — this is what makes "placement" real.

const { pool } = require('./db');

// Register a channel the operator owns.
// Called when the operator forwards a post from their channel to the bot,
// OR runs /addchannel while the bot is admin there.
// We verify the bot's admin+post rights before storing it.
async function registerChannel(bot, chatId) {
  // Verify the bot is a member/admin of this chat and can post.
  let me;
  try {
    me = await bot.telegram.getChatMember(chatId, bot.botInfo.id);
  } catch (e) {
    return { ok: false, reason: 'Bot is not in that channel. Add it as admin first.' };
  }

  const canPost =
    me.status === 'creator' ||
    (me.status === 'administrator' && (me.can_post_messages || me.can_post_messages === undefined));

  if (!canPost) {
    return { ok: false, reason: 'Bot is in the channel but lacks post permission. Grant "Post Messages".' };
  }

  // Grab a title for display
  let title = null;
  try {
    const chat = await bot.telegram.getChat(chatId);
    title = chat.title || chat.username || String(chatId);
  } catch { /* non-fatal */ }

  await pool.query(
    `INSERT INTO channels (chat_id, title, is_active)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (chat_id) DO UPDATE SET title = $2, is_active = TRUE`,
    [chatId, title]
  );

  return { ok: true, title };
}

async function listActiveChannels(limit = null) {
  const q = limit
    ? 'SELECT * FROM channels WHERE is_active ORDER BY id LIMIT $1'
    : 'SELECT * FROM channels WHERE is_active ORDER BY id';
  const { rows } = await pool.query(q, limit ? [limit] : []);
  return rows;
}

// Broadcast one approved order's creative to N channels.
// Posts the advertiser's OWN ad content only.
async function broadcastOrder(bot, order, channels) {
  const results = [];
  for (const ch of channels) {
    try {
      let msg;
      const caption = [order.ad_text, order.ad_link].filter(Boolean).join('\n\n');
      if (order.ad_image_file) {
        msg = await bot.telegram.sendPhoto(ch.chat_id, order.ad_image_file, { caption });
      } else {
        msg = await bot.telegram.sendMessage(ch.chat_id, caption || order.ad_text);
      }
      await pool.query(
        `INSERT INTO placements (order_id, channel_id, message_id) VALUES ($1, $2, $3)`,
        [order.id, ch.id, msg.message_id]
      );
      results.push({ channel: ch, message_id: msg.message_id, ok: true });
    } catch (e) {
      results.push({ channel: ch, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { registerChannel, listActiveChannels, broadcastOrder };
