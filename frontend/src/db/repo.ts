import { getDb } from "./database";
import {
  Attachment,
  AttachmentType,
  ChecklistItem,
  FilterKey,
  Folder,
  Label,
  Note,
  NoteListItem,
  NoteType,
  SortKey,
} from "./types";
import { deleteFile } from "../lib/files";
import { genId, nowIso } from "../lib/id";
import { contentToPlainText, isContentBlank } from "../lib/richtext";

// ---------- Notes ----------

export async function createNote(partial: Partial<Note> = {}): Promise<Note> {
  const db = await getDb();
  const ts = nowIso();
  const note: Note = {
    id: genId("note"),
    title: partial.title ?? "",
    content: partial.content ?? "",
    type: partial.type ?? "text",
    color: partial.color ?? "default",
    folderId: partial.folderId ?? null,
    isPinned: partial.isPinned ?? 0,
    isFavorite: partial.isFavorite ?? 0,
    isArchived: partial.isArchived ?? 0,
    isDeleted: partial.isDeleted ?? 0,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
  };
  note.plainText = contentToPlainText(note.content);
  await db.runAsync(
    `INSERT INTO notes (id,title,content,plainText,type,color,folderId,isPinned,isFavorite,isArchived,isDeleted,createdAt,updatedAt,deletedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      note.id,
      note.title,
      note.content,
      note.plainText,
      note.type,
      note.color,
      note.folderId,
      note.isPinned,
      note.isFavorite,
      note.isArchived,
      note.isDeleted,
      note.createdAt,
      note.updatedAt,
      note.deletedAt,
    ],
  );
  return note;
}

export async function getNote(id: string): Promise<Note | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Note>(`SELECT * FROM notes WHERE id = ?`, [
    id,
  ]);
  return row ?? null;
}

const UPDATABLE = new Set([
  "title",
  "content",
  "plainText",
  "type",
  "color",
  "folderId",
  "isPinned",
  "isFavorite",
  "isArchived",
  "isDeleted",
  "deletedAt",
]);

export async function updateNote(
  id: string,
  fields: Partial<Note>,
): Promise<void> {
  const db = await getDb();
  if (typeof fields.content === "string") {
    fields = { ...fields, plainText: contentToPlainText(fields.content) };
  }
  const keys = Object.keys(fields).filter((k) => UPDATABLE.has(k));
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (fields as any)[k]);
  await db.runAsync(
    `UPDATE notes SET ${setClause}, updatedAt = ? WHERE id = ?`,
    [...values, nowIso(), id],
  );
}

export async function trashNote(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE notes SET isDeleted = 1, deletedAt = ?, updatedAt = ? WHERE id = ?`,
    [nowIso(), nowIso(), id],
  );
}

export async function restoreNote(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE notes SET isDeleted = 0, deletedAt = NULL, isArchived = 0, updatedAt = ? WHERE id = ?`,
    [nowIso(), id],
  );
}

export async function permanentlyDeleteNote(id: string): Promise<void> {
  const db = await getDb();
  const atts = await db.getAllAsync<Attachment>(
    `SELECT * FROM attachments WHERE noteId = ?`,
    [id],
  );
  for (const a of atts) await deleteFile(a.localPath);
  await db.withTransactionAsync(async () => {
    await db.runAsync(`DELETE FROM attachments WHERE noteId = ?`, [id]);
    await db.runAsync(`DELETE FROM checklist_items WHERE noteId = ?`, [id]);
    await db.runAsync(`DELETE FROM note_labels WHERE noteId = ?`, [id]);
    await db.runAsync(`DELETE FROM notes WHERE id = ?`, [id]);
  });
}

export async function emptyTrash(): Promise<void> {
  const db = await getDb();
  const ids = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM notes WHERE isDeleted = 1`,
  );
  for (const { id } of ids) await permanentlyDeleteNote(id);
}

