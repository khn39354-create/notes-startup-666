// Web implementation of the rich-text editor. react-native-webview has no web
// target, so the SAME editor document is hosted in an iframe (via srcDoc) and
// driven with postMessage. This file is only bundled for the web preview.
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { View } from "react-native";

import { logError } from "@/src/lib/errors";
import { EDITOR_HTML, RichTextEditorHandle, RichTextEditorProps } from "./editorHtml";

export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(function RichTextEditor(
  { initialHtml, onChange, onState, onCaret, onFocus, onBlur, placeholder, theme, minHeight = 220, testID },
  ref,
) {
  const frame = useRef<any>(null);
  const [height, setHeight] = useState(minHeight);
  const initialRef = useRef(initialHtml);
  const readyRef = useRef(false);

  const send = useCallback((cmd: Record<string, unknown>) => {
    try {
      frame.current?.contentWindow?.postMessage(JSON.stringify(cmd), "*");
    } catch (e) {
      logError("RichTextEditor.web", e);
    }
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

  useEffect(() => {
    if (readyRef.current) send({ type: "setTheme", ...theme });
  }, [theme, send]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      let msg: any;
      try {
        msg = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      switch (msg?.type) {
        case "ready":
          readyRef.current = true;
          send({ type: "setTheme", ...theme });
          if (placeholder) send({ type: "setPlaceholder", text: placeholder });
          send({ type: "setHTML", html: initialRef.current || "" });
          break;
        case "change":
          onChange(typeof msg.html === "string" ? msg.html : "");
          break;
        case "height":
          if (typeof msg.height === "number") setHeight(Math.max(minHeight, msg.height));
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
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChange, onState, onCaret, onFocus, onBlur, placeholder, minHeight, send]);

  const h = Math.max(minHeight, height);
  return (
    <View style={{ minHeight, height: h }} testID={testID}>
      {React.createElement("iframe", {
        ref: frame,
        title: "Note editor",
        srcDoc: EDITOR_HTML,
        "data-testid": "rich-editor-frame",
        style: { border: "none", outline: "none", width: "100%", height: h, background: "transparent", display: "block", overflow: "hidden" },
        scrolling: "no",
      })}
    </View>
  );
});
