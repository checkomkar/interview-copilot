import { DatabaseSync } from 'node:sqlite'

/**
 * Schema migrations, applied in order; PRAGMA user_version records how many ran (FR-D1/D2).
 * Append new steps, never edit shipped ones.
 */
export const MIGRATIONS: string[] = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     started_at INTEGER NOT NULL,
     ended_at INTEGER,
     cost_usd REAL NOT NULL DEFAULT 0,
     stt_seconds REAL NOT NULL DEFAULT 0
   );
   CREATE TABLE utterances (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     source TEXT NOT NULL,
     text TEXT NOT NULL,
     ts INTEGER NOT NULL
   );
   CREATE INDEX utterances_session ON utterances(session_id, ts);
   CREATE TABLE qa_pairs (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     question TEXT NOT NULL,
     type TEXT NOT NULL,
     answer TEXT NOT NULL,
     status TEXT NOT NULL,
     error TEXT,
     served_by TEXT,
     ts INTEGER NOT NULL,
     had_screenshot INTEGER NOT NULL DEFAULT 0,
     screenshot_path TEXT
   );
   CREATE INDEX qa_pairs_session ON qa_pairs(session_id, ts);
   CREATE TABLE usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     ts INTEGER NOT NULL,
     purpose TEXT,
     service TEXT,
     model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL,
     cache_read_tokens INTEGER NOT NULL,
     cache_write_tokens INTEGER NOT NULL,
     cost_usd REAL NOT NULL
   );
   CREATE INDEX usage_session ON usage(session_id);`,
  // Several screenshots per Q&A (scrolled questions): JSON array of file paths, and a count.
  `ALTER TABLE qa_pairs ADD COLUMN screenshot_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE qa_pairs ADD COLUMN screenshot_paths TEXT;
   UPDATE qa_pairs SET screenshot_count = had_screenshot,
     screenshot_paths = CASE WHEN screenshot_path IS NULL THEN NULL ELSE json_array(screenshot_path) END;`,
  // Practice runs (FR-P4): session kind, label and summary; one row per practice question.
  `ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'copilot';
   ALTER TABLE sessions ADD COLUMN label TEXT;
   ALTER TABLE sessions ADD COLUMN summary TEXT;
   ALTER TABLE sessions ADD COLUMN average_score REAL;
   CREATE TABLE practice_items (
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     idx INTEGER NOT NULL,
     question TEXT NOT NULL,
     type TEXT NOT NULL,
     status TEXT NOT NULL,
     answer TEXT NOT NULL,
     score INTEGER,
     strengths TEXT,
     gaps TEXT,
     improved_answer TEXT,
     served_by TEXT,
     ts INTEGER NOT NULL,
     PRIMARY KEY (session_id, idx)
   );`,
  // Work Mode (FR-W1..W4): projects, their tasks and timestamped updates; which project a status answer was about.
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     aliases TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL,
     owner TEXT NOT NULL DEFAULT '',
     stakeholders TEXT NOT NULL DEFAULT '',
     deadline TEXT NOT NULL DEFAULT '',
     notes TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     summary TEXT NOT NULL DEFAULT '',
     summary_of TEXT
   );
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     status TEXT NOT NULL,
     due TEXT NOT NULL DEFAULT '',
     blockers TEXT NOT NULL DEFAULT '',
     note TEXT NOT NULL DEFAULT '',
     position INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX tasks_project ON tasks(project_id, position);
   CREATE TABLE project_updates (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     ts INTEGER NOT NULL,
     text TEXT NOT NULL,
     source TEXT NOT NULL,
     session_id TEXT
   );
   CREATE INDEX project_updates_project ON project_updates(project_id, ts);
   ALTER TABLE qa_pairs ADD COLUMN project TEXT;`,
  // Work items (FR-W2): kind, owner, who it's waiting on, environment, follow-up and a reference;
  // updates can belong to one item and record who said it (FR-W3).
  `ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';
   ALTER TABLE tasks ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE tasks ADD COLUMN owner TEXT NOT NULL DEFAULT '';
   ALTER TABLE tasks ADD COLUMN waiting_on TEXT NOT NULL DEFAULT '';
   ALTER TABLE tasks ADD COLUMN environment TEXT NOT NULL DEFAULT '';
   ALTER TABLE tasks ADD COLUMN followed_up TEXT NOT NULL DEFAULT '';
   ALTER TABLE tasks ADD COLUMN follow_up_note TEXT NOT NULL DEFAULT '';
   ALTER TABLE tasks ADD COLUMN ref TEXT NOT NULL DEFAULT '';
   ALTER TABLE project_updates ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
   ALTER TABLE project_updates ADD COLUMN author TEXT NOT NULL DEFAULT '';
   CREATE INDEX project_updates_task ON project_updates(task_id, ts);`,
  // Teams updates (FR-T1..T4): changes proposed from Teams messages, waiting for review; and how far
  // each followed chat or channel has been read (FR-T3).
  `CREATE TABLE work_proposals (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     state TEXT NOT NULL,
     source TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX work_proposals_state ON work_proposals(state, created_at);
   CREATE TABLE teams_cursors (source_id TEXT PRIMARY KEY, last_ts INTEGER NOT NULL);`
]

/** Opens (creating if needed) the history database and brings its schema up to date. */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  return db
}
