/**
 * Privileged seeding via firebase-admin (bypasses security rules) for the few
 * E2E setups the client can't legitimately create:
 *  - backdated inbox notifications (rules forbid client create) — for the inbox
 *    day-grouping test [I2];
 *  - forcing a bounty into the `expired` state without waiting for the nightly
 *    sweep — for the Expired-badge check [F].
 */
import { App, deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'bounty-c5ee6';
process.env['FIRESTORE_EMULATOR_HOST'] ??= '127.0.0.1:8080';

let app: App | undefined;

function adminDb(): Firestore {
  if (!app) {
    app = getApps().find((a) => a.name === 'e2e-admin')
      ?? initializeApp({ projectId: PROJECT_ID }, 'e2e-admin');
  }
  return getFirestore(app);
}

/** Insert an inbox notification for `uid` with an explicit `createdAt`. */
export async function seedNotification(
  uid: string,
  payload: Record<string, unknown>,
  createdAt: Date,
): Promise<void> {
  await adminDb().collection(`notifications/${uid}/inbox`).add({
    read: false,
    title: 'Seeded',
    body: 'seeded notification',
    ...payload,
    createdAt: Timestamp.fromDate(createdAt),
  });
}

/** Force a bounty into the `expired` terminal state (as the sweep would). */
export async function forceExpire(groupId: string, bountyId: string): Promise<void> {
  const ref = adminDb().doc(`groups/${groupId}/bounties/${bountyId}`);
  const now = Timestamp.now();
  await ref.update({ state: 'expired', resolvedAt: now });
  await ref.collection('activity').add({ kind: 'expired', actorId: 'system', at: now });
}

export async function disposeAdmin(): Promise<void> {
  if (app) { await deleteApp(app).catch(() => undefined); app = undefined; }
}
