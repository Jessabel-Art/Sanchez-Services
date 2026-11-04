// src/lib/php-backend/functions.js — drop-in for `firebase/functions` (callables -> /api/fn/{name}).
import { post, encodeValue, decodeValue, notifyLocalWrite, BackendError } from "./client";

const FUNCTIONS = { app: { name: "[DEFAULT]" }, region: "php-backend" };

export function getFunctions() {
  return FUNCTIONS;
}
export function connectFunctionsEmulator() {}

export function httpsCallable(functions, name) {
  return async (data) => {
    try {
      const out = await post(`/fn/${encodeURIComponent(name)}`, { data: encodeValue(data ?? {}) });
      notifyLocalWrite();
      return { data: decodeValue(out.result) };
    } catch (e) {
      // Firebase Functions errors expose code "functions/<code>"
      const code = String(e.code || "internal");
      throw new BackendError(code.startsWith("auth/") ? code : `functions/${code}`, e.message, e.status);
    }
  };
}
