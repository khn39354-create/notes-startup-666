import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { useTheme } from "../context/AppContext";

export function LoadingState({ label = "Loading…", testID = "loading-state" }: { label?: string; testID?: string }) {
  const c = useTheme();
  return (
    <View style={styles.wrap} testID={testID}>
      <ActivityIndicator size="large" color={c.brand} />
      <Text style={[styles.label, { color: c.muted }]}>{label}</Text>
    </View>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message = "We couldn't load this. Your notes are safe on this device.",
  onRetry,
  retryLabel = "Retry",
  testID = "error-state",
  secondaryLabel,
  onSecondary,
}: {
  title?: string;
  message?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  testID?: string;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  const c = useTheme();
  return (
    <View style={styles.wrap} testID={testID}>
      <View style={[styles.iconWrap, { backgroundColor: c.brandTertiary }]}>
        <MaterialCommunityIcons name="alert-circle-outline" size={40} color={c.brand} />
      </View>
      <Text style={[styles.title, { color: c.onSurface }]}>{title}</Text>
      {message ? <Text style={[styles.subtitle, { color: c.onSurfaceTertiary }]}>{message}</Text> : null}
      <View style={styles.row}>
        {onSecondary && secondaryLabel ? (
          <Pressable testID={`${testID}-secondary`} onPress={onSecondary} style={[styles.btn, { backgroundColor: c.surfaceTertiary }]}>
            <Text style={[styles.btnText, { color: c.onSurface }]}>{secondaryLabel}</Text>
          </Pressable>
        ) : null}
        {onRetry ? (
          <Pressable testID={`${testID}-retry`} onPress={onRetry} style={[styles.btn, { backgroundColor: c.brand }]}>
            <MaterialCommunityIcons name="refresh" size={18} color={c.onBrand} />
            <Text style={[styles.btnText, { color: c.onBrand }]}>{retryLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** Slim inline banner (e.g. "Couldn't save · Retry"). */
export function InlineError({ message, onRetry, testID = "inline-error" }: { message: string; onRetry?: () => void; testID?: string }) {
  const c = useTheme();
  return (
    <View style={[styles.banner, { backgroundColor: c.mode === "dark" ? "#3A1F1C" : "#FDECEA", borderColor: c.error }]} testID={testID}>
      <MaterialCommunityIcons name="alert-circle" size={16} color={c.error} />
      <Text style={[styles.bannerText, { color: c.error }]} numberOfLines={2}>
        {message}
      </Text>
      {onRetry ? (
        <Pressable onPress={onRetry} hitSlop={8} testID={`${testID}-retry`} style={styles.bannerBtn}>
          <Text style={[styles.bannerBtnText, { color: c.error }]}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 40, paddingBottom: 60, gap: 8 },
  label: { fontSize: 14, marginTop: 8 },
  iconWrap: { width: 96, height: 96, borderRadius: 28, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  title: { fontSize: 18, fontWeight: "700", textAlign: "center" },
  subtitle: { fontSize: 14, lineHeight: 20, textAlign: "center" },
  row: { flexDirection: "row", gap: 12, marginTop: 20 },
  btn: { flexDirection: "row", alignItems: "center", gap: 6, height: 48, paddingHorizontal: 22, borderRadius: 14 },
  btnText: { fontSize: 15, fontWeight: "700" },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 12,
  },
  bannerText: { flex: 1, fontSize: 13, fontWeight: "600" },
  bannerBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  bannerBtnText: { fontSize: 13, fontWeight: "800", textDecorationLine: "underline" },
});
