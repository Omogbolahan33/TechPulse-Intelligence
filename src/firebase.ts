import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  addDoc, 
  query, 
  orderBy, 
  onSnapshot, 
  serverTimestamp,
  Timestamp,
  deleteDoc,
  doc,
  where,
  getDoc,
  setDoc
} from 'firebase/firestore';

// Firebase configuration from environment variables
// In production, these are set via environment variables
// In development, they come from the imported config or env vars
const getEnvVar = (key: string): string | undefined => {
  // Try Vite env first (client-side), then Node env (server-side)
  try {
    if (typeof import.meta !== 'undefined' && (import.meta as any).env) {
      return (import.meta as any).env[key] || process.env[key];
    }
  } catch {
    // import.meta not available
  }
  return process.env[key];
};

const firebaseConfig = {
  projectId: getEnvVar('VITE_FIREBASE_PROJECT_ID'),
  appId: getEnvVar('VITE_FIREBASE_APP_ID'),
  apiKey: getEnvVar('VITE_FIREBASE_API_KEY'),
  authDomain: getEnvVar('VITE_FIREBASE_AUTH_DOMAIN'),
  storageBucket: getEnvVar('VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: getEnvVar('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  measurementId: getEnvVar('VITE_FIREBASE_MEASUREMENT_ID'),
};

// Fallback to config file for development (will be removed in production)
const getFirebaseConfig = () => {
  // If env vars are not set, try to load from config file
  if (!firebaseConfig.apiKey) {
    try {
      // Dynamic import to avoid bundling in production if not needed
      const config = require('../firebase-applet-config.json');
      return {
        ...config,
        firestoreDatabaseId: config.firestoreDatabaseId,
      };
    } catch {
      console.warn('Firebase config not found. Set VITE_FIREBASE_* environment variables.');
    }
  }
  return { ...firebaseConfig, firestoreDatabaseId: process.env.VITE_FIREBASE_DATABASE_ID };
};

const config = getFirebaseConfig();
const app = initializeApp(config);
export const auth = getAuth(app);
export const db = getFirestore(app, config.firestoreDatabaseId);
export const googleProvider = new GoogleAuthProvider();

export { 
  signInWithPopup, 
  signOut,
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  deleteDoc,
  doc,
  where,
  getDoc,
  setDoc
};

export interface Comment {
  id: string;
  articleId: string;
  userId: string;
  userName: string;
  userPhoto?: string;
  text: string;
  createdAt: any;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}
