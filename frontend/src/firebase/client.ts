import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import {
  GoogleAuthProvider,
  type Auth,
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

const requiredConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const firebaseConfig = {
  ...requiredConfig,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};
const appCheckSiteKey = import.meta.env.VITE_FIREBASE_APPCHECK_RECAPTCHA_SITE_KEY;

export const firebaseRuntimeInfo = {
  projectId: requiredConfig.projectId ?? "missing",
  authDomain: requiredConfig.authDomain ?? "missing",
  appId: requiredConfig.appId ?? "missing",
};

export const firebaseProjectId = requiredConfig.projectId ?? "";

const configKeyLabels: Record<keyof typeof requiredConfig, string> = {
  apiKey: "VITE_FIREBASE_API_KEY",
  authDomain: "VITE_FIREBASE_AUTH_DOMAIN",
  projectId: "VITE_FIREBASE_PROJECT_ID",
  storageBucket: "VITE_FIREBASE_STORAGE_BUCKET",
  messagingSenderId: "VITE_FIREBASE_MESSAGING_SENDER_ID",
  appId: "VITE_FIREBASE_APP_ID",
};

export const missingFirebaseConfigKeys = Object.entries(requiredConfig)
  .filter(([, value]) => !value)
  .map(([key]) => configKeyLabels[key as keyof typeof requiredConfig]);

export const isFirebaseConfigured = missingFirebaseConfigKeys.length === 0;

const app = isFirebaseConfigured ? initializeApp(firebaseConfig) : null;
if (app && appCheckSiteKey) {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
}
const googleProvider = new GoogleAuthProvider();

export const auth: Auth | null = app ? getAuth(app) : null;
export const db: Firestore | null = app ? getFirestore(app) : null;
export type { User };

const requireAuth = () => {
  if (!auth) throw new Error("Firebase is not configured. Add your Firebase Web App values to .env.");
  return auth;
};

export const requireDb = () => {
  if (!db) throw new Error("Firebase is not configured. Add your Firebase Web App values to .env.");
  return db;
};

export const subscribeToAuth = (callback: (user: User | null) => void) => {
  if (!auth) {
    callback(null);
    return () => undefined;
  }

  return onAuthStateChanged(auth, callback);
};

export const signInWithEmail = (email: string, password: string) =>
  signInWithEmailAndPassword(requireAuth(), email, password);

export const signUpWithEmail = (email: string, password: string) =>
  createUserWithEmailAndPassword(requireAuth(), email, password);

const shouldFallbackToRedirect = (error: unknown) => {
  const code = typeof error === "object" && error != null && "code" in error ? String(error.code) : "";
  return ["auth/popup-blocked", "auth/cancelled-popup-request", "auth/operation-not-supported-in-this-environment"].includes(code);
};

export const signInWithGoogle = async () => {
  const authInstance = requireAuth();
  try {
    return await signInWithPopup(authInstance, googleProvider);
  } catch (error) {
    if (shouldFallbackToRedirect(error)) return signInWithRedirect(authInstance, googleProvider);
    throw error;
  }
};

export const completeGoogleRedirectSignIn = () => getRedirectResult(requireAuth());

export const signOutCurrentUser = () => signOut(requireAuth());
