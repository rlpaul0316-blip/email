ALTER TABLE tiers ADD COLUMN IF NOT EXISTS price_stars INTEGER NOT NULL DEFAULT 250;
UPDATE tiers SET price_stars = 250 WHERE price_stars IS NULL OR price_stars = 0;
