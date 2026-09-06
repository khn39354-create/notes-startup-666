import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView, WebViewMessageEvent } from "react-native-webview";

import { logError } from "@/src/lib/errors";
import { EDITOR_HTML, RichTextEditorHandle, RichTextEditorProps } from "./editorHtml";

/**
 * Native rich-text editor: the shared editor document runs inside a WebView
 * that auto-sizes to its content so it can live inside the screen's scroll
 * view. Never shows raw HTML/Markdown to the user.
 */
export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(function RichTextEditor(
  { initialHtml, onChange, onState, onCaret, onFocus, onBlur, placeholder, theme, minHeight = 220, testID },
  ref,
) {
  const web = useRef<WebView>(null);
  const [height, setHeight] = useState(minHeight);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const initialRef = useRef(initialHtml);
  const readyRef = useRef(false);

  const send = useCallback((cmd: Record<string, unknown>) => {
    const js = `window.handleCommand && window.handleCommand(${JSON.stringify(JSON.stringify(cmd))}); true;`;
    web.current?.injectJavaScript(js);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      exec: (name, value) => send({ type: "exec", name, value }),
      setHTML: (html) => {
        initialRef.current = html;
        send({ type: "setHTML", html });
      },
      focus: () => send({ type: "focus" }),
      blur: () => send({ type: "blur" }),
    }),
    [send],
  );

  // Theme updates (light/dark or note colour changes) while mounted.
  useEffect(() => {
    if (readyRef.current) send({ type: "setTheme", ...theme });
  }, [theme, send]);

  // Loading watchdog: never leave the user staring at a spinner.
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => {
      if (!readyRef.current) setFailed(true);
    }, 8000);
    return () => clearTimeout(t);
  }, [ready, attempt]);

  const onMessage = (e: WebViewMessageEvent) => {
    let msg: any;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case "ready":
        readyRef.current = true;
        setReady(true);
        setFailed(false);
        send({ type: "setTheme", ...theme });
        if (placeholder) send({ type: "setPlaceholder", text: placeholder });
        send({ type: "setHTML", html: initialRef.current || "" });
        break;
      case "change":
        onChange(typeof msg.html === "string" ? msg.html : "");
        break;
      case "height":
        if (typeof msg.height === "number" && msg.height > 0) setHeight(Math.max(minHeight, msg.height));
        break;
      case "state":
        onState?.(msg.state);
        break;
      case "caret":
        if (typeof msg.bottom === "number") onCaret?.(msg.bottom);
        break;
      case "focus":
        onFocus?.();
        break;
      case "blur":
        onBlur?.();
        break;
      case "error":
        logError("RichTextEditor(web)", msg.message);
        break;
    }
  };

  const retry = () => {
    readyRef.current = false;
    setFailed(false);
    setReady(false);
    setAttempt((a) => a + 1);
  };

  return (
    <View style={{ minHeight, height: Math.max(minHeight, height) }} testID={testID}>
      {!failed && (
        <WebView
          key={attempt}
          ref={web}
          originWhitelist={["*"]}
          source={{ html: EDITOR_HTML, baseUrl: "" }}
          onMessage={onMessage}
          onError={(ev) => {
            logError("RichTextEditor", ev.nativeEvent.description);
            setFailed(true);
          }}
          onRenderProcessGone={() => setFailed(true)}
          onContentProcessDidTerminate={() => setFailed(true)}
          javaScriptEnabled
          domStorageEnabled={false}
          scrollEnabled={false}
          nestedScrollEnabled={false}
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          overScrollMode="never"
          bounces={false}
          hideKeyboardAccessoryView
          keyboardDisplayRequiresUserAction={false}
          setSupportMultipleWindows={false}
          textZoom={100}
          automaticallyAdjustContentInsets={false}
          style={[styles.web, { height: Math.max(minHeight, height) }]}
          containerStyle={styles.transparent}
        />
      )}
      {!ready && !failed && (
        <View style={styles.overlay} pointerEvents="none" testID="editor-loading">
          <ActivityIndicator color={theme.brand} />
        </View>
      )}
      {failed && (
        <View style={styles.failed} testID="editor-failed">
          <Text style={[styles.failedText, { color: theme.muted }]}>The editor couldn't load.</Text>
          <Pressable onPress={retry} style={[styles.retryBtn, { backgroundColor: theme.brand }]} testID="editor-failed-retry">
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  // opacity 0.99 forces Android to honour a transparent WebView background.
  web: { backgroundColor: "transparent", opacity: 0.99 },
  transparent: { backgroundColor: "transparent" },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "flex-start", paddingTop: 24 },
  failed: { paddingVertical: 24, alignItems: "center", gap: 12 },
  failedText: { fontSize: 14 },
  retryBtn: { paddingHorizontal: 20, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  retryText: { color: "#fff", fontWeight: "700" },
});