// Auto-purge trash items older than 30 days.
export async function purgeOldTrash(): Promise<void> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const ids = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM notes WHERE isDeleted = 1 AND deletedAt IS NOT NULL AND deletedAt < ?`,
    [cutoff],
  );
  for (const { id } of ids) await permanentlyDeleteNote(id);
}

const SORT_SQL: Record<SortKey, string> = {
  updated: "updatedAt DESC",
  newest: "createdAt DESC",
  oldest: "createdAt ASC",
  az: "LOWER(title) ASC",
  za: "LOWER(title) DESC",
};

export interface ListParams {
  filter: FilterKey;
  folderId?: string | null;
  labelId?: string | null;
  search?: string;
  sort: SortKey;
}

export async function listNotes(params: ListParams): Promise<NoteListItem[]> {
  const db = await getDb();
  const where: string[] = [];
  const args: any[] = [];

  if (params.folderId) {
    where.push("n.folderId = ?");
    args.push(params.folderId);
    where.push("n.isDeleted = 0 AND n.isArchived = 0");
  } else {
    switch (params.filter) {
      case "all":
        where.push("n.isDeleted = 0 AND n.isArchived = 0");
        break;
      case "favorites":
        where.push("n.isFavorite = 1 AND n.isDeleted = 0 AND n.isArchived = 0");
        break;
      case "pinned":
        where.push("n.isPinned = 1 AND n.isDeleted = 0 AND n.isArchived = 0");
        break;
      case "archived":
        where.push("n.isArchived = 1 AND n.isDeleted = 0");
        break;
      case "trash":
        where.push("n.isDeleted = 1");
        break;
    }
  }

  if (params.labelId) {
    where.push("n.id IN (SELECT noteId FROM note_labels WHERE labelId = ?)");
    args.push(params.labelId);
  }

  const q = (params.search ?? "").trim();
  if (q) {
    const like = `%${q}%`;
    where.push(`(
      n.title LIKE ? OR
      n.plainText LIKE ? OR
      n.id IN (SELECT noteId FROM checklist_items WHERE text LIKE ?) OR
      n.folderId IN (SELECT id FROM folders WHERE name LIKE ?) OR
      n.id IN (SELECT nl.noteId FROM note_labels nl JOIN labels l ON nl.labelId = l.id WHERE l.name LIKE ?)
    )`);
    args.push(like, like, like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderSql = `ORDER BY n.isPinned DESC, ${SORT_SQL[params.sort] ?? SORT_SQL.updated}`;

  const sql = `
    SELECT n.*,
      (SELECT COUNT(*) FROM checklist_items c WHERE c.noteId = n.id) AS checklistTotal,
      (SELECT COUNT(*) FROM checklist_items c WHERE c.noteId = n.id AND c.isCompleted = 1) AS checklistDone,
      (SELECT COUNT(*) FROM attachments a WHERE a.noteId = n.id) AS attachmentCount,
      (SELECT a.localPath FROM attachments a WHERE a.noteId = n.id AND a.type = 'image' ORDER BY a.createdAt ASC LIMIT 1) AS imagePath,
      (SELECT GROUP_CONCAT(l.name, ',') FROM note_labels nl JOIN labels l ON nl.labelId = l.id WHERE nl.noteId = n.id) AS labelNames
    FROM notes n
    ${whereSql}
    ${orderSql}
  `;
  return db.getAllAsync<NoteListItem>(sql, args);
}

// ---------- Checklist ----------

export async function getChecklist(noteId: string): Promise<ChecklistItem[]> {
  const db = await getDb();
  return db.getAllAsync<ChecklistItem>(
    `SELECT * FROM checklist_items WHERE noteId = ? ORDER BY position ASC`,
    [noteId],
  );
}

export async function addChecklistItem(
  noteId: string,
  text: string,
  position: number,
): Promise<ChecklistItem> {
  const db = await getDb();
  const item: ChecklistItem = {
    id: genId("ci"),
    noteId,
    text,
    isCompleted: 0,
    position,
  };
  await db.runAsync(
    `INSERT INTO checklist_items (id,noteId,text,isCompleted,position) VALUES (?,?,?,?,?)`,
    [item.id, item.noteId, item.text, item.isCompleted, item.position],
  );
  return item;
}

export async function updateChecklistItem(
  id: string,
  fields: Partial<ChecklistItem>,
): Promise<void> {
  const db = await getDb();
  const keys = Object.keys(fields).filter((k) =>
    ["text", "isCompleted", "position"].includes(k),
  );
  if (!keys.length) return;
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (fields as any)[k]);
  await db.runAsync(`UPDATE checklist_items SET ${setClause} WHERE id = ?`, [
    ...values,
    id,
  ]);
}

export async function deleteChecklistItem(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM checklist_items WHERE id = ?`, [id]);
}

export async function reorderChecklist(
  items: ChecklistItem[],
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < items.length; i++) {
      await db.runAsync(`UPDATE checklist_items SET position = ? WHERE id = ?`, [
        i,
        items[i].id,
      ]);
    }
  });
}

// ---------- Folders ----------

export async function listFolders(): Promise<Folder[]> {
  const db = await getDb();
  return db.getAllAsync<Folder>(`
    SELECT f.*, (SELECT COUNT(*) FROM notes n WHERE n.folderId = f.id AND n.isDeleted = 0 AND n.isArchived = 0) AS noteCount
    FROM folders f ORDER BY LOWER(f.name) ASC
  `);
}

