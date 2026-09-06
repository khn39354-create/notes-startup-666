export type NoteType = "text" | "checklist" | "voice" | "image" | "drawing";
export type AttachmentType = "image" | "audio" | "drawing";

export interface Note {
  id: string;
  title: string;
  content: string;
  /** Derived search/preview text (may be missing on legacy rows). */
  plainText?: string;
  type: NoteType;
  color: string;
  folderId: string | null;
  isPinned: number;
  isFavorite: number;
  isArchived: number;
  isDeleted: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface NoteListItem extends Note {
  checklistTotal: number;
  checklistDone: number;
  attachmentCount: number;
  imagePath: string | null;
  labelNames: string | null;
}

export interface ChecklistItem {
  id: string;
  noteId: string;
  text: string;
  isCompleted: number;
  position: number;
}

export interface Folder {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  noteCount?: number;
}

export interface Label {
  id: string;
  name: string;
  noteCount?: number;
}

export interface Attachment {
  id: string;
  noteId: string;
  type: AttachmentType;
  localPath: string;
  fileName: string | null;
  fileSize: number | null;
  duration: number | null;
  createdAt: string;
}

export type FilterKey =
  | "all"
  | "favorites"
  | "pinned"
  | "archived"
  | "trash";

export type SortKey = "updated" | "newest" | "oldest" | "az" | "za";
