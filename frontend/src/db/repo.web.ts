// Web implementation of the data layer, backed by AsyncStorage (via the shared
// storage util). Metro automatically prefers this file over repo.ts on web.
// Mirrors every export of repo.ts with identical signatures.
import { storage } from "@/src/utils/storage";
import {
  Attachment,
  AttachmentType,
  ChecklistItem,
  FilterKey,
  Folder,
  Label,
  Note,
  NoteListItem,
  SortKey,
} from "./types";
import { deleteFile } from "../lib/files";
import { genId, nowIso } from "../lib/id";
import { contentToPlainText, isContentBlank } from "../lib/richtext";

interface DBShape {
  notes: Note[];
  checklist: ChecklistItem[];
  folders: Folder[];
  labels: Label[];
  noteLabels: { noteId: string; labelId: string }[];
  attachments: Attachment[];
}

const KEY = "notes.webdb.v1";
let cache: DBShape | null = null;
let loadPromise: Promise<DBShape> | null = null;

const empty = (): DBShape => ({
  notes: [],
  checklist: [],
  folders: [],
  labels: [],
  noteLabels: [],
  attachments: [],
});

async function load(): Promise<DBShape> {
  if (cache) return cache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const raw = await storage.getItem<any>(KEY, null);
    cache = raw && typeof raw === "object" ? { ...empty(), ...raw } : empty();
    return cache;
  })();
  return loadPromise;
}

async function save(): Promise<void> {
  if (cache) await storage.setItem(KEY, cache as any);
}

// ---------- Notes ----------

export async function createNote(partial: Partial<Note> = {}): Promise<Note> {
  const db = await load();
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
  db.notes.push(note);
  await save();
  return note;
}

export async function getNote(id: string): Promise<Note | null> {
  const db = await load();
  return db.notes.find((n) => n.id === id) ?? null;
}

const UPDATABLE = new Set([
  "title", "content", "plainText", "type", "color", "folderId",
  "isPinned", "isFavorite", "isArchived", "isDeleted", "deletedAt",
]);

export async function updateNote(id: string, fields: Partial<Note>): Promise<void> {
  const db = await load();
  const n = db.notes.find((x) => x.id === id);
  if (!n) return;
  if (typeof fields.content === "string") {
    fields = { ...fields, plainText: contentToPlainText(fields.content) };
  }
  for (const k of Object.keys(fields)) {
    if (UPDATABLE.has(k)) (n as any)[k] = (fields as any)[k];
  }
  n.updatedAt = nowIso();
  await save();
}

export async function trashNote(id: string): Promise<void> {
  await updateNote(id, { isDeleted: 1, deletedAt: nowIso() } as any);
}

export async function restoreNote(id: string): Promise<void> {
  await updateNote(id, { isDeleted: 0, deletedAt: null, isArchived: 0 } as any);
}

export async function permanentlyDeleteNote(id: string): Promise<void> {
  const db = await load();
  const atts = db.attachments.filter((a) => a.noteId === id);
  for (const a of atts) await deleteFile(a.localPath);
  db.attachments = db.attachments.filter((a) => a.noteId !== id);
  db.checklist = db.checklist.filter((c) => c.noteId !== id);
  db.noteLabels = db.noteLabels.filter((nl) => nl.noteId !== id);
  db.notes = db.notes.filter((n) => n.id !== id);
  await save();
}

export async function emptyTrash(): Promise<void> {
  const db = await load();
  const ids = db.notes.filter((n) => n.isDeleted).map((n) => n.id);
  for (const id of ids) await permanentlyDeleteNote(id);
}

export async function purgeOldTrash(): Promise<void> {
  const db = await load();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const ids = db.notes
    .filter((n) => n.isDeleted && n.deletedAt && new Date(n.deletedAt).getTime() < cutoff)
    .map((n) => n.id);
  for (const id of ids) await permanentlyDeleteNote(id);
}

export interface ListParams {
  filter: FilterKey;
  folderId?: string | null;
  labelId?: string | null;
  search?: string;
  sort: SortKey;
}

function sortNotes(a: Note, b: Note, sort: SortKey): number {
  if (a.isPinned !== b.isPinned) return b.isPinned - a.isPinned;
  switch (sort) {
    case "newest": return b.createdAt.localeCompare(a.createdAt);
    case "oldest": return a.createdAt.localeCompare(b.createdAt);
    case "az": return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
    case "za": return b.title.toLowerCase().localeCompare(a.title.toLowerCase());
    default: return b.updatedAt.localeCompare(a.updatedAt);
  }
}

