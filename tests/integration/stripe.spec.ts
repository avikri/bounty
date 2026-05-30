/**
 * Emulator-backed integration tests for the Stripe Connect payment backend.
 *
 * These run fully offline — no calls leave for Stripe's API:
 *  - createIouPaymentIntent is exercised on the paths that never touch Stripe
 *    (caller/state validation and the "creditor not onboarded" branch).
 *  - stripeWebhook is driven by POSTing locally-signed event payloads. The
 *    signature is computed with the same HMAC scheme stripe.webhooks
 *    .constructEvent verifies, using the emulator's STRIPE_WEBHOOK_SECRET
 *    (functions/.secret.local), so settlement, idempotency, the manual-vs-card
 *    race, and the account.updated path are all testable without the network.
 *
 * The happy-path PaymentIntent creation and the Connect onboarding callables
 * make real test-mode Stripe calls and are verified manually (see the plan).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  Timestamp,
  addDoc,
  collection,
  getDocs,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore';
import * as adminApp from 'firebase-admin/app';
import * as adminFs from 'firebase-admin/firestore';
import {
  PROJECT_ID,
  REGION,
  TestUser,
  createUser,
  expectReject,
  resetEmulators,
} from './emulator';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Must match functions/.secret.local (what the emulator hands the webhook).
const WEBHOOK_SECRET = 'whsec_emulator_test_secret';
const WEBHOOK_URL =
  `http://127.0.0.1:5001/${PROJECT_ID}/${REGION}/stripeWebhook`;

// Privileged client (bypasses rules) for seeding Stripe fields the client can't
// write and for reading docs without per-party scoping. Auto-connects to the
// emulator via FIRESTORE_EMULATOR_HOST set by `firebase emulators:exec`.
const admin = adminApp.getApps().length ?
  adminApp.getApps()[0]! :
  adminApp.initializeApp({ projectId: PROJECT_ID });
const adb = adminFs.getFirestore(admin);

interface Fixture {
  poster: TestUser;
  claimant: TestUser;
  groupId: string;
  iouId: string;
}

/** Drive a bounty to approval so a real IOU (poster owes claimant) exists. */
async function seedIou(price = 10): Promise<Fixture> {
  const poster = await createUser('Pat Poster');
  const claimant = await createUser('Casey Claimant');
  const { groupId, inviteCode } = await poster.call<{
    groupId: string;
    inviteCode: string;
  }>('createGroup', { name: 'Roomies' });
  await claimant.call('joinGroup', { inviteCode });

  const ref = await addDoc(collection(poster.db, 'groups', groupId, 'bounties'), {
    title: 'Mow the lawn',
    description: 'front + back',
    price,
    currency: 'NZD',
    state: 'available',
    posterId: poster.uid,
    claimantId: null,
    expiresAt: Timestamp.fromDate(new Date(Date.now() + WEEK_MS)),
    createdAt: serverTimestamp(),
  });
  await claimant.call('claimBounty', { groupId, bountyId: ref.id });
  await claimant.call('submitProof', {
    groupId, bountyId: ref.id, proof: { urls: [], note: 'done' },
  });
  await poster.call('approveBounty', { groupId, bountyId: ref.id });

  const ious = await getDocs(
    query(collection(poster.db, 'ious'), where('debtorId', '==', poster.uid)),
  );
  return { poster, claimant, groupId, iouId: ious.docs[0]!.id };
}

/** Build the `Stripe-Signature` header for a raw payload + secret. */
function signEvent(payload: string, secret = WEBHOOK_SECRET): string {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

async function postWebhook(
  eventBody: Record<string, unknown>,
  opts: { signature?: string } = {},
): Promise<Response> {
  const payload = JSON.stringify(eventBody);
  const signature = opts.signature ?? signEvent(payload);
  return fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
    body: payload,
  });
}

function paymentSucceededEvent(eventId: string, f: Fixture): Record<string, unknown> {
  return {
    id: eventId,
    object: 'event',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: `pi_${eventId}`,
        object: 'payment_intent',
        status: 'succeeded',
        metadata: {
          iouId: f.iouId,
          debtorId: f.poster.uid,
          creditorId: f.claimant.uid,
        },
      },
    },
  };
}

function chargeRefundedEvent(eventId: string, paymentIntentId: string): Record<string, unknown> {
  return {
    id: eventId,
    object: 'event',
    type: 'charge.refunded',
    data: {
      object: {
        id: `ch_${eventId}`,
        object: 'charge',
        payment_intent: paymentIntentId,
        amount_refunded: 1000,
      },
    },
  };
}

