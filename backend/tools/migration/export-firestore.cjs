#!/usr/bin/env node
/*
 * READ-ONLY export of the Sanchez Services Firestore database for the PHP migration.
 *
 * It only calls .get() / .listDocuments(); it never writes, updates or deletes.
 * Run it on a trusted machine (your computer), NOT on the web server:
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/secure/path/readonly-sa.json \
 *     node backend/tools/migration/export-firestore.cjs --project sanchez-services-11fd0 --out ./export-2026-11-04
 *
 * Use a service account with read-only roles (Cloud Datastore Viewer). Keep the key file and the
 * export directory out of git — they contain customer PII.
 *
 * Output (one NDJSON file per collection + manifest.json with counts and SHA-256 checksums):
 *   {"path":"bookings/abc","id":"abc","parent":null,"data":{...}}
 * Timestamps are encoded as {"__ts":"ISO-8601Z"} (same encoding the PHP backend stores).
 *
 * Firebase Auth users are exported separately with the Firebase CLI (also read-only):
 *   firebase auth:export ./export-2026-11-04/auth-users.json --format=json --project sanchez-services-11fd0
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COLLECTIONS = [
  'bookings', 'profiles', 'admins', 'reviews', 'blackouts',
  // collections with rules but (per the audit) no known writers — exported for review only:
  'payments', 'reports', 'services', 'addresses', 'availability', 'bookingReservations', 'mail',
];

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else out[key] = true;
    }
  }
  return out;
}

/** Converts Firestore SDK values to the JSON wire encoding used by the PHP backend. */
function encode(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
  }
  // Timestamp (firebase-admin) — duck-typed so tests can pass plain objects
  if (typeof value.toDate === 'function' && typeof value.seconds === 'number' && typeof value.nanoseconds === 'number') {
    return { __ts: value.toDate().toISOString() };
  }
  if (value instanceof Date) return { __ts: value.toISOString() };
  // DocumentReference
  if (typeof value.path === 'string' && typeof value.id === 'string' && value.firestore) {
    return { __ref: value.path };
  }
  // GeoPoint
  if (typeof value.latitude === 'number' && typeof value.longitude === 'number' && Object.keys(value).length <= 2) {
    return { __geo: [value.latitude, value.longitude] };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { __bytes: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encode);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = encode(v);
  return out;
}

async function exportCollection(query, file, describe) {
  const snap = await query.get();
  const fd = fs.openSync(file, 'w');
  let count = 0;
  for (const doc of snap.docs) {
    const parts = doc.ref.path.split('/');
    const line = JSON.stringify({
      path: doc.ref.path,
      id: doc.id,
      parent: parts.length > 2 ? parts.slice(0, -2).join('/') : null,
      data: encode(doc.data()),
    });
    fs.writeSync(fd, line + '\n');
    count++;
  }
  fs.closeSync(fd);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  console.log(`  ${describe}: ${count}`);
  return { count, sha256 };
}

async function run({ db, outDir, projectId }) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const manifest = {
    projectId,
    exportedAt: new Date().toISOString(),
    tool: 'backend/tools/migration/export-firestore.cjs',
    collections: {},
  };
  for (const name of COLLECTIONS) {
    manifest.collections[name] = await exportCollection(db.collection(name), path.join(outDir, `${name}.ndjson`), name);
  }
  // Subcollection profiles/{uid}/addresses via collection group (includes only nested ones)
  const groupFile = path.join(outDir, 'profiles__addresses.ndjson');
  const all = await db.collectionGroup('addresses').get();
  const fd = fs.openSync(groupFile, 'w');
  let n = 0;
  for (const doc of all.docs) {
    const parts = doc.ref.path.split('/');
    if (parts.length !== 4 || parts[0] !== 'profiles') continue;
    fs.writeSync(fd, JSON.stringify({ path: doc.ref.path, id: doc.id, parent: `profiles/${parts[1]}`, data: encode(doc.data()) }) + '\n');
    n++;
  }
  fs.closeSync(fd);
  manifest.collections['profiles/*/addresses'] = {
    count: n,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(groupFile)).digest('hex'),
  };
  console.log(`  profiles/*/addresses: ${n}`);
  // Report any top-level collections this tool does not know about.
  const known = new Set(COLLECTIONS);
  const unknown = (await db.listCollections()).map((c) => c.id).filter((id) => !known.has(id));
  manifest.unknownCollections = unknown;
  if (unknown.length) console.warn('  WARNING: collections not exported:', unknown.join(', '));
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

module.exports = { encode, run, COLLECTIONS };

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv);
    if (!args.project || !args.out) {
      console.error('Usage: node export-firestore.cjs --project <projectId> --out <dir>');
      process.exit(2);
    }
    let admin;
    try {
      admin = require('firebase-admin');
    } catch {
      admin = require(path.resolve(__dirname, '../../../functions/node_modules/firebase-admin'));
    }
    admin.initializeApp({ projectId: args.project });
    const db = admin.firestore();
    console.log(`Exporting project ${args.project} (read-only) to ${args.out}`);
    const manifest = await run({ db, outDir: args.out, projectId: args.project });
    console.log('Done. Manifest written. Total documents:',
      Object.values(manifest.collections).reduce((s, c) => s + c.count, 0));
  })().catch((e) => {
    console.error('Export failed:', e.message);
    process.exit(1);
  });
}
