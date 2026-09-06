import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

import { Block, htmlToBlocks, Run, toHtml } from "@/src/lib/richtext";

interface Props {
  content: string;
  color: string;
  mutedColor: string;
  highlightColor?: string;
  fontSize?: number;
  testID?: string;
}

/**
 * Renders stored note HTML with native <Text> spans (bold/italic/underline/
 * strikethrough/highlight, headings, bullet & numbered lists). Used for the
 * "Share as picture" card so formatting is preserved in the generated image.
 */
export function RichTextView({ content, color, mutedColor, highlightColor = "#FFE58A", fontSize = 16, testID }: Props) {
  const blocks = useMemo(() => {
    try {
      return htmlToBlocks(toHtml(content));
    } catch {
      return [{ type: "p", runs: [{ text: content }] } as Block];
    }
  }, [content]);

  const renderRuns = (runs: Run[], base: object, key: string) =>
    runs.map((r, i) => (
      <Text
        key={`${key}-${i}`}
        style={[
          base,
          r.bold && styles.bold,
          r.italic && styles.italic,
          (r.underline || r.strike) && {
            textDecorationLine: r.underline && r.strike ? "underline line-through" : r.underline ? "underline" : "line-through",
          },
          r.mark && { backgroundColor: highlightColor, color: "#181715" },
        ]}
      >
        {r.text}
      </Text>
    ));

  return (
    <View testID={testID}>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        const body = { color, fontSize, lineHeight: fontSize * 1.5 };
        switch (b.type) {
          case "h1":
            return (
              <Text key={key} style={[styles.h1, { color }]}>
                {renderRuns(b.runs, { fontSize: 26, lineHeight: 32, fontWeight: "800", color }, key)}
              </Text>
            );
          case "h2":
            return (
              <Text key={key} style={[styles.h2, { color }]}>
                {renderRuns(b.runs, { fontSize: 22, lineHeight: 28, fontWeight: "700", color }, key)}
              </Text>
            );
          case "h3":
            return (
              <Text key={key} style={[styles.h3, { color }]}>
                {renderRuns(b.runs, { fontSize: 19, lineHeight: 26, fontWeight: "700", color }, key)}
              </Text>
            );
          case "li":
            return (
              <View key={key} style={styles.liRow}>
                <Text style={[styles.bullet, { color: mutedColor, fontSize, lineHeight: fontSize * 1.5 }]}>
                  {b.ordered ? `${b.index ?? 1}.` : "\u2022"}
                </Text>
                <Text style={[styles.liText, body]}>{renderRuns(b.runs, body, key)}</Text>
              </View>
            );
          case "quote":
            return (
              <View key={key} style={[styles.quote, { borderLeftColor: mutedColor }]}>
                <Text style={[body, { color: mutedColor, fontStyle: "italic" }]}>{renderRuns(b.runs, body, key)}</Text>
              </View>
            );
          default:
            return (
              <Text key={key} style={[styles.p, body]}>
                {b.runs.length ? renderRuns(b.runs, body, key) : " "}
              </Text>
            );
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  h1: { marginTop: 10, marginBottom: 4 },
  h2: { marginTop: 8, marginBottom: 2 },
  h3: { marginTop: 6, marginBottom: 2 },
  p: { marginBottom: 2 },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  liRow: { flexDirection: "row", alignItems: "flex-start", paddingLeft: 6, marginBottom: 2 },
  bullet: { width: 24, textAlign: "right", marginRight: 8 },
  liText: { flex: 1 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, marginVertical: 4 },
});
