-- Social-proof posts (the "đã có người đổi thưởng rồi" feed). Curated by the super admin: an image
-- (hosted on WordPress via the media API), a title and a description. The CTV app renders the
-- published rows newest-first as encouragement. Image bytes never live in D1 — only the WP URL.
CREATE TABLE posts (
  id          TEXT PRIMARY KEY,                    -- UUID
  title       TEXT NOT NULL,                        -- tiêu đề
  description TEXT NOT NULL,                         -- mô tả (colleague's spec called this "subscription")
  image_url   TEXT NOT NULL,                         -- WordPress source_url of the uploaded media
  wp_media_id INTEGER,                               -- WP attachment id (for later re-attach / cleanup)
  published   INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0, 1)), -- 0 = hidden from the public feed
  created_by  TEXT NOT NULL REFERENCES users(id),    -- the admin who posted it
  created_at  TEXT NOT NULL                          -- ISO 8601 UTC
);

-- Feed query: published rows, newest first, (created_at DESC, id DESC) with id as a stable tiebreak.
CREATE INDEX idx_posts_published_created ON posts(published, created_at, id);
