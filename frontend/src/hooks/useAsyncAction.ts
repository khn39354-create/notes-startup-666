import { useCallback, useEffect, useRef, useState } from "react";

import { friendlyMessage, logError, withTimeout } from "../lib/errors";
import { useToast } from "../components/Toast";

interface Options {
  /** Toast shown on failure (friendly message appended when generic). */
  errorMessage?: string;
  /** Toast shown on success. */
  successMessage?: string;
  /** Abort after this many ms so the UI never hangs. */
  timeoutMs?: number;
  /** Log scope. */
  scope?: string;
}

/**
 * Runs async work with: duplicate-tap protection (ignores calls while busy),
 * a hard timeout, redacted logging and a friendly toast on failure.
 *
 *   const save = useAsyncAction(async (id) => {...}, { errorMessage: "Couldn't save" });
 *   <Button disabled={save.busy} onPress={() => save.run(id)} />
 */
export function useAsyncAction<A extends any[], R>(
  fn: (...args: A) => Promise<R>,
  opts: Options = {},
) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      if (busyRef.current) return undefined; // ignore repeated taps
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const result = await withTimeout(fn(...args), opts.timeoutMs ?? 20000, opts.scope ?? "action");
        if (opts.successMessage && mounted.current) toast.show(opts.successMessage, "success");
        return result;
      } catch (e) {
        logError(opts.scope ?? "useAsyncAction", e);
        const msg = opts.errorMessage ?? friendlyMessage(e);
        if (mounted.current) {
          setError(msg);
          toast.show(msg, "error");
        }
        return undefined;
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fn, opts.errorMessage, opts.successMessage, opts.timeoutMs, opts.scope, toast],
  );

  return { run, busy, error };
}

export type LoadStatus = "loading" | "ready" | "error";

/**
 * Loader for screen data: exposes status (loading/ready/error) + retry, with
 * a timeout so the screen never spins forever.
 */
export function useLoader<T>(load: () => Promise<T>, initial: T, scope = "loader") {
  const [data, setData] = useState<T>(initial);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      const mySeq = ++seq.current;
      if (!opts.silent) setStatus((s) => (s === "ready" ? s : "loading"));
      try {
        const result = await withTimeout(load(), 15000, scope);
        if (!mounted.current || mySeq !== seq.current) return;
        setData(result);
        setStatus("ready");
        setMessage(null);
      } catch (e) {
        logError(scope, e);
        if (!mounted.current || mySeq !== seq.current) return;
        setStatus("error");
        setMessage(friendlyMessage(e, "Couldn't load your data."));
      }
    },
    [load, scope],
  );

  return { data, status, message, reload, setData };
}
