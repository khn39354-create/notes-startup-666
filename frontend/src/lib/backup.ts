import * as FileSystem from "expo-file-system/legacy";

import { getDb } from "../db/database";
import { copyIntoStore, writeCacheFile } from "./files";
import { genId, nowIso } from "./id";
import { contentToPlainText } from "./richtext";

const BACKUP_FORMAT = "notes_backup";
const BACKUP_VERSION = 1;

interface AttachmentBackup {
  id: string;
  noteId: string;
  type: string;
  fileName: string | null;
  fileSize: number | null;
  duration: number | null;
  createdAt: string;
  ext: string;
  base64: string | null;
}

// Build a full, self-contained backup file (JSON) in the cache dir.
export async function createBackupFile(): Promise<string> {
  const db = await getDb();
  const notes = await db.getAllAsync(`SELECT * FROM notes`);
  const checklist = await db.getAllAsync(`SELECT * FROM checklist_items`);
  const folders = await db.getAllAsync(`SELECT * FROM folders`);
  const labels = await db.getAllAsync(`SELECT * FROM labels`);
  const noteLabels = await db.getAllAsync(`SELECT * FROM note_labels`);
  const attRows = await db.getAllAsync<any>(`SELECT * FROM attachments`);

  const attachments: AttachmentBackup[] = [];
  for (const a of attRows) {
    let base64: string | null = null;
    const ext = (a.localPath.split(".").pop() || "bin").toLowerCase();
    try {
      const info = await FileSystem.getInfoAsync(a.localPath);
      if (info.exists && !info.isDirectory) {
        base64 = await FileSystem.readAsStringAsync(a.localPath, {
          encoding: FileSystem.EncodingType.Base64,
        });
      }
    } catch {
      base64 = null;
    }
    attachments.push({
      id: a.id,
      noteId: a.noteId,
      type: a.type,
      fileName: a.fileName,
      fileSize: a.fileSize,
      duration: a.duration,
      createdAt: a.createdAt,
      ext,
      base64,
    });
  }

  const payload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: nowIso(),
    data: {
      notes,
      checklist_items: checklist,
      folders,
      labels,
      note_labels: noteLabels,
      attachments,
    },
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `notes_backup_v${BACKUP_VERSION}_${stamp}.json`;
  return writeCacheFile(fileName, JSON.stringify(payload));
}

export interface ParsedBackup {
  data: {
    notes: any[];
    checklist_items: any[];
    folders: any[];
    labels: any[];
    note_labels: any[];
    attachments: AttachmentBackup[];
  };
}

export function validateBackup(raw: string): ParsedBackup | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.format !== BACKUP_FORMAT) return null;
    const d = parsed.data;
    if (!d || !Array.isArray(d.notes) || !Array.isArray(d.folders)) return null;
    return {
      data: {
        notes: d.notes ?? [],
        checklist_items: d.checklist_items ?? [],
        folders: d.folders ?? [],
        labels: d.labels ?? [],
        note_labels: d.note_labels ?? [],
        attachments: d.attachments ?? [],
      },
    };
  } catch {
    return null;
  }
}