function disputeCreatedEvent(eventId: string, paymentIntentId: string): Record<string, unknown> {
  return {
    id: eventId,
    object: 'event',
    type: 'charge.dispute.created',
    data: {
      object: {
        id: `dp_${eventId}`,
        object: 'dispute',
        charge: `ch_${eventId}`,
        payment_intent: paymentIntentId,
        amount: 1000,
        reason: 'fraudulent',
      },
    },
  };
}

async function iouData(iouId: string): Promise<adminFs.DocumentData> {
  const snap = await adb.doc(`ious/${iouId}`).get();
  return snap.data() ?? {};
}

async function inboxKinds(uid: string): Promise<string[]> {
  const snap = await adb.collection(`notifications/${uid}/inbox`).get();
  return snap.docs.map((d) => d.data()['kind'] as string);
}

/** Flip the runtime card-payments kill-switch (config/payments). */
async function setPaymentsFlag(enabled: boolean): Promise<void> {
  await adb.doc('config/payments').set({ stripePaymentsEnabled: enabled });
}

beforeEach(async () => {
  await resetEmulators();
  // The card-path suites below assume payments are enabled; the kill-switch
  // suite overrides this per test. resetEmulators wiped any prior flag doc.
  await setPaymentsFlag(true);
});
afterEach(async () => {
  await resetEmulators();
});
afterAll(async () => {
  await resetEmulators();
});

describe('stripePaymentsEnabled kill-switch', () => {
  it('blocks createIouPaymentIntent when OFF; cash settlement still works', async () => {
    const f = await seedIou();
    await setPaymentsFlag(false);

    await expectReject(
      f.poster.call('createIouPaymentIntent', { iouId: f.iouId }),
      'failed-precondition',
    );
    // The card path wrote nothing — the IOU is untouched.
    const iou = await iouData(f.iouId);
    expect(iou['status']).toBe('open');
    expect(iou['paymentMethod']).toBeUndefined();
    expect(iou['awaitingCreditorOnboarding']).toBeUndefined();

    // Cash settlement is completely unaffected by the flag.
    await f.poster.call('markIouPaid', { iouId: f.iouId });
    const res = await f.claimant.call<{ settled: boolean }>(
      'markIouPaid', { iouId: f.iouId });
    expect(res.settled).toBe(true);
    expect((await iouData(f.iouId))['status']).toBe('settled');
  });

  it('blocks Connect onboarding when OFF', async () => {
    const f = await seedIou();
    await setPaymentsFlag(false);
    await expectReject(
      f.claimant.call('createConnectAccountAndOnboardingLink', {}),
      'failed-precondition',
    );
  });

  it('defaults OFF when the config doc is absent', async () => {
    const f = await seedIou();
    await adb.doc('config/payments').delete(); // remove the beforeEach flag
    await expectReject(
      f.poster.call('createIouPaymentIntent', { iouId: f.iouId }),
      'failed-precondition',
    );
  });

  it('lets the card path through to validation when ON', async () => {
    const f = await seedIou();
    await setPaymentsFlag(true);
    // Creditor isn't onboarded → distinct non-error result, proving the flag
    // let the request past the kill-switch and into the normal card flow.
    const res = await f.poster.call<{ status: string }>(
      'createIouPaymentIntent', { iouId: f.iouId },
    );
    expect(res.status).toBe('creditor_not_onboarded');
  });
});

describe('createIouPaymentIntent (validation + lazy onboarding)', () => {
  it('rejects a non-debtor caller', async () => {
    const f = await seedIou();
    await expectReject(
      f.claimant.call('createIouPaymentIntent', { iouId: f.iouId }),
      'permission-denied',
    );
  });

  it('rejects an already-settled IOU', async () => {
    const f = await seedIou();
    await f.poster.call('markIouPaid', { iouId: f.iouId });
    await f.claimant.call('markIouPaid', { iouId: f.iouId }); // → settled
    await expectReject(
      f.poster.call('createIouPaymentIntent', { iouId: f.iouId }),
      'failed-precondition',
    );
  });

  it('returns creditor_not_onboarded, flags the IOU and notifies the creditor', async () => {
    const f = await seedIou();
    const res = await f.poster.call<{ status: string }>(
      'createIouPaymentIntent', { iouId: f.iouId },
    );
    expect(res.status).toBe('creditor_not_onboarded');

    const iou = await iouData(f.iouId);
    expect(iou['awaitingCreditorOnboarding']).toBe(true);
    expect(iou['creditorPayable']).toBe(false);
    expect(iou['status']).toBe('open'); // not settled

    expect(await inboxKinds(f.claimant.uid)).toContain('iou_payment_request');
  });
});

