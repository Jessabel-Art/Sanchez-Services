import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";
import { getApp } from "firebase/app";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

const requiredEnvKeys = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
];

const missingEnvKeys = requiredEnvKeys.filter(
  (key) => !import.meta.env[key]
);

if (missingEnvKeys.length > 0) {
  console.warn("[firebase] Missing env vars:", missingEnvKeys);
}
try {
  const app = getApp();
  console.log("[ENV CHECK] hostname:", window.location.hostname);
  console.log("[ENV CHECK] projectId:", app.options.projectId);
  console.log("[ENV CHECK] authDomain:", app.options.authDomain);
} catch (e) {
  console.warn("[ENV CHECK] getApp failed", e);
}

const auth = getAuth(app);
const db = getFirestore(app);
const functionsRegion = import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION;
const functions = functionsRegion
  ? getFunctions(app, functionsRegion)
  : getFunctions(app);

if (process.env.NODE_ENV !== "production") {
  console.info("[firebase] config", {
    projectId: firebaseConfig.projectId,
    authDomain: firebaseConfig.authDomain,
    functionsRegion: functionsRegion || functions?.region || "default",
  });
}

export { app, auth, db, functions };
