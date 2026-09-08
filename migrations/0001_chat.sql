CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, run_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, reply_to_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX messages_session ON messages(session_id);
CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, request_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE UNIQUE INDEX runs_request ON runs(session_id, request_id);
CREATE UNIQUE INDEX runs_one_active ON runs(session_id) WHERE status = 'running';
CREATE TABLE events (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, seq));
CREATE TABLE settings (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), data TEXT NOT NULL);
