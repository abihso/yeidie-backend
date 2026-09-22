CREATE TABLE IF NOT EXISTS posts (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body varchar(4000) NOT NULL DEFAULT '',
  media_type text CHECK (media_type IN ('image', 'video')),
  media_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS posts_author_created
  ON posts (author_id, created_at DESC);