export async function createFolder(name: string): Promise<Folder> {
  const db = await getDb();
  const ts = nowIso();
  const folder: Folder = { id: genId("fld"), name, createdAt: ts, updatedAt: ts };
  await db.runAsync(
    `INSERT INTO folders (id,name,createdAt,updatedAt) VALUES (?,?,?,?)`,
    [folder.id, folder.name, folder.createdAt, folder.updatedAt],
  );
  return folder;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE folders SET name = ?, updatedAt = ? WHERE id = ?`, [
    name,
    nowIso(),
    id,
  ]);
}

export async function deleteFolder(id: string): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync(`UPDATE notes SET folderId = NULL WHERE folderId = ?`, [id]);
    await db.runAsync(`DELETE FROM folders WHERE id = ?`, [id]);
  });
}

export async function getFolder(id: string): Promise<Folder | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Folder>(
    `SELECT * FROM folders WHERE id = ?`,
    [id],
  );
  return row ?? null;
}

// ---------- Labels ----------

export async function listLabels(): Promise<Label[]> {
  const db = await getDb();
  return db.getAllAsync<Label>(`
    SELECT l.*, (SELECT COUNT(*) FROM note_labels nl JOIN notes n ON nl.noteId = n.id WHERE nl.labelId = l.id AND n.isDeleted = 0) AS noteCount
    FROM labels l ORDER BY LOWER(l.name) ASC
  `);
}

export async function createLabel(name: string): Promise<Label> {
  const db = await getDb();
  const clean = name.replace(/^#/, "").trim();
  const existing = await db.getFirstAsync<Label>(
    `SELECT * FROM labels WHERE LOWER(name) = LOWER(?)`,
    [clean],
  );
  if (existing) return existing;
  const label: Label = { id: genId("lbl"), name: clean };
  await db.runAsync(`INSERT INTO labels (id,name) VALUES (?,?)`, [
    label.id,
    label.name,
  ]);
  return label;
}

export async function renameLabel(id: string, name: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE labels SET name = ? WHERE id = ?`, [
    name.replace(/^#/, "").trim(),
    id,
  ]);
}

export async function deleteLabel(id: string): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync(`DELETE FROM note_labels WHERE labelId = ?`, [id]);
    await db.runAsync(`DELETE FROM labels WHERE id = ?`, [id]);
  });
}

export async function getNoteLabels(noteId: string): Promise<Label[]> {
  const db = await getDb();
  return db.getAllAsync<Label>(
    `SELECT l.* FROM labels l JOIN note_labels nl ON l.id = nl.labelId WHERE nl.noteId = ? ORDER BY LOWER(l.name)`,
    [noteId],
  );
}

export async function setNoteLabels(
  noteId: string,
  labelIds: string[],
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync(`DELETE FROM note_labels WHERE noteId = ?`, [noteId]);
    for (const labelId of labelIds) {
      await db.runAsync(
        `INSERT OR IGNORE INTO note_labels (noteId,labelId) VALUES (?,?)`,
        [noteId, labelId],
      );
    }
  });
}

// ---------- Attachments ----------

export async function getAttachments(noteId: string): Promise<Attachment[]> {
  const db = await getDb();
  return db.getAllAsync<Attachment>(
    `SELECT * FROM attachments WHERE noteId = ? ORDER BY createdAt ASC`,
    [noteId],
  );
}

export async function addAttachment(
  noteId: string,
  type: AttachmentType,
  localPath: string,
  fileName: string | null,
  fileSize: number | null,
  duration: number | null,
): Promise<Attachment> {
  const db = await getDb();
  const att: Attachment = {
    id: genId("att"),
    noteId,
    type,
    localPath,
    fileName,
    fileSize,
    duration,
    createdAt: nowIso(),
  };
  await db.runAsync(
    `INSERT INTO attachments (id,noteId,type,localPath,fileName,fileSize,duration,createdAt) VALUES (?,?,?,?,?,?,?,?)`,
    [att.id, att.noteId, att.type, att.localPath, att.fileName, att.fileSize, att.duration, att.createdAt],
  );
  return att;
}

export async function deleteAttachment(id: string): Promise<void> {
  const db = await getDb();
  const att = await db.getFirstAsync<Attachment>(
    `SELECT * FROM attachments WHERE id = ?`,
    [id],
  );
  if (att) await deleteFile(att.localPath);
  await db.runAsync(`DELETE FROM attachments WHERE id = ?`, [id]);
}

// ---------- Stats ----------

export async function getStats(): Promise<{
  noteCount: number;
  attachmentCount: number;
}> {
  const db = await getDb();
  const n = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM notes WHERE isDeleted = 0`,
  );
  const a = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM attachments`,
  );
  return { noteCount: n?.c ?? 0, attachmentCount: a?.c ?? 0 };
}

// Delete a note only if it has no meaningful content (used on editor exit).
export async function discardIfEmpty(id: string): Promise<boolean> {
  const db = await getDb();
  const note = await getNote(id);
  if (!note) return false;
  const hasTitle = note.title.trim().length > 0;
  const hasContent = !isContentBlank(note.content);
  const cl = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM checklist_items WHERE noteId = ? AND text != ''`,
    [id],
  );
  const at = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM attachments WHERE noteId = ?`,
    [id],
  );
  if (!hasTitle && !hasContent && (cl?.c ?? 0) === 0 && (at?.c ?? 0) === 0) {
    await permanentlyDeleteNote(id);
    return true;
  }
  return false;
}
