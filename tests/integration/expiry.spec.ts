/**
 * [F1–F3] Integration tests for the bounty auto-expiry sweep.
 *
 * The scheduled `onBountyExpiry` trigger never runs under the emulator (no
 * pubsub), so the logic was extracted into the pure `runBountyExpiry(db, now)`
 * handler (functions/src/expiry.ts). Here we drive that handler directly with a
 * controllable `now` against the Firestore emulator, using the firebase-admin
 * SDK to seed and read (admin bypasses security rules, mirroring the privileged
 * context the scheduled function runs in).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App, deleteApp, initializeApp } from 'firebase-admin/app';
import { DocumentReference, Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { runBountyExpiry } from '../../functions/src/expiry';
import { PROJECT_ID, resetEmulators } from './emulator';

// firebase-admin reads this when constructing its Firestore client. The Web SDK
// used elsewhere ignores it (it connects via connectFirestoreEmulator).
process.env['FIRESTORE_EMULATOR_HOST'] = '127.0.0.1:8080';

const GID = 'g-expiry';
const HOUR = 60 * 60 * 1000;

let app: App;
let db: Firestore;

beforeAll(() => {
  app = initializeApp({ projectId: PROJECT_ID }, 'expiry-admin');
  db = getFirestore(app);
});

afterAll(async () => {
  await resetEmulators();
  await deleteApp(app);
});

beforeEach(async () => {
  await resetEmulators();
});
afterEach(async () => {
  await resetEmulators();
});

async function seedBounty(
  state: 'available' | 'claimed',
  expiresAt: Timestamp,
  extra: Record<string, unknown> = {},
): Promise<DocumentReference> {
  const ref = db.collection('groups').doc(GID).collection('bounties').doc();
  await ref.set({
    title: 'Past-due chore',
    description: 'x',
    price: 5,
    state,
    posterId: 'poster-uid',
    claimantId: state === 'claimed' ? 'claimant-uid' : null,
    expiresAt,
    createdAt: Timestamp.now(),
    ...extra,
  });
  return ref;
}

const past = () => Timestamp.fromMillis(Date.now() - HOUR);
const future = () => Timestamp.fromMillis(Date.now() + 24 * HOUR);

describe('runBountyExpiry', () => {
  it('[F1][P1] expires an overdue available bounty and logs a system activity event', async () => {
    const ref = await seedBounty('available', past());

    const count = await runBountyExpiry(db, Timestamp.now());
    expect(count).toBe(1);

    const snap = await ref.get();
    expect(snap.data()?.['state']).toBe('expired');
    expect(snap.data()?.['resolvedAt']).toBeTruthy();

    const activity = await ref.collection('activity').get();
    const expiredEvent = activity.docs.map((d) => d.data()).find((e) => e['kind'] === 'expired');
    expect(expiredEvent).toBeTruthy();
    expect(expiredEvent?.['actorId']).toBe('system');
  });

  it('[F2][P1] expires an overdue claimed bounty without penalising the claimant', async () => {
    const ref = await seedBounty('claimed', past());
    // A member doc for the claimant — expiry must not touch points/losses.
    const memberRef = db.doc(`groups/${GID}/members/claimant-uid`);
    await memberRef.set({ role: 'member', points: 12, wins: 1, losses: 0, displayName: 'Claimy' });

    const count = await runBountyExpiry(db, Timestamp.now());
    expect(count).toBe(1);

    expect((await ref.get()).data()?.['state']).toBe('expired');

    const member = (await memberRef.get()).data();
    expect(member?.['points']).toBe(12); // unchanged
    expect(member?.['losses']).toBe(0); // no loss recorded
    expect(member?.['wins']).toBe(1);
  });

  it('[F3][P1] leaves not-yet-expired bounties alone and excludes expired from active queries', async () => {
    const overdue = await seedBounty('available', past());
    const stillActive = await seedBounty('available', future());
    const claimedActive = await seedBounty('claimed', future());

    const count = await runBountyExpiry(db, Timestamp.now());
    expect(count).toBe(1);

    expect((await overdue.get()).data()?.['state']).toBe('expired');
    expect((await stillActive.get()).data()?.['state']).toBe('available');
    expect((await claimedActive.get()).data()?.['state']).toBe('claimed');

    // The expired bounty no longer shows up under the "available" active query
    // that the feed's Available filter is built on.
    const availableNow = await db
      .collection('groups').doc(GID).collection('bounties')
      .where('state', '==', 'available').get();
    expect(availableNow.docs.map((d) => d.id)).toEqual([stillActive.id]);
  });

  it('[F][P1] is a no-op when nothing is overdue', async () => {
    await seedBounty('available', future());
    const count = await runBountyExpiry(db, Timestamp.now());
    expect(count).toBe(0);
  });

  it('[F][P1] honours the supplied `now` (deterministic, not wall-clock)', async () => {
    // expiresAt is in the future relative to real now, but in the past relative
    // to the `now` we pass in — so it should expire.
    const ref = await seedBounty('available', Timestamp.fromMillis(Date.now() + HOUR));
    const count = await runBountyExpiry(db, Timestamp.fromMillis(Date.now() + 2 * HOUR));
    expect(count).toBe(1);
    expect((await ref.get()).data()?.['state']).toBe('expired');
  });
});
