import { Platform } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

import { getChecklist } from "../db/repo";
import { Note } from "../db/types";
import { writeCacheFile } from "./files";
import { contentToMarkdown, contentToPlainText, escapeHtml, toHtml } from "./richtext";

export type ExportFormat = "txt" | "md" | "pdf";
export type ExportResult = "shared" | "unavailable" | "empty";

function safeBase(name: string, fallback: string): string {
  const b = (name || fallback)
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return b || fallback;
}

async function noteToTxt(note: Note): Promise<string> {
  const title = note.title || "Untitled";
  let out = `${title}\n${"=".repeat(Math.min(title.length, 60))}\n\n`;
  const body = contentToPlainText(note.content);
  if (body) out += `${body}\n\n`;
  if (note.type === "checklist") {
    const items = await getChecklist(note.id);
    for (const i of items) out += `[${i.isCompleted ? "x" : " "}] ${i.text}\n`;
  }
  return out.trim() + "\n";
}

async function noteToMd(note: Note): Promise<string> {
  let out = `# ${(note.title || "Untitled").replace(/\n+/g, " ").trim()}\n\n`;
  const body = contentToMarkdown(note.content);
  if (body) out += `${body}\n\n`;
  if (note.type === "checklist") {
    const items = await getChecklist(note.id);
    for (const i of items) out += `- [${i.isCompleted ? "x" : " "}] ${i.text}\n`;
  }
  return out.trim() + "\n";
}

async function noteToHtml(note: Note): Promise<string> {
  const body = toHtml(note.content); // already sanitized subset
  let checklistHtml = "";
  if (note.type === "checklist") {
    const items = await getChecklist(note.id);
    checklistHtml =
      "<ul style='list-style:none;padding-left:0'>" +
      items
        .map(
          (i) =>
            `<li style='margin:6px 0'>${i.isCompleted ? "\u2611" : "\u2610"} <span style='${
              i.isCompleted ? "text-decoration:line-through;color:#999" : ""
            }'>${escapeHtml(i.text)}</span></li>`,
        )
        .join("") +
      "</ul>";
  }
  const date = new Date(note.updatedAt).toLocaleString();
  return `
    <div style="margin-bottom:36px;page-break-inside:avoid">
      <h1 style="font-size:22px;margin:0 0 4px 0;color:#181715">${escapeHtml(note.title || "Untitled")}</h1>
      <div style="font-size:12px;color:#8A8781;margin-bottom:12px">${date}</div>
      <div class="note" style="font-size:15px;line-height:1.6;color:#333">${body}</div>
      ${checklistHtml}
    </div>`;
}

/** Web preview fallback: trigger a browser download of the generated file. */
function webDownload(fileName: string, content: string, mime: string): boolean {
  try {
    const doc: any = typeof document !== "undefined" ? document : null;
    if (!doc) return false;
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement("a");
    a.href = url;
    a.download = fileName;
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Export notes as TXT / Markdown / PDF and hand the file to the OS share
 * sheet (save to Drive, send via WhatsApp, …). Throws on real failures.
 */
export async function exportNotes(notes: Note[], format: ExportFormat): Promise<ExportResult> {
  if (!notes.length) return "empty";
  const available = await Sharing.isAvailableAsync().catch(() => false);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const single = notes.length === 1;
  const base = single ? safeBase(notes[0].title, "note") : `notes_${stamp}`;

  if (format === "pdf") {
    const parts = await Promise.all(notes.map(noteToHtml));
    const html = `<html><head><meta charset="utf-8"/>
      <style>
        .note h1{font-size:24px;margin:12px 0 6px}.note h2{font-size:20px;margin:10px 0 4px}.note h3{font-size:17px;margin:8px 0 4px}
        .note ul,.note ol{margin:4px 0;padding-left:24px}.note mark{background:#FFE58A}.note blockquote{border-left:3px solid #E27429;margin:6px 0;padding-left:10px;color:#666}
      </style></head>
      <body style="font-family:-apple-system,Roboto,sans-serif;padding:32px">
      ${parts.join('<hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>')}
      </body></html>`;
    if (Platform.OS === "web") {
      await Print.printAsync({ html });
      return "shared";
    }
    const { uri } = await Print.printToFileAsync({ html });
    if (!available) return "unavailable";
    await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: "Export notes", UTI: "com.adobe.pdf" });
    return "shared";
  }

  const isMd = format === "md";
  const parts = await Promise.all(notes.map((n) => (isMd ? noteToMd(n) : noteToTxt(n))));
  const content = parts.join(isMd ? "\n\n---\n\n" : "\n\n----------\n\n");
  const fileName = `${base}.${isMd ? "md" : "txt"}`;
  const mime = isMd ? "text/markdown" : "text/plain";

  if (Platform.OS === "web") {
    return webDownload(fileName, content, mime) ? "shared" : "unavailable";
  }

  const fileUri = await writeCacheFile(fileName, content);
  if (!available) return "unavailable";
  await Sharing.shareAsync(fileUri, {
    mimeType: mime,
    dialogTitle: isMd ? "Export as Markdown" : "Export notes",
    UTI: isMd ? "net.daringfireball.markdown" : "public.plain-text",
  });
  return "shared";
}
