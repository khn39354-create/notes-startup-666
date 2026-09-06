/**
 * Central error utilities: safe logging (with secret redaction), user-friendly
 * messages and global crash/rejection handlers. Nothing here ever throws.
 */

const SECRET_PATTERNS: RegExp[] = [
  /(api[_-]?key|secret|token|password|passwd|authorization|bearer)\s*[:=]\s*[^\s,;"']+/gi,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /mongodb(\+srv)?:\/\/[^\s"']+/gi,
  /[A-Fa-f0-9]{32,}/g, // long hex keys
];

export function redact(input: unknown): string {
  let s: string;
  try {
    s = typeof input === "string" ? input : input instanceof Error ? `${input.name}: ${input.message}` : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  if (!s) return "";
  for (const re of SECRET_PATTERNS) s = s.replace(re, "[redacted]");
  return s.length > 2000 ? s.slice(0, 2000) + "…" : s;
}

export function logError(scope: string, error: unknown, extra?: unknown): void {
  try {
    const msg = redact(error);
    const stack = error instanceof Error && error.stack ? redact(error.stack).split("\n").slice(0, 6).join("\n") : "";
    // eslint-disable-next-line no-console
    console.warn(`[${scope}] ${msg}${stack ? "\n" + stack : ""}${extra !== undefined ? "\n" + redact(extra) : ""}`);
  } catch {
    // never throw from the logger
  }
}

/** Turn any thrown value into a short, safe message for the user. */
export function friendlyMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const m = raw.toLowerCase();
  if (!m) return fallback;
  if (m.includes("network") || m.includes("fetch") || m.includes("offline")) return "You appear to be offline. This app works offline, please try again.";
  if (m.includes("timeout") || m.includes("timed out")) return "This is taking too long. Please try again.";
  if (m.includes("permission") || m.includes("denied")) return "Permission was denied. You can enable it in Settings.";
  if (m.includes("disk") || m.includes("space") || m.includes("enospc")) return "Your device is out of storage space.";
  if (m.includes("database") || m.includes("sqlite") || m.includes("storage")) return "Couldn't access local storage. Please try again.";
  if (m.includes("not available") || m.includes("unavailable")) return "This feature isn't available on this device.";
  return fallback;
}

/** Reject after `ms` so no operation can hang the UI forever. */
export function withTimeout<T>(p: Promise<T>, ms = 15000, label = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Listener = (message: string) => void;
const listeners = new Set<Listener>();

/** Screens/toast provider can subscribe to background failures. */
export function onBackgroundError(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

let installed = false;

/**
 * Install process-wide handlers for uncaught JS errors and unhandled promise
 * rejections. Errors are logged (redacted) and surfaced as a friendly toast
 * instead of silently failing or crashing the app.
 */
export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;
  const notify = (err: unknown) => {
    const msg = friendlyMessage(err);
    listeners.forEach((l) => {
      try {
        l(msg);
      } catch {
        // ignore
      }
    });
  };

  // Uncaught JS errors (native). Keep default behaviour for fatal errors in dev.
  const g: any = globalThis as any;
  try {
    const EU = g.ErrorUtils;
    if (EU && typeof EU.setGlobalHandler === "function") {
      const prev = EU.getGlobalHandler?.();
      EU.setGlobalHandler((error: unknown, isFatal?: boolean) => {
        logError("GlobalError", error, { isFatal });
        notify(error);
        if (isFatal && prev) prev(error, isFatal);
      });
    }
  } catch (e) {
    logError("installGlobalErrorHandlers", e);
  }

  // Unhandled promise rejections (Hermes + web).
  try {
    const hermes = g.HermesInternal;
    if (hermes?.enablePromiseRejectionTracker) {
      hermes.enablePromiseRejectionTracker({
        allRejections: true,
        onUnhandled: (_id: number, error: unknown) => {
          logError("UnhandledRejection", error);
          notify(error);
        },
        onHandled: () => {},
      });
    }
  } catch (e) {
    logError("installGlobalErrorHandlers", e);
  }
  try {
    if (typeof g.addEventListener === "function") {
      g.addEventListener("unhandledrejection", (ev: any) => {
        logError("UnhandledRejection", ev?.reason);
        notify(ev?.reason);
        ev?.preventDefault?.();
      });
      g.addEventListener("error", (ev: any) => {
        logError("WindowError", ev?.error ?? ev?.message);
      });
    }
  } catch (e) {
    logError("installGlobalErrorHandlers", e);
  }
}