describe('stripeWebhook signature verification', () => {
  it('rejects a bad signature with 400 and does not settle', async () => {
    const f = await seedIou();
    const res = await postWebhook(paymentSucceededEvent('evt_bad', f), {
      signature: 't=1,v1=deadbeef',
    });
    expect(res.status).toBe(400);
    expect((await iouData(f.iouId))['status']).toBe('open');
  });

  it('rejects a payload signed with the wrong secret', async () => {
    const f = await seedIou();
    const payload = JSON.stringify(paymentSucceededEvent('evt_wrong', f));
    const res = await postWebhook(paymentSucceededEvent('evt_wrong', f), {
      signature: signEvent(payload, 'whsec_not_the_real_secret'),
    });
    expect(res.status).toBe(400);
  });
});

describe('stripeWebhook payment_intent.succeeded → settle', () => {
  it('settles the IOU once and notifies both parties', async () => {
    const f = await seedIou(10);
    const res = await postWebhook(paymentSucceededEvent('evt_settle', f));
    expect(res.status).toBe(200);

    const iou = await iouData(f.iouId);
    expect(iou['status']).toBe('settled');
    expect(iou['settledAt']).toBeTruthy();
    expect(iou['paymentMethod']).toBe('stripe');
    expect(iou['stripePaymentIntentId']).toBe('pi_evt_settle');
    expect(iou['stripeStatus']).toBe('succeeded');

    // Existing "settled" notice to both, plus the card-specific receipt.
    expect(await inboxKinds(f.poster.uid)).toContain('iou_settled');
    const creditorKinds = await inboxKinds(f.claimant.uid);
    expect(creditorKinds).toContain('iou_settled');
    expect(creditorKinds).toContain('iou_payment_received');
  });

  it('is idempotent across redelivery of the same event id', async () => {
    const f = await seedIou();
    const event = paymentSucceededEvent('evt_dupe', f);
    await postWebhook(event);
    const settledAt = (await iouData(f.iouId))['settledAt'];

    // Stripe redelivers the identical event.
    const res2 = await postWebhook(event);
    expect(res2.status).toBe(200);

    const iou = await iouData(f.iouId);
    expect(iou['status']).toBe('settled');
    // Not re-settled (timestamp unchanged) and only one receipt was written.
    expect((iou['settledAt'] as adminFs.Timestamp).isEqual(
      settledAt as adminFs.Timestamp)).toBe(true);
    const receipts = (await inboxKinds(f.claimant.uid))
      .filter((k) => k === 'iou_payment_received');
    expect(receipts).toHaveLength(1);
  });

  it('does not re-settle an IOU already settled manually (race-safe no-op)', async () => {
    const f = await seedIou();
    // Manual settle wins first.
    await f.poster.call('markIouPaid', { iouId: f.iouId });
    await f.claimant.call('markIouPaid', { iouId: f.iouId });
    const before = await iouData(f.iouId);
    expect(before['status']).toBe('settled');

    const res = await postWebhook(paymentSucceededEvent('evt_race', f));
    expect(res.status).toBe(200);

    const after = await iouData(f.iouId);
    expect(after['status']).toBe('settled');
    // Settlement timestamp from the manual flow is preserved...
    expect((after['settledAt'] as adminFs.Timestamp).isEqual(
      before['settledAt'] as adminFs.Timestamp)).toBe(true);
    // ...but the PI is recorded for the audit trail.
    expect(after['stripePaymentIntentId']).toBe('pi_evt_race');
  });

  it('ignores a PaymentIntent missing iouId metadata', async () => {
    const f = await seedIou();
    const res = await postWebhook({
      id: 'evt_nometa',
      object: 'event',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_nometa', object: 'payment_intent', status: 'succeeded' } },
    });
    expect(res.status).toBe(200);
    expect((await iouData(f.iouId))['status']).toBe('open');
  });
});

