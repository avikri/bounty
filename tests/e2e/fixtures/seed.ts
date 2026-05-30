/**
 * E2E data seeding.
 *
 * Mirrors the integration layer's approach: each persona gets its own Web-SDK
 * Firebase app pointed at the emulators, and the standard group state is built
 * through the REAL Cloud Functions callables (createGroup / joinGroup) and
 * rule-allowed client writes — so the seeded graph is exactly what the app
 * would produce, not a hand-rolled approximation.
 *
 * Personas use fixed email/password credentials so the browser can sign in as
 * any of them via `window.__e2e.signIn` (the Auth emulator shares its account
 * store between the Node seeding app and the browser app).
 */
import { FirebaseApp, deleteApp, initializeApp } from 'firebase/app';
import {
  Auth, connectAuthEmulator, createUserWithEmailAndPassword, getAuth,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import {
  Firestore, Timestamp, addDoc, collection, connectFirestoreEmulator, doc,
  getFirestore, serverTimestamp, setDoc, updateDoc,
} from 'firebase/firestore';
import {
  Functions, connectFunctionsEmulator, getFunctions, httpsCallable,
} from 'firebase/functions';

const PROJECT_ID = 'bounty-c5ee6';
const REGION = 'australia-southeast1';
const HOST = '127.0.0.1';
const AUTH_PORT = 9099;
const FIRESTORE_PORT = 8080;
const FUNCTIONS_PORT = 5001;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface Persona {
  key: 'A' | 'B' | 'C' | 'D';
  email: string;
  password: string;
  name: string;
}

/** A=owner, B=member, C=admin, D=non-member. */
export const PERSONAS: Record<'A' | 'B' | 'C' | 'D', Persona> = {
  A: { key: 'A', email: 'owner-a@e2e.test', password: 'password123', name: 'Avery Owner' },
  B: { key: 'B', email: 'member-b@e2e.test', password: 'password123', name: 'Blake Member' },
  C: { key: 'C', email: 'admin-c@e2e.test', password: 'password123', name: 'Casey Admin' },
  D: { key: 'D', email: 'outsider-d@e2e.test', password: 'password123', name: 'Drew Outsider' },
};

export interface SeedUser {
  uid: string;
  persona: Persona;
  app: FirebaseApp;
  db: Firestore;
  functions: Functions;
  call<T = unknown>(name: string, payload: unknown): Promise<T>;
}

export interface SeededGroup {
  groupId: string;
  inviteCode: string;
  users: Record<'A' | 'B' | 'C' | 'D', SeedUser>;
}

let appSeq = 0;

async function makeUser(persona: Persona): Promise<SeedUser> {
  const app = initializeApp(
    { projectId: PROJECT_ID, apiKey: 'fake-api-key' },
    `e2e-seed-${persona.key}-${++appSeq}`,
  );
  const auth: Auth = getAuth(app);
  connectAuthEmulator(auth, `http://${HOST}:${AUTH_PORT}`, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, HOST, FIRESTORE_PORT);
  const functions = getFunctions(app, REGION);
  connectFunctionsEmulator(functions, HOST, FUNCTIONS_PORT);

  const cred = await createUserWithEmailAndPassword(auth, persona.email, persona.password);
  const uid = cred.user.uid;
  await setDoc(doc(db, 'users', uid), {
    uid,
    displayName: persona.name,
    handle: persona.name.toLowerCase().replace(/\s+/g, ''),
    photoURL: null,
    groupIds: [],
    totalPoints: 0,
    createdAt: serverTimestamp(),
  });

  return {
    uid,
    persona,
    app,
    db,
    functions,
    async call<T = unknown>(name: string, payload: unknown): Promise<T> {
      const res = await httpsCallable<unknown, T>(functions, name)(payload);
      return res.data;
    },
  };
}

/** REST `DELETE` wipe of Firestore + Auth in the emulators (same as integration). */
export async function resetData(): Promise<void> {
  await Promise.all([
    fetch(
      `http://${HOST}:${FIRESTORE_PORT}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
      { method: 'DELETE' },
    ),
    fetch(
      `http://${HOST}:${AUTH_PORT}/emulator/v1/projects/${PROJECT_ID}/accounts`,
      { method: 'DELETE' },
    ),
  ]);
}

/**
 * Build the standard fixture: A owns a group; B and C have joined; C is promoted
 * to admin; D exists but is not a member. Returns the group id, current invite
 * code, and each persona's uid. Client apps are torn down before returning (the
 * Auth accounts persist in the emulator for the browser to sign into).
 */
export async function seedStandardGroup(): Promise<SeededGroup> {
  const [A, B, C, D] = await Promise.all([
    makeUser(PERSONAS.A),
    makeUser(PERSONAS.B),
    makeUser(PERSONAS.C),
    makeUser(PERSONAS.D),
  ]);

  const { groupId, inviteCode } = await A.call<{ groupId: string; inviteCode: string }>(
    'createGroup', { name: 'Roomies', emoji: '🏠' },
  );
  await B.call('joinGroup', { inviteCode });
  await C.call('joinGroup', { inviteCode });

  // Owner promotes C to admin (rules permit a role-only update by the owner).
  await updateDoc(doc(A.db, 'groups', groupId, 'members', C.uid), { role: 'admin' });

  const users = { A, B, C, D } as const;
  const out: SeededGroup = { groupId, inviteCode, users };

  // Keep apps alive long enough to return uids, then dispose to free listeners.
  await Promise.all([A, B, C, D].map((u) => deleteApp(u.app).catch(() => undefined)));
  return out;
}

/**
 * Sign in as an already-seeded persona and return a live SDK actor. Use this to
 * drive server-side state changes (claim/submit/approve/markIouPaid) from a test
 * while observing the effect in a browser context. Caller should `dispose()`.
 */
export async function loginSeedUser(persona: Persona): Promise<SeedUser & { dispose(): Promise<void> }> {
  const app = initializeApp(
    { projectId: PROJECT_ID, apiKey: 'fake-api-key' },
    `e2e-actor-${persona.key}-${++appSeq}`,
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${HOST}:${AUTH_PORT}`, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, HOST, FIRESTORE_PORT);
  const functions = getFunctions(app, REGION);
  connectFunctionsEmulator(functions, HOST, FUNCTIONS_PORT);

  const cred = await signInWithEmailAndPassword(auth, persona.email, persona.password);
  return {
    uid: cred.user.uid,
    persona,
    app,
    db,
    functions,
    async call<T = unknown>(name: string, payload: unknown): Promise<T> {
      const res = await httpsCallable<unknown, T>(functions, name)(payload);
      return res.data;
    },
    async dispose() { await deleteApp(app).catch(() => undefined); },
  };
}

/** Post an available bounty as a given user; returns its id. */
export async function postBounty(
  poster: SeedUser,
  groupId: string,
  opts: { title?: string; price?: number; expiresInMs?: number } = {},
): Promise<string> {
  const ref = await addDoc(collection(poster.db, 'groups', groupId, 'bounties'), {
    title: opts.title ?? 'Clean the whiteboard',
    description: 'Must be spotless',
    price: opts.price ?? 25,
    currency: 'USD',
    state: 'available',
    posterId: poster.uid,
    claimantId: null,
    expiresAt: Timestamp.fromDate(new Date(Date.now() + (opts.expiresInMs ?? WEEK_MS))),
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export { WEEK_MS };
