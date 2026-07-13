INSERT INTO settings (key, value) VALUES
  ('welcome_message',
   'Welcome to our agency 👋'||E'\n\n'||
   'We place your ad in front of a large, active Telegram audience. Pick a package below to get started.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('btn_track_1_label', 'Single Blast 📢'),
  ('btn_track_2_label', 'Package 🔁'),
  ('choose_tier_prompt', 'Choose a package:'),
  ('ask_creative_text', 'Send the text of your ad (what you want us to post).'),
  ('ask_creative_image', 'Optionally send an image for your ad, or tap Skip.'),
  ('ask_creative_link', 'Optionally send a link/CTA for your ad, or tap Skip.'),
  ('payment_intro', 'Your placement is ${price}. Choose how to pay:'),
  ('payment_btc_instructions',
   'Send exactly the BTC equivalent of ${price} to:'||E'\n'||'{btc_address}'||E'\n\n'||'Then tap “I''ve paid”.'),
  ('payment_sol_instructions',
   'Send exactly the SOL equivalent of ${price} to:'||E'\n'||'{sol_address}'||E'\n\n'||'Then tap “I''ve paid”.'),
  ('payment_pending_note', 'Thanks — we''ll confirm your payment shortly.'),
  ('order_received', 'Payment noted ✅ Your ad is in review. You''ll get post links once it goes live.'),
  ('order_approved', 'Your ad is live 🚀 Links:'||E'\n'||'{links}'),
  ('order_rejected', 'Your ad wasn''t approved. Reason: {reason}. A refund has been flagged.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('sol_address', 'FzjU9RVrN7zwNc2q7itWw3XAMVC35e17zxpp4nFhB6cV'),
  ('btc_address', 'bc1qtywy82n2hwrdvwstx0unf8p35draw7xhsljzgn'),
  ('ton_address', 'UQDcv-pWarLdtCjb_-CP3c3lzp_M2l05aYaKVqd5aMeVGNeY')
ON CONFLICT (key) DO NOTHING;

INSERT INTO tiers (track, label, description, price_usd, reach_channels, post_count, pin_hours, sort_order)
VALUES
  ('single', '1 Channel',  'One post in one channel',  5.00, 1, 1, 0, 1),
  ('single', '3 Channels', 'One post across three',    5.00, 3, 1, 0, 2),
  ('package', 'All + Pin',  'All channels, pinned 24h', 5.00, 99, 1, 24, 1)
ON CONFLICT DO NOTHING;
