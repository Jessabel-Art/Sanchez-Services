// src/lib/php-backend/firestore.js
//
// Drop-in subset of the `firebase/firestore` modular API, backed by the PHP gateway
// (/api/db/get | query | commit). Aliased in place of `firebase/firestore` only when
// VITE_BACKEND=php. Real-time listeners become polling + refresh-after-local-write.

import {
  Timestamp,
  FieldSentinel,
  encodeValue,
  decodeValue,
  post,
  getPollIntervalMs,
  onLocalWrite,
  notifyLocalWrite,
  BackendError,
} from "./client";

export { Timestamp };

const DB = { type: "firestore", app: { name: "[DEFAULT]", options: { projectId: "php-backend" } } };

export function getFirestore() {
  return DB;
}
export function connectFirestoreEmulator() {}
export function initializeFirestore() {
  return DB;
}

// ---------------------------------------------------------------- references

function newId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(20);
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % 62]).join("");
}

class CollectionReference {
  constructor(path) {
    this.type = "collection";
    this.path = path;
    this.id = path.split("/").pop();
    this.firestore = DB;
    this._query = { where: [], orderBy: [], limit: null, limitToLast: null };
  }
  get parent() {
    const parts = this.path.split("/");
    return parts.length > 1 ? new DocumentReference(parts.slice(0, -1).join("/")) : null;
  }
}

class DocumentReference {
  constructor(path) {
    this.type = "document";
    this.path = path;
    this.id = path.split("/").pop();
    this.firestore = DB;
  }
  get parent() {
    return new CollectionReference(this.path.split("/").slice(0, -1).join("/"));
  }
}

class Query {
  constructor(collectionPath, q) {
    this.type = "query";
    this.path = collectionPath;
    this.firestore = DB;
    this._query = q;
  }
}

function joinPath(base, segments) {
  const parts = [...(base ? base.split("/") : []), ...segments.flatMap((s) => String(s).split("/"))].filter(Boolean);
  return parts.join("/");
}

export function collection(parent, ...segments) {
  const base = parent && parent.type === "document" ? parent.path : parent && parent.type === "collection" ? parent.path : "";
  const path = joinPath(base, segments);
  if (path.split("/").length % 2 !== 1) throw new BackendError("invalid-argument", `Invalid collection path: ${path}`);
  return new CollectionReference(path);
}

export function doc(parent, ...segments) {
  let base = "";
  if (parent && (parent.type === "collection" || parent.type === "document")) base = parent.path;
  let path = joinPath(base, segments);
  if (parent && parent.type === "collection" && segments.length === 0) path = `${parent.path}/${newId()}`;
  if (path.split("/").length % 2 !== 0) throw new BackendError("invalid-argument", `Invalid document path: ${path}`);
  return new DocumentReference(path);
}

// ---------------------------------------------------------------- query constraints

export function where(field, op, value) {
  return { kind: "where", field: typeof field === "string" ? field : String(field), op, value };
}
export function orderBy(field, direction = "asc") {
  return { kind: "orderBy", field, direction };
}
export function limit(n) {
  return { kind: "limit", n };
}
export function limitToLast(n) {
  return { kind: "limitToLast", n };
}
export function documentId() {
  return "__name__";
}

export function query(ref, ...constraints) {
  const base = ref._query || { where: [], orderBy: [], limit: null, limitToLast: null };
  const q = { where: [...base.where], orderBy: [...base.orderBy], limit: base.limit, limitToLast: base.limitToLast };
  for (const c of constraints.flat()) {
    if (!c) continue;
    if (c.kind === "where") q.where.push([c.field, c.op, c.value]);
    else if (c.kind === "orderBy") q.orderBy.push([c.field, c.direction]);
    else if (c.kind === "limit") q.limit = c.n;
    else if (c.kind === "limitToLast") q.limitToLast = c.n;
  }
  return new Query(ref.path, q);
}

// ---------------------------------------------------------------- snapshots

class DocumentSnapshot {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this._data = data;
    this.metadata = { hasPendingWrites: false, fromCache: false };
  }
  exists() {
    return this._data !== null && this._data !== undefined;
  }
  data() {
    return this._data === null || this._data === undefined ? undefined : decodeValue(this._data);
  }
  get(field) {
    const d = this.data();
    return field.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), d);
  }
}

class QuerySnapshot {
  constructor(collectionPath, rows, q) {
    this.query = q;
    this.docs = rows.map((r) => new DocumentSnapshot(new DocumentReference(`${collectionPath}/${r.id}`), r.data));
    this.size = this.docs.length;
    this.empty = this.docs.length === 0;
    this.metadata = { hasPendingWrites: false, fromCache: false };
  }
  forEach(cb, thisArg) {
    this.docs.forEach(cb, thisArg);
  }
  docChanges() {
    return this.docs.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i }));
  }
}