describe('stripeWebhook charge.refunded / charge.dispute.created (log + notify, keep settled)', () => {
  /** Settle an IOU by card so it has a known stripePaymentIntentId. */
  async function settledFixture(): Promise<{ f: Fixture; pi: string }> {
    const f = await seedIou(10);
    await postWebhook(paymentSucceededEvent('evt_pre_settle', f));
    expect((await iouData(f.iouId))['status']).toBe('settled');
    return { f, pi: 'pi_evt_pre_settle' };
  }

  it('refund: notifies both parties and leaves the IOU settled', async () => {
    const { f, pi } = await settledFixture();
    const res = await postWebhook(chargeRefundedEvent('evt_refund', pi));
    expect(res.status).toBe(200);

    const iou = await iouData(f.iouId);
    expect(iou['status']).toBe('settled'); // NOT reopened
    expect(iou['stripeRefunded']).toBe(true);
    expect(await inboxKinds(f.poster.uid)).toContain('iou_payment_refunded');
    expect(await inboxKinds(f.claimant.uid)).toContain('iou_payment_refunded');
  });

  it('refund: is idempotent across redelivery', async () => {
    const { f, pi } = await settledFixture();
    await postWebhook(chargeRefundedEvent('evt_refund_dupe', pi));
    const res2 = await postWebhook(chargeRefundedEvent('evt_refund_dupe', pi));
    expect(res2.status).toBe(200);
    const refunds = (await inboxKinds(f.poster.uid))
      .filter((k) => k === 'iou_payment_refunded');
    expect(refunds).toHaveLength(1);
  });

  it('dispute: notifies both parties and leaves the IOU settled', async () => {
    const { f, pi } = await settledFixture();
    const res = await postWebhook(disputeCreatedEvent('evt_dispute', pi));
    expect(res.status).toBe(200);

    const iou = await iouData(f.iouId);
    expect(iou['status']).toBe('settled');
    expect(iou['stripeDisputed']).toBe(true);
    expect(await inboxKinds(f.poster.uid)).toContain('iou_payment_disputed');
    expect(await inboxKinds(f.claimant.uid)).toContain('iou_payment_disputed');
  });

  it('ignores a refund for an unknown payment_intent', async () => {
    const f = await seedIou();
    const res = await postWebhook(chargeRefundedEvent('evt_unknown', 'pi_does_not_exist'));
    expect(res.status).toBe(200);
    expect((await iouData(f.iouId))['stripeRefunded']).toBeUndefined();
  });
});

describe('stripeWebhook account.updated → payable + notify waiting debtor', () => {
  it('marks the creditor payable and pings the debtor who was waiting', async () => {
    const f = await seedIou();
    const accountId = 'acct_test_creditor';

    // Debtor tried to pay before the creditor onboarded → IOU flagged waiting.
    await f.poster.call('createIouPaymentIntent', { iouId: f.iouId });
    expect((await iouData(f.iouId))['awaitingCreditorOnboarding']).toBe(true);

    // Link the connected account to the creditor (only Cloud Functions / admin
    // may write these fields).
    await adb.doc(`users/${f.claimant.uid}`).set(
      { stripeConnectAccountId: accountId, stripePayable: false },
      { merge: true },
    );

    const res = await postWebhook({
      id: 'evt_acct',
      object: 'event',
      type: 'account.updated',
      data: {
        object: {
          id: accountId,
          object: 'account',
          charges_enabled: true,
          payouts_enabled: true,
        },
      },
    });
    expect(res.status).toBe(200);

    // Creditor is now payable.
    const user = (await adb.doc(`users/${f.claimant.uid}`).get()).data() ?? {};
    expect(user['stripePayable']).toBe(true);
    expect(user['stripeChargesEnabled']).toBe(true);
    expect(user['stripePayoutsEnabled']).toBe(true);

    // The waiting IOU is updated and the debtor is notified.
    const iou = await iouData(f.iouId);
    expect(iou['creditorPayable']).toBe(true);
    expect(iou['awaitingCreditorOnboarding']).toBe(false);
    expect(await inboxKinds(f.poster.uid)).toContain('iou_creditor_ready');
  });

  it('does not notify when the account is not yet payable', async () => {
    const f = await seedIou();
    const accountId = 'acct_pending';
    await f.poster.call('createIouPaymentIntent', { iouId: f.iouId });
    await adb.doc(`users/${f.claimant.uid}`).set(
      { stripeConnectAccountId: accountId, stripePayable: false },
      { merge: true },
    );

    const res = await postWebhook({
      id: 'evt_pending',
      object: 'event',
      type: 'account.updated',
      data: {
        object: {
          id: accountId,
          object: 'account',
          charges_enabled: false,
          payouts_enabled: false,
        },
      },
    });
    expect(res.status).toBe(200);

    expect((await iouData(f.iouId))['awaitingCreditorOnboarding']).toBe(true);
    expect(await inboxKinds(f.poster.uid)).not.toContain('iou_creditor_ready');
  });
});
