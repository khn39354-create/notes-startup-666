/**
 * Rich-text utilities. Notes are stored as a small, sanitized HTML subset
 * produced by the in-app editor:
 *   blocks : div, p, h1, h2, h3, ul, ol, li, blockquote, br
 *   inline : b, i, u, s, mark
 *
 * Legacy notes (written before the rich editor) used lightweight Markdown
 * markers (**bold**, *italic*, <u>, ~~strike~~, ==mark==, "# ", "- ", "1. ").
 * `toHtml()` converts those on the fly so nothing is ever corrupted; the DB
 * row is only rewritten when the user actually edits the note.
 *
 * Everything here is pure string processing (no DOM) so it runs on native.
 */

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  mark?: boolean;
}

export type BlockType = "p" | "h1" | "h2" | "h3" | "li" | "quote";

export interface Block {
  type: BlockType;
  runs: Run[];
  ordered?: boolean;
  index?: number; // 1-based for ordered lists
}

// ---------- detection ----------

const BLOCK_TAG_RE = /<(div|p|h[1-6]|ul|ol|li|br|blockquote)\b/i;

export function isHtml(content: string): boolean {
  return BLOCK_TAG_RE.test(content || "");
}

// ---------- entities ----------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

// ---------- legacy markdown -> html ----------

function inlineMdToHtml(line: string): string {
  // Protect legacy <u> tags before escaping.
  let s = line.replace(/<u>/gi, "\u0001").replace(/<\/u>/gi, "\u0002");
  s = escapeHtml(s);
  s = s.replace(/\u0001/g, "<u>").replace(/\u0002/g, "</u>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__(.+?)__/g, "<b>$1</b>");
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");
  s = s.replace(/==(.+?)==/g, "<mark>$1</mark>");
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, "$1<i>$2</i>");
  return s;
}

