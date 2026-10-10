CREATE TABLE workspace_projects (
 id TEXT PRIMARY KEY NOT NULL,
 owner TEXT NOT NULL REFERENCES local_users(id),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 created_at INTEGER NOT NULL,
 UNIQUE(owner,name), UNIQUE(id,owner)
);
CREATE TABLE workspace_invitations (
 code_hash TEXT PRIMARY KEY NOT NULL,
 owner TEXT NOT NULL,
 project_id TEXT NOT NULL,
 name TEXT NOT NULL,
 capabilities TEXT NOT NULL CHECK(json_valid(capabilities)),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 consumed_at INTEGER,
 connection_id TEXT,
 FOREIGN KEY(project_id,owner) REFERENCES workspace_projects(id,owner)
);
CREATE TABLE workspace_connections (
 id TEXT PRIMARY KEY NOT NULL,
 owner TEXT NOT NULL,
 project_id TEXT NOT NULL,
 name TEXT NOT NULL,
 workspace TEXT NOT NULL,
 version TEXT NOT NULL,
 capabilities TEXT NOT NULL CHECK(json_valid(capabilities)),
 token_hash TEXT UNIQUE NOT NULL,
 token_expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 last_seen INTEGER,
 mcp_last_seen INTEGER,
 agent_last_seen INTEGER,
 agent_ready INTEGER NOT NULL DEFAULT 0 CHECK(agent_ready IN (0,1)),
 agent_error TEXT,
 revoked_at INTEGER,
 FOREIGN KEY(project_id,owner) REFERENCES workspace_projects(id,owner),
 UNIQUE(id,owner)
);
CREATE INDEX workspace_connections_owner ON workspace_connections(owner,project_id);
CREATE TABLE workspace_connection_events (
 id TEXT PRIMARY KEY NOT NULL,
 connection_id TEXT NOT NULL,
 owner TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('enroll','mcp','agent','revoke')),
 message TEXT,
 created_at INTEGER NOT NULL,
 FOREIGN KEY(connection_id,owner) REFERENCES workspace_connections(id,owner)
);
CREATE INDEX workspace_connection_events_recent ON workspace_connection_events(connection_id,created_at DESC);
ALTER TABLE jobs ADD COLUMN planner_error TEXT;
ALTER TABLE jobs ADD COLUMN planner_retry_at INTEGER;
ALTER TABLE jobs ADD COLUMN connector_id TEXT;
