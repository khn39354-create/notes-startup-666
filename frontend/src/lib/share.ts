import { Platform, Share } from "react-native";
import * as Sharing from "expo-sharing";

import { ChecklistItem, Note } from "../db/types";
import { contentToPlainText } from "./richtext";
import { logError, sleep } from "./errors";

/**
 * Build a clean, plain-text representation of a note (rich formatting is
 * flattened to readable text: headings, "•" bullets, "1." numbering).
 */
export function buildNoteText(
  note: Pick<Note, "title" | "content" | "type">,
  items: ChecklistItem[] = [],
): string {
  const parts: string[] = [];
  const title = (note.title || "").trim();
  if (title) parts.push(title);

  if (note.type === "checklist") {
    const lines = items
      .map((i) => `${i.isCompleted ? "\u2611" : "\u2610"} ${(i.text || "").trim()}`.trimEnd())
      .filter((l) => l.length > 1);
    if (lines.length) parts.push(lines.join("\n"));
  } else {
    const body = contentToPlainText(note.content);
    if (body) parts.push(body);
  }

  return parts.join("\n\n").trim();
}

export type ShareTextResult = "shared" | "dismissed" | "empty" | "unavailable";

/**
 * Share note text via the native OS share sheet (WhatsApp, Telegram, Gmail,
 * Messages, …). Throws on real failures so the caller can show feedback.
 */
export async function shareNoteAsText(
  note: Pick<Note, "title" | "content" | "type">,
  items: ChecklistItem[] = [],
): Promise<ShareTextResult> {
  const message = buildNoteText(note, items);
  if (!message) return "empty";
  const title = (note.title || "Note").trim() || "Note";

  if (Platform.OS === "web") {
    const nav: any = typeof navigator !== "undefined" ? navigator : null;
    if (nav?.share) {
      try {
        await nav.share({ title, text: message });
        return "shared";
      } catch (e: any) {
        if (e?.name === "AbortError") return "dismissed";
        throw e;
      }
    }
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(message);
      return "unavailable"; // copied instead (web preview only)
    }
    return "unavailable";
  }

  // Android ignores `title`; pass the subject/dialog title via options.
  const result = await Share.share(
    Platform.OS === "ios" ? { message, title } : { message, title },
    Platform.OS === "android" ? { dialogTitle: "Share note", subject: title } : { subject: title },
  );
  if (result.action === Share.dismissedAction) return "dismissed";
  return "shared";
}

/**
 * Share a generated image file (PNG) with the OS share sheet.
 * Returns false when sharing is unavailable on this platform (web).
 */
export async function shareImageFile(uri: string): Promise<boolean> {
  const available = await Sharing.isAvailableAsync().catch(() => false);
  if (!available) return false;
  await Sharing.shareAsync(uri, {
    mimeType: "image/png",
    dialogTitle: "Share note",
    UTI: "public.png",
  });
  return true;
}

/**
 * Bottom-sheet modals must be fully dismissed before Android will launch a
 * share intent; otherwise the intent is silently cancelled. Await this after
 * hiding a sheet and before calling any native share/export API.
 */
export async function waitForSheetDismiss(): Promise<void> {
  await sleep(Platform.OS === "android" ? 450 : 350);
}

export function describeShareError(e: unknown): string {
  logError("share", e);
  const m = e instanceof Error ? e.message.toLowerCase() : "";
  if (m.includes("not available") || m.includes("unavailable")) return "Sharing isn't available on this device.";
  if (m.includes("permission")) return "Permission needed to share. Check app permissions in Settings.";
  return "Couldn't open the share sheet. Please try again.";
}
