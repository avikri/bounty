/**
 * Shared helpers for emulator-backed integration tests.
 *
 * Each test "user" gets its own named Firebase app wired to the local
 * emulators, so several identities (poster, claimant, stranger) can act
 * concurrently within one test. Tests talk to the real Web SDK against the
 * Auth / Firestore / Functions emulators — the same surface the app uses —
 * which means callables run against real Auth ID tokens and Firestore rules
 * are genuinely enforced.
 */
import { FirebaseApp, deleteApp, initializeApp } from 'firebase/app';
import {
  Auth,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
} from 'firebase/auth';
import {
  Firestore,
  connectFirestoreEmulator,
  doc,
  getFirestore,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import {
  Functions,
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
} from 'firebase/functions';

export const PROJECT_ID = 'bounty-c5ee6';
export const REGION = 'australia-southeast1';

const AUTH_HOST = '127.0.0.1';
const AUTH_PORT = 9099;
const FIRESTORE_PORT = 8080;
const FUNCTIONS_PORT = 5001;

export interface TestUser {
  uid: string;
  email: string;
  displayName: string;
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  functions: Functions;
  /** Invoke a callable as this user; returns the `data` payload. */
  call<T = unknown>(name: string, payload: unknown): Promise<T>;
}

let seq = 0;
const liveApps: FirebaseApp[] = [];

/**
 * Create a signed-in test user with a seeded `users/{uid}` profile doc
 * (createGroup / joinGroup both require the profile to exist).
 */
export async function createUser(displayName: string): Promise<TestUser> {
  const tag = `t${++seq}-${Date.now()}`;
  const app = initializeApp(
    { projectId: PROJECT_ID, apiKey: 'fake-api-key' },
    tag,
  );
  liveApps.push(app);

  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${AUTH_HOST}:${AUTH_PORT}`, {
    disableWarnings: true,
  });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, AUTH_HOST, FIRESTORE_PORT);
  const functions = getFunctions(app, REGION);
  connectFunctionsEmulator(functions, AUTH_HOST, FUNCTIONS_PORT);

  const email = `${tag}@test.dev`;
  const cred = await createUserWithEmailAndPassword(auth, email, 'password123');
  const uid = cred.user.uid;

  const handle = displayName.toLowerCase().replace(/\s+/g, '');
  await setDoc(doc(db, 'users', uid), {
    uid,
    displayName,
    handle,
    photoURL: null,
    groupIds: [],
    totalPoints: 0,
    createdAt: serverTimestamp(),
  });

  return {
    uid,
    email,
    displayName,
    app,
    auth,
    db,
    functions,
    async call<T = unknown>(name: string, payload: unknown): Promise<T> {
      const fn = httpsCallable<unknown, T>(functions, name);
      const res = await fn(payload);
      return res.data;
    },
  };
}

/** Tear down every app created during a test run. */
export async function disposeUsers(): Promise<void> {
  await Promise.all(liveApps.splice(0).map((a) => deleteApp(a).catch(() => undefined)));
}

/** Wipe all Firestore documents in the emulator. */
export async function clearFirestore(): Promise<void> {
  const url =
    `http://${AUTH_HOST}:${FIRESTORE_PORT}/emulator/v1/projects/` +
    `${PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(`clearFirestore failed: ${res.status}`);
}

/** Delete all Auth accounts in the emulator. */
export async function clearAuth(): Promise<void> {
  const url =
    `http://${AUTH_HOST}:${AUTH_PORT}/emulator/v1/projects/${PROJECT_ID}/accounts`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(`clearAuth failed: ${res.status}`);
}

/** Reset both emulators and dispose any leftover apps. */
export async function resetEmulators(): Promise<void> {
  await disposeUsers();
  await Promise.all([clearFirestore(), clearAuth()]);
}

/** Assert that a promise rejects (used for rules deny / precondition checks). */
export async function expectReject(
  p: Promise<unknown>,
  codeMatch?: string,
): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    if (codeMatch && !code.includes(codeMatch)) {
      throw new Error(
        `expected rejection code containing "${codeMatch}" but got "${code}" (${String(err)})`,
      );
    }
    return err;
  }
  throw new Error('expected promise to reject, but it resolved');
}