export function markdownToHtml(md: string): string {
  const lines = (md || "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      closeList();
      const lvl = m[1].length;
      out.push(`<h${lvl}>${inlineMdToHtml(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/))) {
      if (list !== "ul") {
        closeList();
        list = "ul";
        out.push("<ul>");
      }
      const box = m[1].trim() ? "\u2611 " : "\u2610 ";
      out.push(`<li>${box}${inlineMdToHtml(m[2])}</li>`);
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      if (list !== "ul") {
        closeList();
        list = "ul";
        out.push("<ul>");
      }
      out.push(`<li>${inlineMdToHtml(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== "ol") {
        closeList();
        list = "ol";
        out.push("<ol>");
      }
      out.push(`<li>${inlineMdToHtml(m[1])}</li>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      closeList();
      out.push(`<blockquote>${inlineMdToHtml(m[1])}</blockquote>`);
    } else if (line.trim() === "") {
      closeList();
      out.push("<div><br></div>");
    } else {
      closeList();
      out.push(`<div>${inlineMdToHtml(line)}</div>`);
    }
  }
  closeList();
  // Trim trailing empty blocks.
  while (out.length && out[out.length - 1] === "<div><br></div>") out.pop();
  return out.join("");
}

/** Normalize any stored content into editor HTML (never throws). */
export function toHtml(content: string | null | undefined): string {
  const c = content ?? "";
  if (!c.trim()) return "";
  try {
    return isHtml(c) ? sanitizeHtml(c) : markdownToHtml(c);
  } catch {
    return `<div>${escapeHtml(c)}</div>`;
  }
}

// ---------- lightweight sanitizer (defense in depth; editor sanitizes too) ----------

const ALLOWED = new Set([
  "b", "i", "u", "s", "mark", "h1", "h2", "h3", "ul", "ol", "li", "div", "p", "br", "blockquote",
]);
const RENAME: Record<string, string> = { strong: "b", em: "i", strike: "s", del: "s", h4: "h3", h5: "h3", h6: "h3" };

export function sanitizeHtml(html: string): string {
  let s = (html || "").replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  return s.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (full, rawTag: string, attrs: string) => {
    const closing = full.startsWith("</");
    let tag = rawTag.toLowerCase();
    if (RENAME[tag]) tag = RENAME[tag];
    if (tag === "span" || tag === "font") {
      // Highlight produced by execCommand(hiliteColor) -> <mark>
      if (!closing && /background(-color)?\s*:/i.test(attrs)) return "<mark>";
      return closing ? "</mark>" : ""; // best effort; unmatched close is ignored by tokenizer
    }
    if (!ALLOWED.has(tag)) return "";
    if (tag === "br") return "<br>";
    return closing ? `</${tag}>` : `<${tag}>`;
  });
}

// ---------- tokenizer -> blocks ----------

interface Style {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  mark?: boolean;
}

const BLOCK_TAGS = new Set(["div", "p", "h1", "h2", "h3", "li", "blockquote"]);

export function htmlToBlocks(html: string): Block[] {
  const src = sanitizeHtml(html || "");
  const blocks: Block[] = [];
  const styleStack: Style[] = [{}];
  const listStack: { ordered: boolean; counter: number }[] = [];
  let current: Block | null = null;
  let currentType: BlockType = "p";
  let liDivDepth = 0;

  const ensureBlock = () => {
    if (!current) {
      current = { type: currentType, runs: [] };
      if (currentType === "li") {
        const top = listStack[listStack.length - 1];
        current.ordered = top?.ordered ?? false;
        if (top) current.index = ++top.counter;
      }
      blocks.push(current);
    }
    return current;
  };
  const endBlock = () => {
    current = null;
    currentType = "p";
  };
  const pushText = (text: string) => {
    if (!text) return;
    const b = ensureBlock();
    const st = styleStack[styleStack.length - 1];
    const last = b.runs[b.runs.length - 1];
    if (last && sameStyle(last, st)) last.text += text;
    else b.runs.push({ text, ...st });
  };

  const re = /<\/?([a-zA-Z0-9]+)[^>]*>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[2] !== undefined) {
      const text = decodeEntities(m[2]).replace(/[\r\n\t]+/g, " ");
      if (text.trim() === "" && !current) continue; // whitespace between blocks
      pushText(text);
      continue;
    }
    const closing = m[0].startsWith("</");
    const tag = m[1].toLowerCase();
    const cur = (): Block | null => current;
    if (tag === "br") {
      // Line break inside a block -> start a new block of the same kind.
      const c0 = cur();
      const wasEmpty = !c0 || c0.runs.length === 0;
      const type: BlockType = currentType;
      if (wasEmpty) ensureBlock(); // explicit empty line
      current = null;
      currentType = type === "li" ? "p" : type;
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      endBlock();
      if (!closing) listStack.push({ ordered: tag === "ol", counter: 0 });
      else listStack.pop();
      liDivDepth = 0;
      continue;
    }
    if (BLOCK_TAGS.has(tag)) {
      const c1 = cur();
      // <div>/<p> nested inside a list item: keep the list item, ignore the wrapper.
      if ((tag === "div" || tag === "p") && (c1?.type === "li" || (liDivDepth > 0 && closing))) {
        liDivDepth += closing ? -1 : 1;
        if (liDivDepth < 0) liDivDepth = 0;
        continue;
      }
      if (!closing) {
        if (c1 && c1.runs.length === 0 && c1.type !== "li" && tag !== "li") blocks.pop(); // drop wrapper-only block
        current = null;
        currentType = tag === "div" || tag === "p" ? "p" : tag === "blockquote" ? "quote" : (tag as BlockType);
        if (tag === "li" && listStack.length === 0) listStack.push({ ordered: false, counter: 0 });
        if (tag === "li") ensureBlock();
      } else {
        endBlock();
      }
      continue;
    }
    const styleKey =
      tag === "b" ? "bold" : tag === "i" ? "italic" : tag === "u" ? "underline" : tag === "s" ? "strike" : tag === "mark" ? "mark" : null;
    if (styleKey) {
      if (!closing) styleStack.push({ ...styleStack[styleStack.length - 1], [styleKey]: true });
      else if (styleStack.length > 1) styleStack.pop();
    }
  }
  // Drop trailing empty paragraphs.
  while (blocks.length && blocks[blocks.length - 1].runs.length === 0 && blocks[blocks.length - 1].type === "p") blocks.pop();
  return blocks;
}

function sameStyle(a: Style, b: Style): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline && !!a.strike === !!b.strike && !!a.mark === !!b.mark;
}

// ---------- converters ----------

export function blocksToPlainText(blocks: Block[]): string {
  return blocks
    .map((b) => {
      const text = b.runs.map((r) => r.text).join("");
      if (b.type === "li") return b.ordered ? `${b.index ?? 1}. ${text}` : `\u2022 ${text}`;
      if (b.type === "quote") return `\u201C${text}\u201D`;
      return text;
    })
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Plain text for previews, search and "share as text" (handles legacy too). */
export function contentToPlainText(content: string | null | undefined): string {
  const c = content ?? "";
  if (!c.trim()) return "";
  try {
    return blocksToPlainText(htmlToBlocks(toHtml(c)));
  } catch {
    return c.replace(/<[^>]+>/g, "").trim();
  }
}

function runToMd(r: Run): string {
  if (!r.text) return "";
  // Keep surrounding whitespace outside the markers so Markdown stays valid.
  const lead = r.text.match(/^\s*/)?.[0] ?? "";
  const trail = r.text.match(/\s*$/)?.[0] ?? "";
  let core = r.text.trim();
  if (!core) return r.text;
  if (r.mark) core = `==${core}==`;
  if (r.strike) core = `~~${core}~~`;
  if (r.underline) core = `<u>${core}</u>`;
  if (r.italic) core = `*${core}*`;
  if (r.bold) core = `**${core}**`;
  return lead + core + trail;
}

export function blocksToMarkdown(blocks: Block[]): string {
  const lines: string[] = [];
  let prevList = false;
  blocks.forEach((b) => {
    const inline = b.runs.map(runToMd).join("");
    const isList = b.type === "li";
    if (prevList && !isList && lines.length && lines[lines.length - 1] !== "") lines.push("");
    switch (b.type) {
      case "h1":
        lines.push(`# ${inline}`);
        break;
      case "h2":
        lines.push(`## ${inline}`);
        break;
      case "h3":
        lines.push(`### ${inline}`);
        break;
      case "li":
        lines.push(b.ordered ? `${b.index ?? 1}. ${inline}` : `- ${inline}`);
        break;
      case "quote":
        lines.push(`> ${inline}`);
        break;
      default:
        lines.push(inline);
    }
    if (!isList && b.type !== "p") lines.push("");
    else if (!isList && inline.trim()) lines.push("");
    prevList = isList;
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Valid Markdown for export (handles legacy content too). */
export function contentToMarkdown(content: string | null | undefined): string {
  const c = content ?? "";
  if (!c.trim()) return "";
  try {
    return blocksToMarkdown(htmlToBlocks(toHtml(c)));
  } catch {
    return c;
  }
}

/** True when the content has no visible text at all (e.g. "<div><br></div>"). */
export function isContentBlank(content: string | null | undefined): boolean {
  return contentToPlainText(content).trim().length === 0;
}

/** Plain-text lines (used when converting a note into a checklist). */
export function contentToLines(content: string | null | undefined): string[] {
  return contentToPlainText(content)
    .split("\n")
    .map((l) => l.replace(/^(\u2022|\d+\.)\s+/, "").trim())
    .filter(Boolean);
}

/** Wrap plain lines into editor HTML. */
export function linesToHtml(lines: string[]): string {
  return lines.map((l) => `<div>${escapeHtml(l) || "<br>"}</div>`).join("");
}
