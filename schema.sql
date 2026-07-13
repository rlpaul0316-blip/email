CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    telegram_id     BIGINT UNIQUE NOT NULL,
    username        TEXT,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_admin        BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS settings (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
    id              BIGSERIAL PRIMARY KEY,
    chat_id         BIGINT UNIQUE NOT NULL,
    title           TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tiers (
    id              BIGSERIAL PRIMARY KEY,
    track           TEXT NOT NULL,
    label           TEXT NOT NULL,
    description     TEXT,
    price_usd       NUMERIC(10,2) NOT NULL,
    reach_channels  INTEGER NOT NULL DEFAULT 1,
    post_count      INTEGER NOT NULL DEFAULT 1,
    pin_hours       INTEGER NOT NULL DEFAULT 0,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS orders (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id),
    tier_id         BIGINT REFERENCES tiers(id),
    ad_text         TEXT,
    ad_image_file   TEXT,
    ad_link         TEXT,
    price_usd       NUMERIC(10,2) NOT NULL,
    payment_method  TEXT,
    payment_ref     TEXT,
    status          TEXT NOT NULL DEFAULT 'draft',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS placements (
    id              BIGSERIAL PRIMARY KEY,
    order_id        BIGINT NOT NULL REFERENCES orders(id),
    channel_id      BIGINT NOT NULL REFERENCES channels(id),
    message_id      BIGINT,
    posted_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(user_id);
