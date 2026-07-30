-- CTV guide posts ("Hướng dẫn CTV"). Same shape as the social-proof `posts` table — curated by the
-- super admin, image hosted on WordPress via the media API, rendered as a list in the CTV app.
CREATE TABLE guides (
  id          TEXT PRIMARY KEY,                    -- UUID
  title       TEXT NOT NULL,                        -- tiêu đề
  description TEXT NOT NULL,                        -- mô tả / nội dung
  image_url   TEXT NOT NULL,                        -- WordPress source_url of the uploaded media
  wp_media_id INTEGER,                               -- WP attachment id (for later re-attach / cleanup)
  published   INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0, 1)), -- 0 = hidden from the public feed
  created_by  TEXT NOT NULL REFERENCES users(id),    -- the admin who posted it
  created_at  TEXT NOT NULL                          -- ISO 8601 UTC
);

-- Feed query: published rows, newest first, (created_at DESC, id DESC) with id as a stable tiebreak.
CREATE INDEX idx_guides_published_created ON guides(published, created_at, id);
