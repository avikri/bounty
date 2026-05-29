import { FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';
import { Auth, getAuth, connectAuthEmulator } from 'firebase/auth';
import { Firestore, getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { Functions, getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import { FirebaseStorage, getStorage, connectStorageEmulator } from 'firebase/storage';
import { environment } from '../../environments/environment';

let _app: FirebaseApp;
let _auth: Auth;
let _db: Firestore;
let _functions: Functions;
let _storage: FirebaseStorage;
let _emulatorsConnected = false;

function ensureApp(): FirebaseApp {
  if (_app) return _app;
  _app = getApps().length ? getApp() : initializeApp(environment.firebase);
  return _app;
}

export function getFirebase() {
  ensureApp();
  if (!_auth)      _auth      = getAuth(_app);
  if (!_db)        _db        = getFirestore(_app);
  if (!_functions) _functions = getFunctions(_app, 'australia-southeast1');
  if (!_storage)   _storage   = getStorage(_app);

  if (!_emulatorsConnected && (environment as { useEmulators?: boolean }).useEmulators) {
    _emulatorsConnected = true;
    connectAuthEmulator(_auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(_db, '127.0.0.1', 8080);
    connectFunctionsEmulator(_functions, '127.0.0.1', 5001);
    connectStorageEmulator(_storage, '127.0.0.1', 9199);
  }

  return { app: _app, auth: _auth, db: _db, functions: _functions, storage: _storage };
}

// Eager exports for code that runs outside Angular's DI (e.g. utilities).
export const auth      = (): Auth            => getFirebase().auth;
export const db        = (): Firestore       => getFirebase().db;
export const functions = (): Functions       => getFirebase().functions;
export const storage   = (): FirebaseStorage => getFirebase().storage;
