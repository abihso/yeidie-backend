CREATE TABLE users (
  id uuid PRIMARY KEY,
  full_name varchar(120) NOT NULL,
  email varchar(254) NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('client', 'counsellor')),
  bio varchar(2000) NOT NULL DEFAULT '',
  specialties text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE availability_slots (
  id uuid PRIMARY KEY,
  counsellor_id uuid NOT NULL REFERENCES users(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (ends_at > starts_at)
);
CREATE INDEX availability_counsellor_time ON availability_slots(counsellor_id, starts_at) WHERE deleted_at IS NULL;

CREATE TABLE bookings (
  id uuid PRIMARY KEY,
  slot_id uuid NOT NULL REFERENCES availability_slots(id),
  client_id uuid NOT NULL REFERENCES users(id),
  counsellor_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
  note varchar(2000) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (client_id <> counsellor_id)
);
CREATE UNIQUE INDEX one_active_booking_per_slot ON bookings(slot_id) WHERE status IN ('pending', 'confirmed');
CREATE INDEX bookings_client ON bookings(client_id, created_at DESC);
CREATE INDEX bookings_counsellor ON bookings(counsellor_id, created_at DESC);

CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);
CREATE INDEX follows_following ON follows(following_id);

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('direct', 'group')),
  title varchar(120),
  created_by uuid NOT NULL REFERENCES users(id),
  direct_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'direct' AND direct_key IS NOT NULL) OR (kind = 'group' AND direct_key IS NULL))
);
CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user ON conversation_members(user_id);
CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id),
  body varchar(4000) NOT NULL CHECK (length(trim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_history ON messages(conversation_id, created_at DESC, id DESC);

CREATE TABLE call_rooms (
  id uuid PRIMARY KEY,
  conversation_id uuid REFERENCES conversations(id),
  booking_id uuid REFERENCES bookings(id),
  created_by uuid NOT NULL REFERENCES users(id),
  mode text NOT NULL DEFAULT 'video' CHECK (mode IN ('audio', 'video')),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CHECK ((conversation_id IS NOT NULL AND booking_id IS NULL) OR (conversation_id IS NULL AND booking_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_conversation_call ON call_rooms(conversation_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX one_active_booking_call ON call_rooms(booking_id) WHERE ended_at IS NULL;

CREATE TABLE user_sessions (
  sid varchar NOT NULL PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX user_sessions_expire ON user_sessions(expire);