export async function listNotes(params: ListParams): Promise<NoteListItem[]> {
  const db = await load();
  let list = db.notes.slice();

  if (params.folderId) {
    list = list.filter((n) => n.folderId === params.folderId && !n.isDeleted && !n.isArchived);
  } else {
    switch (params.filter) {
      case "all": list = list.filter((n) => !n.isDeleted && !n.isArchived); break;
      case "favorites": list = list.filter((n) => n.isFavorite && !n.isDeleted && !n.isArchived); break;
      case "pinned": list = list.filter((n) => n.isPinned && !n.isDeleted && !n.isArchived); break;
      case "archived": list = list.filter((n) => n.isArchived && !n.isDeleted); break;
      case "trash": list = list.filter((n) => n.isDeleted); break;
    }
  }

  if (params.labelId) {
    const ids = new Set(db.noteLabels.filter((nl) => nl.labelId === params.labelId).map((nl) => nl.noteId));
    list = list.filter((n) => ids.has(n.id));
  }

  const q = (params.search ?? "").trim().toLowerCase();
  if (q) {
    const folderMatch = new Set(db.folders.filter((f) => f.name.toLowerCase().includes(q)).map((f) => f.id));
    const labelMatch = new Set(db.labels.filter((l) => l.name.toLowerCase().includes(q)).map((l) => l.id));
    const noteIdsByLabel = new Set(db.noteLabels.filter((nl) => labelMatch.has(nl.labelId)).map((nl) => nl.noteId));
    const noteIdsByCheck = new Set(db.checklist.filter((c) => c.text.toLowerCase().includes(q)).map((c) => c.noteId));
    list = list.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        (n.plainText ?? contentToPlainText(n.content)).toLowerCase().includes(q) ||
        noteIdsByCheck.has(n.id) ||
        (n.folderId ? folderMatch.has(n.folderId) : false) ||
        noteIdsByLabel.has(n.id),
    );
  }

  list.sort((a, b) => sortNotes(a, b, params.sort));

  return list.map((n) => {
    const cl = db.checklist.filter((c) => c.noteId === n.id);
    const atts = db.attachments.filter((a) => a.noteId === n.id);
    const img = atts.find((a) => a.type === "image");
    const labelNames = db.noteLabels
      .filter((nl) => nl.noteId === n.id)
      .map((nl) => db.labels.find((l) => l.id === nl.labelId)?.name)
      .filter(Boolean)
      .join(",");
    return {
      ...n,
      checklistTotal: cl.length,
      checklistDone: cl.filter((c) => c.isCompleted).length,
      attachmentCount: atts.length,
      imagePath: img?.localPath ?? null,
      labelNames: labelNames || null,
    };
  });
}

// ---------- Checklist ----------

export async function getChecklist(noteId: string): Promise<ChecklistItem[]> {
  const db = await load();
  return db.checklist.filter((c) => c.noteId === noteId).sort((a, b) => a.position - b.position);
}

export async function addChecklistItem(noteId: string, text: string, position: number): Promise<ChecklistItem> {
  const db = await load();
  const item: ChecklistItem = { id: genId("ci"), noteId, text, isCompleted: 0, position };
  db.checklist.push(item);
  await save();
  return item;
}

export async function updateChecklistItem(id: string, fields: Partial<ChecklistItem>): Promise<void> {
  const db = await load();
  const it = db.checklist.find((c) => c.id === id);
  if (!it) return;
  for (const k of ["text", "isCompleted", "position"]) {
    if (k in fields) (it as any)[k] = (fields as any)[k];
  }
  await save();
}

export async function deleteChecklistItem(id: string): Promise<void> {
  const db = await load();
  db.checklist = db.checklist.filter((c) => c.id !== id);
  await save();
}

export async function reorderChecklist(items: ChecklistItem[]): Promise<void> {
  const db = await load();
  items.forEach((it, i) => {
    const found = db.checklist.find((c) => c.id === it.id);
    if (found) found.position = i;
  });
  await save();
}

// ---------- Folders ----------

export async function listFolders(): Promise<Folder[]> {
  const db = await load();
  return db.folders
    .slice()
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .map((f) => ({
      ...f,
      noteCount: db.notes.filter((n) => n.folderId === f.id && !n.isDeleted && !n.isArchived).length,
    }));
}

export async function createFolder(name: string): Promise<Folder> {
  const db = await load();
  const ts = nowIso();
  const folder: Folder = { id: genId("fld"), name, createdAt: ts, updatedAt: ts };
  db.folders.push(folder);
  await save();
  return folder;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const db = await load();
  const f = db.folders.find((x) => x.id === id);
  if (f) { f.name = name; f.updatedAt = nowIso(); await save(); }
}

export async function deleteFolder(id: string): Promise<void> {
  const db = await load();
  db.notes.forEach((n) => { if (n.folderId === id) n.folderId = null; });
  db.folders = db.folders.filter((f) => f.id !== id);
  await save();
}

export async function getFolder(id: string): Promise<Folder | null> {
  const db = await load();
  return db.folders.find((f) => f.id === id) ?? null;
}

// ---------- Labels ----------

