import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  KeyboardAwareScrollView,
  KeyboardStickyView,
} from "react-native-keyboard-controller";
import {
  useFocusEffect,
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { SvgXml } from "react-native-svg";
import * as ImagePicker from "expo-image-picker";
import * as Linking from "expo-linking";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { captureRef } from "react-native-view-shot";
import dayjs from "dayjs";

import { useApp, useTheme } from "@/src/context/AppContext";
import { useToast } from "@/src/components/Toast";
import { BottomSheet, ConfirmSheet } from "@/src/components/Sheet";
import { ColorPickerSheet, FolderPickerSheet } from "@/src/components/Pickers";
import { LabelPickerSheet } from "@/src/components/LabelPickerSheet";
import { VoiceRecorderSheet } from "@/src/components/VoiceRecorderSheet";
import { AudioPlayer } from "@/src/components/AudioPlayer";
import { ErrorState, InlineError, LoadingState } from "@/src/components/AsyncState";
import { RichTextEditor } from "@/src/components/editor/RichTextEditor";
import {
  EditorCommand,
  EditorFormatState,
  EMPTY_FORMAT_STATE,
  RichTextEditorHandle,
} from "@/src/components/editor/editorHtml";
import { RichTextView } from "@/src/components/RichTextView";
import { noteColorHex } from "@/src/theme/colors";
import {
  addAttachment,
  addChecklistItem,
  createNote,
  deleteAttachment,
  deleteChecklistItem,
  discardIfEmpty,
  getAttachments,
  getChecklist,
  getNote,
  reorderChecklist,
  trashNote,
  updateChecklistItem,
  updateNote,
} from "@/src/db/repo";
import { Attachment, ChecklistItem, NoteType } from "@/src/db/types";
import { copyIntoStore, readTextFile } from "@/src/lib/files";
import { exportNotes, ExportFormat } from "@/src/lib/exporter";
import { contentToLines, isContentBlank, linesToHtml, toHtml } from "@/src/lib/richtext";
import { friendlyMessage, logError, withTimeout } from "@/src/lib/errors";
import {
  buildNoteText,
  describeShareError,
  shareImageFile,
  shareNoteAsText,
  waitForSheetDismiss,
} from "@/src/lib/share";

function extFromUri(uri: string, fallback: string): string {
  const m = uri.split("?")[0].split(".").pop();
  return m && m.length <= 5 ? m.toLowerCase() : fallback;
}

function DrawingThumb({ path, onRemove, onPress }: { path: string; onRemove: () => void; onPress: () => void }) {
  const c = useTheme();
  const [xml, setXml] = useState<string | null>(null);
  useEffect(() => {
    readTextFile(path).then(setXml).catch(() => setXml(null));
  }, [path]);
  return (
    <View style={[styles.thumb, { borderColor: c.border, backgroundColor: "#FFFFFF" }]}>
      <Pressable onPress={onPress} style={{ flex: 1 }} testID="drawing-thumb">
        {xml ? <SvgXml xml={xml} width="100%" height="100%" /> : null}
      </Pressable>
      <Pressable onPress={onRemove} style={[styles.thumbRemove, { backgroundColor: c.surfaceInverse }]} testID="remove-drawing">
        <MaterialCommunityIcons name="close" size={14} color={c.onSurfaceInverse} />
      </Pressable>
    </View>
  );
}

type LoadStatus = "loading" | "ready" | "notfound" | "error";

export default function Editor() {
  const c = useTheme();
  const { settings, refresh } = useApp();
  const router = useRouter();
  const navigation = useNavigation();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string; type?: string; action?: string }>();

  const [status, setStatus] = useState<LoadStatus>("loading");
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState(""); // sanitized HTML
  const [initialHtml, setInitialHtml] = useState("");
  const [type, setType] = useState<NoteType>("text");
  const [color, setColor] = useState("default");
  const [isPinned, setIsPinned] = useState(0);
  const [isFavorite, setIsFavorite] = useState(0);
  const [isArchived, setIsArchived] = useState(0);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>(new Date().toISOString());
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [, setLabelVersion] = useState(0);
  const [fmt, setFmt] = useState<EditorFormatState>(EMPTY_FORMAT_STATE);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [colorVisible, setColorVisible] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [folderVisible, setFolderVisible] = useState(false);
  const [labelVisible, setLabelVisible] = useState(false);
  const [voiceVisible, setVoiceVisible] = useState(false);
  const [exportVisible, setExportVisible] = useState(false);
  const [shareVisible, setShareVisible] = useState(false);
  const [imageMenuVisible, setImageMenuVisible] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // which action is running

  const editorRef = useRef<RichTextEditorHandle>(null);
  const scrollRef = useRef<any>(null);
  const shareCardRef = useRef<View>(null);
  const noteIdRef = useRef<string | null>(null);
  const titleRef = useRef("");
  const contentRef = useRef("");
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const editorY = useRef(0);
  const scrollY = useRef(0);
  const viewportH = useRef(0);
  const kbH = useRef(0);
  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { contentRef.current = content; }, [content]);

  useEffect(() => {
    const s = Keyboard.addListener("keyboardDidShow", (e) => { kbH.current = e.endCoordinates?.height ?? 0; });
    const h = Keyboard.addListener("keyboardDidHide", () => { kbH.current = 0; });
    return () => { s.remove(); h.remove(); };
  }, []);

  // ---------- load / create ----------
  const load = useCallback(async () => {
    setStatus("loading");
    setLoadMessage(null);
    try {
      if (params.id) {
        const n = await withTimeout(getNote(params.id), 10000, "load note");
        if (!n) {
          setStatus("notfound");
          return;
        }
        setNoteId(n.id);
        noteIdRef.current = n.id;
        setTitle(n.title);
        const html = toHtml(n.content); // legacy Markdown is converted on the fly (not rewritten until edited)
        setContent(html);
        setInitialHtml(html);
        setType(n.type);
        setColor(n.color);
        setIsPinned(n.isPinned);
        setIsFavorite(n.isFavorite);
        setIsArchived(n.isArchived);
        setFolderId(n.folderId);
        setUpdatedAt(n.updatedAt);
        const [cl, at] = await Promise.all([
          getChecklist(n.id).catch(() => [] as ChecklistItem[]),
          getAttachments(n.id).catch(() => [] as Attachment[]),
        ]);
        setItems(cl);
        setAttachments(at);
        setStatus("ready");
      } else {
        const nt = (params.type as NoteType) || "text";
        const n = await withTimeout(createNote({ type: nt, color: settings.defaultColor }), 10000, "create note");
        setNoteId(n.id);
        noteIdRef.current = n.id;
        setType(nt);
        setColor(settings.defaultColor);
        setStatus("ready");
        setTimeout(() => {
          if (params.action === "voice") setVoiceVisible(true);
          else if (params.action === "image") setImageMenuVisible(true);
          else if (params.action === "drawing") router.push({ pathname: "/drawing", params: { noteId: n.id } });
        }, 350);
      }
    } catch (e) {
      logError("Editor.load", e);
      setLoadMessage(friendlyMessage(e, params.id ? "Couldn't open this note." : "Couldn't create a new note."));
      setStatus("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id, params.type, params.action, settings.defaultColor]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (noteIdRef.current) {
        getAttachments(noteIdRef.current).then(setAttachments).catch((e) => logError("Editor.attachments", e));
        getChecklist(noteIdRef.current)
          .then((cl) => { if (type === "checklist" || cl.length) setItems(cl); })
          .catch((e) => logError("Editor.checklist", e));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  // ---------- autosave (only after the user edits) ----------
  const persist = useCallback(async (id: string) => {
    setSaving(true);
    try {
      await withTimeout(updateNote(id, { title: titleRef.current, content: contentRef.current }), 10000, "save");
      setSaveError(null);
      setUpdatedAt(new Date().toISOString());
    } catch (e) {
      logError("Editor.autosave", e);
      setSaveError("Couldn't save your changes.");
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    if (!noteId || status !== "ready" || !dirtyRef.current) return;
    const t = setTimeout(() => persist(noteId), 500);
    return () => clearTimeout(t);
  }, [title, content, noteId, status, persist]);

  useEffect(() => {
    const unsub = navigation.addListener("beforeRemove", () => {
      const id = noteIdRef.current;
      if (!id) return;
      (async () => {
        try {
          if (dirtyRef.current) await updateNote(id, { title: titleRef.current, content: contentRef.current });
          await discardIfEmpty(id);
        } catch (e) {
          logError("Editor.saveOnExit", e);
        }
        refresh();
      })();
    });
    return unsub;
  }, [navigation, refresh]);

  const patch = (fields: any) => {
    if (!noteId) return;
    updateNote(noteId, fields).catch((e) => {
      logError("Editor.patch", e);
      toast.show("Couldn't save change", "error");
    });
  };

  const onChangeTitle = (t: string) => { dirtyRef.current = true; setTitle(t); };
  const onChangeBody = useCallback((html: string) => { dirtyRef.current = true; setContent(html); }, []);

  // Keep the caret visible above the keyboard + toolbar.
  const onCaret = useCallback((bottom: number) => {
    if (Platform.OS === "web") return;
    const abs = editorY.current + bottom;
    const visible = viewportH.current - kbH.current - 64;
    if (visible <= 0) return;
    if (abs > scrollY.current + visible) {
      scrollRef.current?.scrollTo?.({ y: Math.max(0, abs - visible + 40), animated: true });
    } else if (abs - 40 < scrollY.current) {
      scrollRef.current?.scrollTo?.({ y: Math.max(0, abs - 80), animated: true });
    }
  }, []);

  const exec = (cmd: EditorCommand) => {
    editorRef.current?.exec(cmd);
    Haptics.selectionAsync().catch(() => {});
  };

  const togglePin = () => { const v = isPinned ? 0 : 1; setIsPinned(v); patch({ isPinned: v }); Haptics.selectionAsync().catch(() => {}); };
  const toggleFav = () => { const v = isFavorite ? 0 : 1; setIsFavorite(v); patch({ isFavorite: v }); Haptics.selectionAsync().catch(() => {}); };
  const toggleArchive = () => { const v = isArchived ? 0 : 1; setIsArchived(v); patch({ isArchived: v }); toast.show(v ? "Note archived" : "Note unarchived", "success"); };

  /** Run an action once at a time with a friendly error toast. */
  const guard = async (name: string, fn: () => Promise<void>, errMsg?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(name);
    try {
      await withTimeout(fn(), 30000, name);
    } catch (e) {
      logError(`Editor.${name}`, e);
      toast.show(errMsg ?? friendlyMessage(e), "error");
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  // ---------- checklist ----------
  const addItem = () => guard("addItem", async () => {
    if (!noteId) return;
    const it = await addChecklistItem(noteId, "", items.length);
    setItems((p) => [...p, it]);
  }, "Couldn't add item");
  const editItem = (id: string, text: string) => {
    setItems((p) => p.map((i) => (i.id === id ? { ...i, text } : i)));
    updateChecklistItem(id, { text }).catch((e) => { logError("Editor.editItem", e); setSaveError("Couldn't save your changes."); });
  };
  const toggleItem = (id: string) => {
    const it = items.find((i) => i.id === id);
    if (!it) return;
    const v = it.isCompleted ? 0 : 1;
    setItems((p) => p.map((i) => (i.id === id ? { ...i, isCompleted: v } : i)));
    updateChecklistItem(id, { isCompleted: v }).catch((e) => { logError("Editor.toggleItem", e); toast.show("Couldn't save change", "error"); });
  };
  const removeItem = (id: string) => guard("removeItem", async () => {
    await deleteChecklistItem(id);
    setItems((p) => p.filter((i) => i.id !== id));
  }, "Couldn't remove item");
  const moveItem = (index: number, dir: -1 | 1) => guard("moveItem", async () => {
    const next = [...items];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
    await reorderChecklist(next);
  }, "Couldn't reorder items");

  const convertToChecklist = () => guard("convert", async () => {
    if (!noteId) return;
    setMenuVisible(false);
    const lines = contentToLines(content);
    const existing = await getChecklist(noteId);
    for (const e of existing) await deleteChecklistItem(e.id);
    const created: ChecklistItem[] = [];
    let pos = 0;
    for (const line of lines.length ? lines : [""]) {
      const cleaned = line.replace(/^[\u2610\u2611]\s*/, "").replace(/^[-*]\s*\[[ xX]\]\s*/, "");
      created.push(await addChecklistItem(noteId, cleaned, pos++));
    }
    setItems(created);
    setContent("");
    setInitialHtml("");
    setType("checklist");
    await updateNote(noteId, { type: "checklist", content: "" });
  }, "Couldn't convert note");

  const convertToText = () => guard("convert", async () => {
    if (!noteId) return;
    setMenuVisible(false);
    const lines = items.filter((i) => i.text.trim()).map((i) => `${i.isCompleted ? "\u2611" : "\u2610"} ${i.text}`);
    for (const i of items) await deleteChecklistItem(i.id);
    setItems([]);
    const html = (content || "") + linesToHtml(lines);
    setContent(html);
    setInitialHtml(html);
    setType("text");
    await updateNote(noteId, { type: "text", content: html });
  }, "Couldn't convert note");

  // ---------- attachments ----------
  const addImageFrom = (source: "camera" | "library") => guard("image", async () => {
    setImageMenuVisible(false);
    await waitForSheetDismiss();
    const perm = source === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      if (!perm.canAskAgain) { toast.show("Permission denied. Enable it in Settings.", "error"); Linking.openSettings().catch(() => {}); }
      else toast.show("Permission needed to add photos", "error");
      return;
    }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.8 };
    const res = source === "camera"
      ? await ImagePicker.launchCameraAsync(opts)
      : await ImagePicker.launchImageLibraryAsync({ ...opts, allowsMultipleSelection: true, selectionLimit: 10 });
    if (res.canceled || !noteId) return;
    const newAtts: Attachment[] = [];
    for (const asset of res.assets) {
      const saved = await copyIntoStore(asset.uri, extFromUri(asset.uri, "jpg"));
      newAtts.push(await addAttachment(noteId, "image", saved.path, asset.fileName ?? null, saved.size, null));
    }
    setAttachments((p) => [...p, ...newAtts]);
  }, "Could not add image");

  const onVoiceSaved = (uri: string, dur: number) => guard("voice", async () => {
    if (!noteId) return;
    const saved = await copyIntoStore(uri, extFromUri(uri, "m4a"));
    const att = await addAttachment(noteId, "audio", saved.path, null, saved.size, dur);
    setAttachments((p) => [...p, att]);
    if (type === "text" && isContentBlank(content) && !title) { setType("voice"); patch({ type: "voice" }); }
  }, "Could not save recording");

  const removeAttachment = (id: string) => guard("removeAtt", async () => {
    await deleteAttachment(id);
    setAttachments((p) => p.filter((a) => a.id !== id));
  }, "Couldn't remove attachment");

  // ---------- share / export ----------
  const noteIsEmpty = () => !buildNoteText({ title, content, type }, items);

  const doExport = (fmt: ExportFormat) => guard("export", async () => {
    setExportVisible(false);
    setShareVisible(false);
    if (!noteId) return;
    if (noteIsEmpty()) { toast.show("Nothing to export yet", "info"); return; }
    if (dirtyRef.current) await updateNote(noteId, { title: titleRef.current, content: contentRef.current });
    await waitForSheetDismiss();
    const n = await getNote(noteId);
    if (!n) throw new Error("Note not found");
    const r = await exportNotes([n], fmt);
    if (r === "unavailable") toast.show("Sharing isn't available on this device", "error");
  }, "Export failed. Please try again.");

  const doShareText = () => guard("shareText", async () => {
    setShareVisible(false);
    if (noteIsEmpty()) { toast.show("Nothing to share yet", "info"); return; }
    await waitForSheetDismiss();
    try {
      const r = await shareNoteAsText({ title, content, type }, items);
      if (r === "unavailable") toast.show("Sharing isn't available here. Text copied to clipboard.", "info");
    } catch (e) {
      toast.show(describeShareError(e), "error");
    }
  });

  const openPicturePreview = async () => {
    setShareVisible(false);
    if (noteIsEmpty()) { toast.show("Nothing to share yet", "info"); return; }
    await waitForSheetDismiss();
    setPreviewVisible(true);
  };

  const doSharePicture = () => guard("sharePicture", async () => {
    await new Promise((r) => setTimeout(r, 120)); // let the card finish layout
    let uri: string;
    try {
      uri = await captureRef(shareCardRef, { format: "png", quality: 1, result: "tmpfile" });
    } catch (e) {
      logError("Editor.capture", e);
      toast.show(Platform.OS === "web" ? "Image sharing isn't available on web" : "Couldn't create the image. Please try again.", "error");
      return;
    }
    setPreviewVisible(false);
    await waitForSheetDismiss();
    try {
      const ok = await shareImageFile(uri);
      if (!ok) toast.show("Sharing isn't available on this device", "error");
    } catch (e) {
      toast.show(describeShareError(e), "error");
    }
  });

  const deleteNote = () => guard("delete", async () => {
    setConfirmDelete(false);
    setMenuVisible(false);
    if (noteId) {
      await trashNote(noteId);
      noteIdRef.current = null;
      refresh();
    }
    router.back();
  }, "Couldn't move note to trash");

  // ---------- render ----------
  const images = attachments.filter((a) => a.type === "image");
  const audios = attachments.filter((a) => a.type === "audio");
  const drawings = attachments.filter((a) => a.type === "drawing");
  const displayItems = settings.completedToBottom ? [...items].sort((a, b) => a.isCompleted - b.isCompleted) : items;
  const doneCount = items.filter((i) => i.isCompleted).length;
  const bg = noteColorHex(color, c);
  const highlight = c.mode === "dark" ? "#7A5B00" : "#FFE58A";

  if (status !== "ready") {
    return (
      <View style={{ flex: 1, backgroundColor: c.surface, paddingTop: insets.top }}>
        <View style={styles.header}>
          <Pressable testID="editor-back" onPress={() => router.back()} style={styles.hBtn}>
            <MaterialCommunityIcons name="arrow-left" size={24} color={c.onSurface} />
          </Pressable>
        </View>
        {status === "loading" ? (
          <LoadingState label="Opening note…" testID="editor-loading-state" />
        ) : status === "notfound" ? (
          <ErrorState
            title="Note not found"
            message="This note may have been deleted or moved."
            testID="editor-notfound"
            retryLabel="Back to notes"
            onRetry={() => router.back()}
          />
        ) : (
          <ErrorState title="Couldn't open note" message={loadMessage} onRetry={load} secondaryLabel="Go back" onSecondary={() => router.back()} testID="editor-error" />
        )}
      </View>
    );
  }

  const toolbarBtns: { icon: any; cmd: EditorCommand; tid: string; active: boolean }[] = [
    { icon: "format-bold", cmd: "bold", tid: "fmt-bold", active: fmt.bold },
    { icon: "format-italic", cmd: "italic", tid: "fmt-italic", active: fmt.italic },
    { icon: "format-underline", cmd: "underline", tid: "fmt-underline", active: fmt.underline },
    { icon: "format-strikethrough-variant", cmd: "strikeThrough", tid: "fmt-strike", active: fmt.strike },
    { icon: "format-header-1", cmd: "h1", tid: "fmt-heading", active: fmt.h1 },
    { icon: "format-header-2", cmd: "h2", tid: "fmt-heading2", active: fmt.h2 },
    { icon: "format-list-bulleted", cmd: "insertUnorderedList", tid: "fmt-bullet", active: fmt.ul },
    { icon: "format-list-numbered", cmd: "insertOrderedList", tid: "fmt-number", active: fmt.ol },
    { icon: "format-quote-close", cmd: "blockquote", tid: "fmt-quote", active: fmt.quote },
    { icon: "marker", cmd: "mark", tid: "fmt-highlight", active: fmt.mark },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: bg, paddingTop: insets.top }}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable testID="editor-back" onPress={() => router.back()} style={styles.hBtn}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={c.onSurface} />
        </Pressable>
        <View style={styles.hActions}>
          {type !== "checklist" && (
            <>
              <Pressable testID="editor-undo" onPress={() => exec("undo")} disabled={!fmt.canUndo} style={styles.hBtn}>
                <MaterialCommunityIcons name="undo" size={22} color={fmt.canUndo ? c.onSurface : c.muted} />
              </Pressable>
              <Pressable testID="editor-redo" onPress={() => exec("redo")} disabled={!fmt.canRedo} style={styles.hBtn}>
                <MaterialCommunityIcons name="redo" size={22} color={fmt.canRedo ? c.onSurface : c.muted} />
              </Pressable>
            </>
          )}
          <Pressable testID="editor-color" onPress={() => setColorVisible(true)} style={styles.hBtn}>
            <MaterialCommunityIcons name="palette-outline" size={22} color={c.onSurface} />
          </Pressable>
          <Pressable testID="editor-favorite" onPress={toggleFav} style={styles.hBtn}>
            <MaterialCommunityIcons name={isFavorite ? "heart" : "heart-outline"} size={22} color={isFavorite ? c.error : c.onSurface} />
          </Pressable>
          <Pressable testID="editor-pin" onPress={togglePin} style={styles.hBtn}>
            <MaterialCommunityIcons name={isPinned ? "pin" : "pin-outline"} size={22} color={isPinned ? c.brand : c.onSurface} />
          </Pressable>
          <Pressable testID="editor-menu" onPress={() => setMenuVisible(true)} style={styles.hBtn}>
            <MaterialCommunityIcons name="dots-vertical" size={22} color={c.onSurface} />
          </Pressable>
        </View>
      </View>

      <KeyboardAwareScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: 160 }]}
        bottomOffset={80}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; }}
        onLayout={(e) => { viewportH.current = e.nativeEvent.layout.height; }}
        scrollEventThrottle={32}
      >
        <TextInput
          testID="editor-title"
          value={title}
          onChangeText={onChangeTitle}
          placeholder="Title"
          placeholderTextColor={c.muted}
          style={[styles.title, { color: c.onSurface }]}
          multiline
          underlineColorAndroid="transparent"
          returnKeyType="next"
          blurOnSubmit
          onSubmitEditing={() => editorRef.current?.focus()}
        />
        <View style={styles.metaRow}>
          <Text style={[styles.meta, { color: c.muted }]}>
            {dayjs(updatedAt).format("MMM D, YYYY · h:mm A")}
            {doneCount || items.length ? `  ·  ${doneCount}/${items.length} completed` : ""}
          </Text>
          {saving ? <ActivityIndicator size="small" color={c.muted} /> : null}
        </View>

        {saveError ? (
          <InlineError message={saveError} onRetry={() => noteId && persist(noteId)} testID="save-error" />
        ) : null}

        {type === "checklist" ? (
          <View style={styles.checklist}>
            {items.length > 0 && (
              <View style={[styles.progressTrack, { backgroundColor: c.border }]}>
                <View style={[styles.progressFill, { backgroundColor: c.brand, width: `${items.length ? (doneCount / items.length) * 100 : 0}%` }]} />
              </View>
            )}
            {displayItems.map((it) => {
              const index = items.findIndex((i) => i.id === it.id);
              return (
                <View key={it.id} style={styles.itemRow}>
                  <Pressable testID={`check-toggle-${it.id}`} onPress={() => toggleItem(it.id)} style={styles.checkBox} hitSlop={6}>
                    <MaterialCommunityIcons name={it.isCompleted ? "checkbox-marked-circle" : "checkbox-blank-circle-outline"} size={24} color={it.isCompleted ? c.brand : c.muted} />
                  </Pressable>
                  <TextInput
                    testID={`check-input-${it.id}`}
                    value={it.text}
                    onChangeText={(t) => editItem(it.id, t)}
                    placeholder="List item"
                    placeholderTextColor={c.muted}
                    style={[styles.itemInput, { color: it.isCompleted ? c.muted : c.onSurface, textDecorationLine: it.isCompleted ? "line-through" : "none" }]}
                    multiline
                    underlineColorAndroid="transparent"
                  />
                  <View style={styles.itemControls}>
                    <Pressable onPress={() => moveItem(index, -1)} testID={`check-up-${it.id}`} hitSlop={6}>
                      <MaterialCommunityIcons name="chevron-up" size={20} color={c.muted} />
                    </Pressable>
                    <Pressable onPress={() => moveItem(index, 1)} testID={`check-down-${it.id}`} hitSlop={6}>
                      <MaterialCommunityIcons name="chevron-down" size={20} color={c.muted} />
                    </Pressable>
                    <Pressable onPress={() => removeItem(it.id)} testID={`check-del-${it.id}`} hitSlop={6}>
                      <MaterialCommunityIcons name="close" size={18} color={c.muted} />
                    </Pressable>
                  </View>
                </View>
              );
            })}
            <Pressable testID="add-check-item" onPress={addItem} disabled={busy === "addItem"} style={styles.addItemRow}>
              <MaterialCommunityIcons name="plus" size={22} color={c.brand} />
              <Text style={[styles.addItemText, { color: c.brand }]}>Add item</Text>
            </Pressable>
          </View>
        ) : (
          <View onLayout={(e) => { editorY.current = e.nativeEvent.layout.y; }}>
            <RichTextEditor
              ref={editorRef}
              testID="editor-body"
              initialHtml={initialHtml}
              onChange={onChangeBody}
              onState={setFmt}
              onCaret={onCaret}
              placeholder="Start writing…"
              theme={{ fg: c.onSurface, muted: c.muted, brand: c.brand, hl: highlight }}
              minHeight={240}
            />
          </View>
        )}

        {images.length > 0 && (
          <View style={styles.imageGrid}>
            {images.map((a) => (
              <View key={a.id} style={[styles.thumb, { borderColor: c.border }]}>
                <Pressable testID={`image-thumb-${a.id}`} onPress={() => router.push({ pathname: "/image-viewer", params: { uri: a.localPath } })} style={{ flex: 1 }}>
                  <Image source={{ uri: a.localPath }} style={{ flex: 1 }} contentFit="cover" />
                </Pressable>
                <Pressable testID={`remove-image-${a.id}`} onPress={() => removeAttachment(a.id)} style={[styles.thumbRemove, { backgroundColor: c.surfaceInverse }]}>
                  <MaterialCommunityIcons name="close" size={14} color={c.onSurfaceInverse} />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {drawings.length > 0 && (
          <View style={styles.imageGrid}>
            {drawings.map((a) => (
              <DrawingThumb key={a.id} path={a.localPath} onRemove={() => removeAttachment(a.id)} onPress={() => router.push({ pathname: "/drawing", params: { noteId: noteId!, attachmentId: a.id } })} />
            ))}
          </View>
        )}

        {audios.length > 0 && (
          <View style={{ marginTop: 12 }}>
            {audios.map((a) => (
              <AudioPlayer key={a.id} uri={a.localPath} duration={a.duration} onDelete={() => removeAttachment(a.id)} />
            ))}
          </View>
        )}
      </KeyboardAwareScrollView>

      {/* Bottom toolbar (sticks above the keyboard) */}
      <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
        <View style={[styles.toolbar, { backgroundColor: c.surfaceSecondary, borderColor: c.border, paddingBottom: insets.bottom > 0 ? insets.bottom : 8 }]} testID="editor-toolbar">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.toolbarRow} keyboardShouldPersistTaps="always">
            {type !== "checklist" && (
              <>
                {toolbarBtns.map((b) => (
                  <ToolBtn key={b.tid} icon={b.icon} active={b.active} onPress={() => exec(b.cmd)} c={c} tid={b.tid} />
                ))}
                <View style={[styles.toolDivider, { backgroundColor: c.border }]} />
              </>
            )}
            <ToolBtn icon="image-plus" onPress={() => setImageMenuVisible(true)} c={c} tid="attach-image" />
            <ToolBtn icon="microphone-plus" onPress={() => setVoiceVisible(true)} c={c} tid="attach-voice" />
            <ToolBtn icon="draw" onPress={() => noteId && router.push({ pathname: "/drawing", params: { noteId } })} c={c} tid="attach-drawing" />
          </ScrollView>
        </View>
      </KeyboardStickyView>

      {/* Sheets */}
      <ColorPickerSheet visible={colorVisible} current={color} onSelect={(k) => { setColor(k); patch({ color: k }); }} onClose={() => setColorVisible(false)} />
      <FolderPickerSheet visible={folderVisible} currentFolderId={folderId} onSelect={(fid) => { setFolderId(fid); patch({ folderId: fid }); toast.show("Note moved", "success"); }} onClose={() => setFolderVisible(false)} />
      {noteId && (
        <LabelPickerSheet visible={labelVisible} noteId={noteId} onClose={() => setLabelVisible(false)} onChanged={() => { setLabelVersion((v) => v + 1); refresh(); }} />
      )}
      <VoiceRecorderSheet visible={voiceVisible} onClose={() => setVoiceVisible(false)} onSaved={onVoiceSaved} />

      <BottomSheet visible={imageMenuVisible} onClose={() => setImageMenuVisible(false)} title="Add image" testID="image-menu">
        <MenuRow testID="image-camera" icon="camera-outline" label="Take a photo" color={c.brand} textColor={c.onSurface} onPress={() => addImageFrom("camera")} />
        <MenuRow testID="image-library" icon="image-multiple-outline" label="Choose from gallery" color={c.brand} textColor={c.onSurface} onPress={() => addImageFrom("library")} />
      </BottomSheet>

      <BottomSheet visible={menuVisible} onClose={() => setMenuVisible(false)} title="Options" testID="editor-options">
        <MenuRow testID="opt-folder" icon="folder-move-outline" label="Move to folder" color={c.onSurfaceTertiary} textColor={c.onSurface} onPress={() => { setMenuVisible(false); setFolderVisible(true); }} />
        <MenuRow testID="opt-labels" icon="tag-outline" label="Labels" color={c.onSurfaceTertiary} textColor={c.onSurface} onPress={() => { setMenuVisible(false); setLabelVisible(true); }} />
        <MenuRow testID="opt-archive" icon={isArchived ? "archive-arrow-up-outline" : "archive-arrow-down-outline"} label={isArchived ? "Unarchive" : "Archive"} color={c.onSurfaceTertiary} textColor={c.onSurface} onPress={() => { setMenuVisible(false); toggleArchive(); }} />
        {type === "checklist" ? (
          <MenuRow testID="opt-to-text" icon="text" label="Convert to text note" color={c.onSurfaceTertiary} textColor={c.onSurface} onPress={convertToText} />
        ) : (
          <MenuRow testID="opt-to-checklist" icon="checkbox-marked-outline" label="Convert to checklist" color={c.onSurfaceTertiary} textColor={c.onSurface} onPress={convertToChecklist} />
        )}
        <MenuRow testID="opt-share" icon="share-variant-outline" label="Share note" color={c.onSurfaceTertiary} textColor={c.onSurface} onPress={() => { setMenuVisible(false); setShareVisible(true); }} />
        <MenuRow testID="opt-export" icon="export-variant" label="Export" color={c.onSurfaceTertiary} textColor={c.onSurface} onPress={() => { setMenuVisible(false); setExportVisible(true); }} />
        <MenuRow testID="opt-delete" icon="trash-can-outline" label="Move to trash" color={c.error} textColor={c.error} onPress={() => { setMenuVisible(false); setConfirmDelete(true); }} />
      </BottomSheet>

      <BottomSheet visible={exportVisible} onClose={() => setExportVisible(false)} title="Export as" testID="editor-export-sheet">
        {(["txt", "md", "pdf"] as ExportFormat[]).map((fmtKey) => (
          <MenuRow key={fmtKey} testID={`editor-export-${fmtKey}`} icon={fmtKey === "pdf" ? "file-pdf-box" : fmtKey === "md" ? "language-markdown" : "file-document-outline"} label={fmtKey.toUpperCase()} color={c.brand} textColor={c.onSurface} onPress={() => doExport(fmtKey)} />
        ))}
      </BottomSheet>

      <BottomSheet visible={shareVisible} onClose={() => setShareVisible(false)} title="Share note" testID="editor-share-sheet">
        <MenuRow testID="share-as-text" icon="text-box-outline" label="Share as text" sub="WhatsApp, Telegram, Gmail, Messages…" color={c.brand} textColor={c.onSurface} subColor={c.muted} onPress={doShareText} />
        <MenuRow testID="share-as-picture" icon="image-outline" label="Share as picture" sub="Formatted note as an image" color={c.brand} textColor={c.onSurface} subColor={c.muted} onPress={openPicturePreview} />
        <MenuRow testID="share-as-markdown" icon="language-markdown" label="Export as Markdown" sub="Save or send a .md file" color={c.brand} textColor={c.onSurface} subColor={c.muted} onPress={() => doExport("md")} />
      </BottomSheet>

      <ConfirmSheet visible={confirmDelete} title="Move to trash?" message="You can restore it from Trash later." confirmLabel="Move to trash" destructive onCancel={() => setConfirmDelete(false)} onConfirm={deleteNote} />

      {/* Share-as-picture preview: the card is rendered ON SCREEN so capture is reliable on Android. */}
      <Modal visible={previewVisible} animationType="slide" onRequestClose={() => setPreviewVisible(false)} statusBarTranslucent>
        <View style={[styles.previewRoot, { backgroundColor: c.surface, paddingTop: insets.top }]} testID="share-preview">
          <View style={styles.header}>
            <Pressable testID="preview-close" onPress={() => setPreviewVisible(false)} style={styles.hBtn} disabled={busy === "sharePicture"}>
              <MaterialCommunityIcons name="close" size={24} color={c.onSurface} />
            </Pressable>
            <Text style={[styles.previewTitle, { color: c.onSurface }]}>Share as picture</Text>
            <View style={{ width: 40 }} />
          </View>
          <ScrollView contentContainerStyle={styles.previewScroll} showsVerticalScrollIndicator={false}>
            <View ref={shareCardRef} collapsable={false} style={[styles.shareCard, { backgroundColor: bg }]} testID="share-card">
              <View style={styles.shareCardHeader}>
                <View style={[styles.shareLogo, { backgroundColor: c.brand }]}>
                  <MaterialCommunityIcons name="notebook" size={16} color={c.onBrand} />
                </View>
                <Text style={[styles.shareBrand, { color: c.muted }]}>Notes</Text>
              </View>
              {title.trim() ? <Text style={[styles.shareTitle, { color: c.onSurface }]}>{title.trim()}</Text> : null}
              {type === "checklist" ? (
                items.filter((i) => i.text.trim()).map((i) => (
                  <View key={i.id} style={styles.shareCheckRow}>
                    <MaterialCommunityIcons name={i.isCompleted ? "checkbox-marked-circle" : "checkbox-blank-circle-outline"} size={18} color={i.isCompleted ? c.brand : c.muted} />
                    <Text style={[styles.shareCheckText, { color: i.isCompleted ? c.muted : c.onSurface, textDecorationLine: i.isCompleted ? "line-through" : "none" }]}>{i.text.trim()}</Text>
                  </View>
                ))
              ) : (
                <RichTextView content={content} color={c.onSurface} mutedColor={c.muted} highlightColor={highlight} />
              )}
              <Text style={[styles.shareFooter, { color: c.muted }]}>{dayjs(updatedAt).format("MMM D, YYYY")}</Text>
            </View>
          </ScrollView>
          <View style={[styles.previewFooter, { paddingBottom: insets.bottom + 12, borderColor: c.border, backgroundColor: c.surfaceSecondary }]}>
            <Pressable testID="preview-share" onPress={doSharePicture} disabled={busy === "sharePicture"} style={[styles.primaryBtn, { backgroundColor: c.brand, opacity: busy === "sharePicture" ? 0.7 : 1 }]}>
              {busy === "sharePicture" ? <ActivityIndicator color={c.onBrand} /> : <MaterialCommunityIcons name="share-variant" size={20} color={c.onBrand} />}
              <Text style={[styles.primaryBtnText, { color: c.onBrand }]}>{busy === "sharePicture" ? "Preparing image…" : "Share image"}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {busy && busy !== "sharePicture" && busy !== "addItem" && busy !== "moveItem" ? (
        <View style={styles.busyOverlay} pointerEvents="auto" testID="editor-busy">
          <View style={[styles.busyBox, { backgroundColor: c.surfaceSecondary }]}>
            <ActivityIndicator color={c.brand} />
            <Text style={[styles.busyText, { color: c.onSurface }]}>Working…</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ToolBtn({ icon, onPress, c, tid, active }: { icon: any; onPress: () => void; c: any; tid: string; active?: boolean }) {
  return (
    <Pressable testID={tid} onPress={onPress} style={[styles.toolBtn, active && { backgroundColor: c.brandTertiary }]} accessibilityState={{ selected: !!active }} hitSlop={2}>
      <MaterialCommunityIcons name={icon} size={22} color={active ? c.brand : c.onSurface} />
    </Pressable>
  );
}

function MenuRow({ icon, label, sub, color, textColor, subColor, onPress, testID }: { icon: any; label: string; sub?: string; color: string; textColor: string; subColor?: string; onPress: () => void; testID: string }) {
  return (
    <Pressable testID={testID} onPress={onPress} style={styles.menuRow}>
      <MaterialCommunityIcons name={icon} size={22} color={color} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.menuText, { color: textColor }]}>{label}</Text>
        {sub ? <Text style={[styles.menuSub, { color: subColor }]}>{sub}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, height: 52 },
  hBtn: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  hActions: { flexDirection: "row", alignItems: "center" },
  content: { paddingHorizontal: 20, paddingTop: 8 },
  title: { fontSize: 26, fontWeight: "800", padding: 0, marginBottom: 4, borderWidth: 0 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  meta: { fontSize: 12 },
  checklist: { marginTop: 4 },
  progressTrack: { height: 4, borderRadius: 2, overflow: "hidden", marginBottom: 16 },
  progressFill: { height: 4, borderRadius: 2 },
  itemRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 6 },
  checkBox: { paddingTop: 4 },
  itemInput: { flex: 1, fontSize: 16, paddingVertical: 4, minHeight: 32 },
  itemControls: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 6 },
  addItemRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12, marginTop: 4 },
  addItemText: { fontSize: 15, fontWeight: "600" },
  imageGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 16 },
  thumb: { width: 100, height: 100, borderRadius: 12, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  thumbRemove: { position: "absolute", top: 4, right: 4, width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  toolbar: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6 },
  toolbarRow: { paddingHorizontal: 10, gap: 2, alignItems: "center" },
  toolBtn: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  toolDivider: { width: StyleSheet.hairlineWidth, height: 26, marginHorizontal: 6 },
  menuRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 13, minHeight: 48 },
  menuText: { fontSize: 15, fontWeight: "500" },
  menuSub: { fontSize: 12, marginTop: 2 },
  previewRoot: { flex: 1 },
  previewTitle: { fontSize: 17, fontWeight: "700" },
  previewScroll: { padding: 16, paddingBottom: 40 },
  previewFooter: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  primaryBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, height: 52, borderRadius: 16 },
  primaryBtnText: { fontSize: 16, fontWeight: "700" },
  shareCard: { width: "100%", maxWidth: 480, alignSelf: "center", padding: 24, borderRadius: 20 },
  shareCardHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 },
  shareLogo: { width: 28, height: 28, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  shareBrand: { fontSize: 14, fontWeight: "700" },
  shareTitle: { fontSize: 22, fontWeight: "800", marginBottom: 12 },
  shareCheckRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 8 },
  shareCheckText: { flex: 1, fontSize: 16, lineHeight: 22 },
  shareFooter: { fontSize: 12, marginTop: 20 },
  busyOverlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.2)", zIndex: 2000 },
  busyBox: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 22, paddingVertical: 16, borderRadius: 16 },
  busyText: { fontSize: 15, fontWeight: "600" },
});
