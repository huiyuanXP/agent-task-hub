CREATE TABLE local_users (
 id TEXT PRIMARY KEY NOT NULL,
 username TEXT UNIQUE NOT NULL,
 display_name TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE local_tokens (
 token_hash TEXT PRIMARY KEY NOT NULL,
 owner TEXT NOT NULL REFERENCES local_users(id),
 kind TEXT NOT NULL CHECK (kind IN ('browser','api')),
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX local_tokens_owner ON local_tokens(owner);
CREATE INDEX local_tokens_expiry ON local_tokens(expires_at);
CREATE TABLE login_throttle (
 username TEXT PRIMARY KEY NOT NULL,
 failures INTEGER NOT NULL,
 window_start INTEGER NOT NULL
);