async function restoreAttachmentFile(a: AttachmentBackup): Promise<string | null> {
  if (!a.base64) return null;
  try {
    const dir = FileSystem.documentDirectory + "attachments/";
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    const dest = `${dir}${genId("f")}.${a.ext}`;
    await FileSystem.writeAsStringAsync(dest, a.base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return dest;
  } catch {
    return null;
  }
}

// Replace: wipe existing data then insert backup as-is.
export async function restoreReplace(parsed: ParsedBackup): Promise<void> {
  const db = await getDb();
  // Delete existing attachment files.
  const existing = await db.getAllAsync<any>(`SELECT localPath FROM attachments`);
  for (const e of existing) {
    try {
      await FileSystem.deleteAsync(e.localPath, { idempotent: true });
    } catch {
      // ignore
    }
  }
  await db.withTransactionAsync(async () => {
    await db.runAsync(`DELETE FROM attachments`);
    await db.runAsync(`DELETE FROM checklist_items`);
    await db.runAsync(`DELETE FROM note_labels`);
    await db.runAsync(`DELETE FROM notes`);
    await db.runAsync(`DELETE FROM labels`);
    await db.runAsync(`DELETE FROM folders`);
  });

  const d = parsed.data;
  for (const f of d.folders) {
    await db.runAsync(
      `INSERT INTO folders (id,name,createdAt,updatedAt) VALUES (?,?,?,?)`,
      [f.id, f.name, f.createdAt ?? nowIso(), f.updatedAt ?? nowIso()],
    );
  }
  for (const l of d.labels) {
    await db.runAsync(`INSERT INTO labels (id,name) VALUES (?,?)`, [l.id, l.name]);
  }
  for (const n of d.notes) {
    await db.runAsync(
      `INSERT INTO notes (id,title,content,plainText,type,color,folderId,isPinned,isFavorite,isArchived,isDeleted,createdAt,updatedAt,deletedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        n.id, n.title ?? "", n.content ?? "", contentToPlainText(n.content ?? ""), n.type ?? "text", n.color ?? "default",
        n.folderId ?? null, n.isPinned ?? 0, n.isFavorite ?? 0, n.isArchived ?? 0,
        n.isDeleted ?? 0, n.createdAt ?? nowIso(), n.updatedAt ?? nowIso(), n.deletedAt ?? null,
      ],
    );
  }
  for (const c of d.checklist_items) {
    await db.runAsync(
      `INSERT INTO checklist_items (id,noteId,text,isCompleted,position) VALUES (?,?,?,?,?)`,
      [c.id, c.noteId, c.text ?? "", c.isCompleted ?? 0, c.position ?? 0],
    );
  }
  for (const nl of d.note_labels) {
    await db.runAsync(
      `INSERT OR IGNORE INTO note_labels (noteId,labelId) VALUES (?,?)`,
      [nl.noteId, nl.labelId],
    );
  }
  for (const a of d.attachments) {
    const path = await restoreAttachmentFile(a);
    if (!path) continue;
    await db.runAsync(
      `INSERT INTO attachments (id,noteId,type,localPath,fileName,fileSize,duration,createdAt) VALUES (?,?,?,?,?,?,?,?)`,
      [a.id, a.noteId, a.type, path, a.fileName ?? null, a.fileSize ?? null, a.duration ?? null, a.createdAt ?? nowIso()],
    );
  }
}

// Merge: keep existing data, add backup with fresh ids (no collisions).
export async function restoreMerge(parsed: ParsedBackup): Promise<void> {
  const db = await getDb();
  const d = parsed.data;
  const folderMap = new Map<string, string>();
  const labelMap = new Map<string, string>();
  const noteMap = new Map<string, string>();

  for (const f of d.folders) {
    const id = genId("fld");
    folderMap.set(f.id, id);
    await db.runAsync(
      `INSERT INTO folders (id,name,createdAt,updatedAt) VALUES (?,?,?,?)`,
      [id, f.name, f.createdAt ?? nowIso(), f.updatedAt ?? nowIso()],
    );
  }
  for (const l of d.labels) {
    const existing = await db.getFirstAsync<any>(
      `SELECT id FROM labels WHERE LOWER(name) = LOWER(?)`,
      [l.name],
    );
    if (existing) {
      labelMap.set(l.id, existing.id);
    } else {
      const id = genId("lbl");
      labelMap.set(l.id, id);
      await db.runAsync(`INSERT INTO labels (id,name) VALUES (?,?)`, [id, l.name]);
    }
  }
  for (const n of d.notes) {
    const id = genId("note");
    noteMap.set(n.id, id);
    await db.runAsync(
      `INSERT INTO notes (id,title,content,plainText,type,color,folderId,isPinned,isFavorite,isArchived,isDeleted,createdAt,updatedAt,deletedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, n.title ?? "", n.content ?? "", contentToPlainText(n.content ?? ""), n.type ?? "text", n.color ?? "default",
        n.folderId ? folderMap.get(n.folderId) ?? null : null,
        n.isPinned ?? 0, n.isFavorite ?? 0, n.isArchived ?? 0, n.isDeleted ?? 0,
        n.createdAt ?? nowIso(), n.updatedAt ?? nowIso(), n.deletedAt ?? null,
      ],
    );
  }
  for (const c of d.checklist_items) {
    const noteId = noteMap.get(c.noteId);
    if (!noteId) continue;
    await db.runAsync(
      `INSERT INTO checklist_items (id,noteId,text,isCompleted,position) VALUES (?,?,?,?,?)`,
      [genId("ci"), noteId, c.text ?? "", c.isCompleted ?? 0, c.position ?? 0],
    );
  }
  for (const nl of d.note_labels) {
    const noteId = noteMap.get(nl.noteId);
    const labelId = labelMap.get(nl.labelId);
    if (!noteId || !labelId) continue;
    await db.runAsync(
      `INSERT OR IGNORE INTO note_labels (noteId,labelId) VALUES (?,?)`,
      [noteId, labelId],
    );
  }
  for (const a of d.attachments) {
    const noteId = noteMap.get(a.noteId);
    if (!noteId) continue;
    const path = await restoreAttachmentFile(a);
    if (!path) continue;
    await db.runAsync(
      `INSERT INTO attachments (id,noteId,type,localPath,fileName,fileSize,duration,createdAt) VALUES (?,?,?,?,?,?,?,?)`,
      [genId("att"), noteId, a.type, path, a.fileName ?? null, a.fileSize ?? null, a.duration ?? null, a.createdAt ?? nowIso()],
    );
  }
}

export { copyIntoStore };