function serializeQuery(ref) {
  const q = ref._query || { where: [], orderBy: [], limit: null, limitToLast: null };
  return {
    collection: ref.path,
    where: q.where.map(([f, op, v]) => [f, op, encodeValue(v)]),
    orderBy: q.orderBy,
    limit: q.limit,
    limitToLast: q.limitToLast,
  };
}

export async function getDoc(ref) {
  const out = await post("/db/get", { path: ref.path });
  return new DocumentSnapshot(ref, out.exists ? out.data : null);
}
export const getDocFromServer = getDoc;

export async function getDocs(ref) {
  const out = await post("/db/query", serializeQuery(ref));
  return new QuerySnapshot(ref.path, out.docs || [], ref);
}
export const getDocsFromServer = getDocs;

// ---------------------------------------------------------------- listeners (polling)

/**
 * onSnapshot(ref, next, error) or onSnapshot(ref, {next, error}).
 * Emits immediately, then on change: polls every pollIntervalSeconds (from /api/auth/session),
 * refreshes after local writes and when the tab becomes visible again.
 */
export function onSnapshot(ref, ...args) {
  let next;
  let error;
  const cbArgs = args.filter((a) => typeof a === "function" || (a && typeof a === "object" && (a.next || a.error)));
  if (cbArgs[0] && typeof cbArgs[0] === "object") {
    next = cbArgs[0].next;
    error = cbArgs[0].error;
  } else {
    [next, error] = cbArgs;
  }
  let active = true;
  let last = null;
  let timer = null;
  let inFlight = false;

  const run = async () => {
    if (!active || inFlight) return;
    inFlight = true;
    try {
      let snap;
      let fingerprint;
      if (ref.type === "document") {
        const out = await post("/db/get", { path: ref.path });
        fingerprint = JSON.stringify(out);
        snap = new DocumentSnapshot(ref, out.exists ? out.data : null);
      } else {
        const out = await post("/db/query", serializeQuery(ref));
        fingerprint = JSON.stringify(out.docs || []);
        snap = new QuerySnapshot(ref.path, out.docs || [], ref);
      }
      if (active && fingerprint !== last) {
        last = fingerprint;
        next && next(snap);
      }
    } catch (e) {
      if (active) {
        // Firestore stops a listener after an error; do the same.
        stop();
        error ? error(e) : console.error("onSnapshot error", e);
      }
    } finally {
      inFlight = false;
    }
  };

  const onVisible = () => {
    if (document.visibilityState === "visible") run();
  };
  const unsubWrite = onLocalWrite(run);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  const schedule = () => {
    timer = setTimeout(async () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") await run();
      if (active) schedule();
    }, getPollIntervalMs());
  };
  function stop() {
    active = false;
    clearTimeout(timer);
    unsubWrite();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  }
  run();
  schedule();
  return stop;
}

// ---------------------------------------------------------------- writes

export function serverTimestamp() {
  return new FieldSentinel("serverTimestamp");
}
export function deleteField() {
  return new FieldSentinel("delete");
}
export function increment(n) {
  return new FieldSentinel("increment", { n });
}

async function commit(writes) {
  const out = await post("/db/commit", { writes });
  notifyLocalWrite();
  return out.results || [];
}

function updatePayload(dataOrField, value, more) {
  if (typeof dataOrField === "string") {
    const data = { [dataOrField]: value };
    for (let i = 0; i < more.length; i += 2) data[more[i]] = more[i + 1];
    return data;
  }
  return dataOrField;
}

export async function addDoc(collectionRef, data) {
  const id = newId();
  await commit([{ op: "create", path: collectionRef.path, id, data: encodeValue(data) }]);
  return new DocumentReference(`${collectionRef.path}/${id}`);
}

export async function setDoc(ref, data, options = {}) {
  await commit([{ op: "set", path: ref.path, merge: !!(options && (options.merge || options.mergeFields)), data: encodeValue(data) }]);
}

export async function updateDoc(ref, dataOrField, value, ...more) {
  await commit([{ op: "update", path: ref.path, data: encodeValue(updatePayload(dataOrField, value, more)) }]);
}

export async function deleteDoc(ref) {
  await commit([{ op: "delete", path: ref.path }]);
}

export function writeBatch() {
  const writes = [];
  const batch = {
    set(ref, data, options = {}) {
      writes.push({ op: "set", path: ref.path, merge: !!(options && (options.merge || options.mergeFields)), data: encodeValue(data) });
      return batch;
    },
    update(ref, dataOrField, value, ...more) {
      writes.push({ op: "update", path: ref.path, data: encodeValue(updatePayload(dataOrField, value, more)) });
      return batch;
    },
    delete(ref) {
      writes.push({ op: "delete", path: ref.path });
      return batch;
    },
    async commit() {
      if (writes.length) await commit(writes.splice(0));
    },
  };
  return batch;
}

export async function runTransaction() {
  throw new BackendError("unimplemented", "Client transactions are not supported by the PHP backend.");
}