export async function listLabels(): Promise<Label[]> {
  const db = await load();
  return db.labels
    .slice()
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .map((l) => ({
      ...l,
      noteCount: db.noteLabels.filter((nl) => {
        if (nl.labelId !== l.id) return false;
        const n = db.notes.find((x) => x.id === nl.noteId);
        return n && !n.isDeleted;
      }).length,
    }));
}

export async function createLabel(name: string): Promise<Label> {
  const db = await load();
  const clean = name.replace(/^#/, "").trim();
  const existing = db.labels.find((l) => l.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const label: Label = { id: genId("lbl"), name: clean };
  db.labels.push(label);
  await save();
  return label;
}

export async function renameLabel(id: string, name: string): Promise<void> {
  const db = await load();
  const l = db.labels.find((x) => x.id === id);
  if (l) { l.name = name.replace(/^#/, "").trim(); await save(); }
}

export async function deleteLabel(id: string): Promise<void> {
  const db = await load();
  db.noteLabels = db.noteLabels.filter((nl) => nl.labelId !== id);
  db.labels = db.labels.filter((l) => l.id !== id);
  await save();
}

export async function getNoteLabels(noteId: string): Promise<Label[]> {
  const db = await load();
  const ids = db.noteLabels.filter((nl) => nl.noteId === noteId).map((nl) => nl.labelId);
  return db.labels.filter((l) => ids.includes(l.id));
}

export async function setNoteLabels(noteId: string, labelIds: string[]): Promise<void> {
  const db = await load();
  db.noteLabels = db.noteLabels.filter((nl) => nl.noteId !== noteId);
  for (const labelId of labelIds) db.noteLabels.push({ noteId, labelId });
  await save();
}

// ---------- Attachments ----------

export async function getAttachments(noteId: string): Promise<Attachment[]> {
  const db = await load();
  return db.attachments.filter((a) => a.noteId === noteId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addAttachment(
  noteId: string,
  type: AttachmentType,
  localPath: string,
  fileName: string | null,
  fileSize: number | null,
  duration: number | null,
): Promise<Attachment> {
  const db = await load();
  const att: Attachment = { id: genId("att"), noteId, type, localPath, fileName, fileSize, duration, createdAt: nowIso() };
  db.attachments.push(att);
  await save();
  return att;
}

export async function deleteAttachment(id: string): Promise<void> {
  const db = await load();
  const att = db.attachments.find((a) => a.id === id);
  if (att) await deleteFile(att.localPath);
  db.attachments = db.attachments.filter((a) => a.id !== id);
  await save();
}

// ---------- Stats ----------

export async function getStats(): Promise<{ noteCount: number; attachmentCount: number }> {
  const db = await load();
  return {
    noteCount: db.notes.filter((n) => !n.isDeleted).length,
    attachmentCount: db.attachments.length,
  };
}

// ---------- Web-only backup helpers ----------

export async function webDump(): Promise<DBShape> {
  const db = await load();
  return JSON.parse(JSON.stringify(db));
}

export async function webReplaceAll(data: Partial<DBShape>): Promise<void> {
  cache = { ...empty(), ...data } as DBShape;
  await save();
}

export async function webMergeAll(data: DBShape): Promise<void> {
  const db = await load();
  const folderMap = new Map<string, string>();
  const labelMap = new Map<string, string>();
  const noteMap = new Map<string, string>();
  for (const f of data.folders) {
    const id = genId("fld");
    folderMap.set(f.id, id);
    db.folders.push({ ...f, id });
  }
  for (const l of data.labels) {
    const existing = db.labels.find((x) => x.name.toLowerCase() === l.name.toLowerCase());
    if (existing) labelMap.set(l.id, existing.id);
    else { const id = genId("lbl"); labelMap.set(l.id, id); db.labels.push({ ...l, id }); }
  }
  for (const n of data.notes) {
    const id = genId("note");
    noteMap.set(n.id, id);
    db.notes.push({ ...n, id, folderId: n.folderId ? folderMap.get(n.folderId) ?? null : null });
  }
  for (const c of data.checklist) {
    const noteId = noteMap.get(c.noteId);
    if (noteId) db.checklist.push({ ...c, id: genId("ci"), noteId });
  }
  for (const nl of data.noteLabels) {
    const noteId = noteMap.get(nl.noteId);
    const labelId = labelMap.get(nl.labelId);
    if (noteId && labelId) db.noteLabels.push({ noteId, labelId });
  }
  await save();
}

export async function discardIfEmpty(id: string): Promise<boolean> {
  const db = await load();
  const note = db.notes.find((n) => n.id === id);
  if (!note) return false;
  const hasTitle = note.title.trim().length > 0;
  const hasContent = !isContentBlank(note.content);
  const hasCheck = db.checklist.some((c) => c.noteId === id && c.text !== "");
  const hasAtt = db.attachments.some((a) => a.noteId === id);
  if (!hasTitle && !hasContent && !hasCheck && !hasAtt) {
    await permanentlyDeleteNote(id);
    return true;
  }
  return false;
}
