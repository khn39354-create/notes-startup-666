import * as SQLite from "expo-sqlite";

import { contentToPlainText } from "../lib/richtext";
import { logError } from "../lib/errors";

let dbInstance: SQLite.SQLiteDatabase | null = null;
let initPromise: Promise<SQLite.SQLiteDatabase> | null = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'text',
  color TEXT NOT NULL DEFAULT 'default',
  folderId TEXT,
  isPinned INTEGER NOT NULL DEFAULT 0,
  isFavorite INTEGER NOT NULL DEFAULT 0,
  isArchived INTEGER NOT NULL DEFAULT 0,
  isDeleted INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY NOT NULL,
  noteId TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  isCompleted INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS note_labels (
  noteId TEXT NOT NULL,
  labelId TEXT NOT NULL,
  PRIMARY KEY (noteId, labelId)
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY NOT NULL,
  noteId TEXT NOT NULL,
  type TEXT NOT NULL,
  localPath TEXT NOT NULL,
  fileName TEXT,
  fileSize INTEGER,
  duration INTEGER,
  createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_title ON notes(title);
CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folderId);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(createdAt);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updatedAt);
CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(isPinned);
CREATE INDEX IF NOT EXISTS idx_notes_favorite ON notes(isFavorite);
CREATE INDEX IF NOT EXISTS idx_notes_archived ON notes(isArchived);
CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(isDeleted);
CREATE INDEX IF NOT EXISTS idx_checklist_note ON checklist_items(noteId);
CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(noteId);
CREATE INDEX IF NOT EXISTS idx_notelabels_label ON note_labels(labelId);
CREATE INDEX IF NOT EXISTS idx_notelabels_note ON note_labels(noteId);
`;

/**
 * Additive, idempotent migrations. Existing rows are never deleted or reset:
 *  v2 - notes.plainText (search/preview text derived from rich content).
 */
async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(notes)`);
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("plainText")) {
    await db.execAsync(`ALTER TABLE notes ADD COLUMN plainText TEXT NOT NULL DEFAULT ''`);
  }
  // Backfill plainText for legacy rows (content unchanged; only the derived column is written).
  try {
    const rows = await db.getAllAsync<{ id: string; content: string }>(
      `SELECT id, content FROM notes WHERE plainText = '' AND content != ''`,
    );
    for (const r of rows) {
      const plain = contentToPlainText(r.content);
      if (plain) await db.runAsync(`UPDATE notes SET plainText = ? WHERE id = ?`, [plain, r.id]);
    }
  } catch (e) {
    logError("db.migrate.backfill", e);
  }
}

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (dbInstance) return dbInstance;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const db = await SQLite.openDatabaseAsync("notes_app.db");
      await db.execAsync(SCHEMA);
      await migrate(db);
      dbInstance = db;
      return db;
    } catch (e) {
      initPromise = null; // allow a retry on the next call
      logError("db.init", e);
      throw e;
    }
  })();
  return initPromise;
}
