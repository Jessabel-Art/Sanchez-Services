// src/hooks/useApiQuery.js — fetch + keep fresh (poll, refetch on focus and after any write).
import { useCallback, useEffect, useRef, useState } from "react";
import { getPollIntervalMs, onApiWrite } from "@/lib/api";

export function useApiQuery(fetcher, deps = [], { enabled = true, poll = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const mine = ++seq.current;
    try {
      const result = await fetcherRef.current();
      if (mine === seq.current) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    refresh();
    const unsubWrite = onApiWrite(() => refresh());
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    const timer = poll ? setInterval(() => document.visibilityState !== "hidden" && refresh(), getPollIntervalMs()) : null;
    return () => {
      unsubWrite();
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearInterval(timer);
    };
  }, [refresh, enabled, poll]);

  return { data, error, loading, refresh, setData };
}
