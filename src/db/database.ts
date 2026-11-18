import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

type Db = Database.Database;

let instance: Db | undefined;
const statementCache = new WeakMap<Db, Map<string, Database.Statement>>();

/**
 * Schema migrations, applied in order and tracked with `PRAGMA user_version`.
 * Never edit a migration that has shipped; append a new one instead.
 */
const MIGRATIONS: ReadonlyArray<(db: Db) => void> = [
  // v1 — original schema (IF NOT EXISTS keeps it safe for databases created before versioning).
  db => db.exec(`
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      welcome_channel_id TEXT,
      welcome_message TEXT NOT NULL DEFAULT 'Welcome {user} to **{server}**!',
      log_channel_id TEXT,
      anti_link INTEGER NOT NULL DEFAULT 0,
      anti_spam INTEGER NOT NULL DEFAULT 1,
      caps_percent INTEGER NOT NULL DEFAULT 80,
      bad_words TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS reaction_roles (
      guild_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, message_id, emoji)
    );
    CREATE TABLE IF NOT EXISTS warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      moderator_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ai_config (
      guild_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      channel_id TEXT,
      mention_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ai_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation
      ON ai_messages (guild_id, channel_id, user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_messages_guild ON ai_messages (guild_id);
    CREATE INDEX IF NOT EXISTS idx_ai_messages_created_at ON ai_messages (created_at);
  `),

  // v2 — AI moderation settings, per-server instructions, rolling memory and usage metrics.
  db => db.exec(`
    ALTER TABLE guild_config ADD COLUMN ai_moderation INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE guild_config ADD COLUMN ai_moderation_action TEXT NOT NULL DEFAULT 'flag';
    ALTER TABLE guild_config ADD COLUMN ai_moderation_threshold REAL NOT NULL DEFAULT 0.8;
    ALTER TABLE ai_config ADD COLUMN custom_instructions TEXT;

    CREATE TABLE IF NOT EXISTS ai_conversation_summaries (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, channel_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS ai_usage (
      day TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      feature TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_latency_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, guild_id, feature, provider, model)
    );
    CREATE INDEX IF NOT EXISTS idx_warnings_member ON warnings (guild_id, user_id, id DESC);
  `),

  // v3 — knowledge base (RAG with FTS5 + embeddings) and the learning loops.
  db => db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT,
      created_by TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_documents_guild ON knowledge_documents (guild_id, id DESC);

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      embedding_model TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document ON knowledge_chunks (document_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_guild ON knowledge_chunks (guild_id, embedding_model);

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      content,
      content = 'knowledge_chunks',
      content_rowid = 'id',
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
      INSERT INTO knowledge_fts (rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
      INSERT INTO knowledge_fts (knowledge_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_chunks_au AFTER UPDATE OF content ON knowledge_chunks BEGIN
      INSERT INTO knowledge_fts (knowledge_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO knowledge_fts (rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TABLE IF NOT EXISTS ai_exchanges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message_id TEXT,
      prompt TEXT NOT NULL,
      answer TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      embedding BLOB,
      embedding_model TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ai_exchanges_guild ON ai_exchanges (guild_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_exchanges_user ON ai_exchanges (guild_id, user_id);

    CREATE TABLE IF NOT EXISTS ai_feedback (
      exchange_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
      is_moderator INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (exchange_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS ai_moderation_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      deleted INTEGER NOT NULL DEFAULT 0,
      decision TEXT,
      decided_by TEXT,
      decided_at TEXT,
      embedding BLOB,
      embedding_model TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ai_moderation_flags_guild ON ai_moderation_flags (guild_id, decision, id DESC);

    CREATE TABLE IF NOT EXISTS ai_user_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (guild_id, user_id, fact_key)
    );
  `)
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function initDatabase(filePath: string): Db {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  runMigrations(db);
  instance?.close();
  instance = db;
  return db;
}

export function runMigrations(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.transaction(() => {
      MIGRATIONS[version](db);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

export function getDatabase(): Db {
  if (!instance) throw new Error("Database is not initialised. Call initDatabase() first.");
  return instance;
}

/** Returns a cached prepared statement for the active database. */
export function statement(sql: string): Database.Statement {
  const db = getDatabase();
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let prepared = cache.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    cache.set(sql, prepared);
  }
  return prepared;
}

export function transaction<T>(work: () => T): T {
  return getDatabase().transaction(work)();
}

export function closeDatabase(): void {
  instance?.close();
  instance = undefined;
}
