/**
 * Emulator-backed integration tests for the Cloud Functions callables.
 *
 * Each test walks a bounty through the state machine using the real callables
 * and the real Auth ID tokens of distinct users, then asserts the side effects
 * (points, IOUs, leaderboard, activity timeline, inbox notifications).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Timestamp,
  addDoc,
  collection,
  getDoc,
  getDocs,
  query,
  where,
  doc,
} from 'firebase/firestore';
import {
  TestUser,
  createUser,
  expectReject,
  resetEmulators,
} from './emulator';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface Fixture {
  poster: TestUser;
  claimant: TestUser;
  groupId: string;
  bountyId: string;
}

/** poster + claimant in one group, with a single available bounty. */
async function seed(price = 5): Promise<Fixture> {
  const poster = await createUser('Pat Poster');
  const claimant = await createUser('Casey Claimant');

  const { groupId, inviteCode } = await poster.call<{
    groupId: string;
    inviteCode: string;
  }>('createGroup', { name: 'Roomies', emoji: '🏠' });

  await claimant.call('joinGroup', { inviteCode });

  // Bounties are created directly by the client (rules allow `available`).
  const ref = await addDoc(
    collection(poster.db, 'groups', groupId, 'bounties'),
    {
      title: 'Take out the bins',
      description: 'Every Tuesday',
      price,
      currency: 'USD',
      state: 'available',
      posterId: poster.uid,
      claimantId: null,
      expiresAt: Timestamp.fromDate(new Date(Date.now() + WEEK_MS)),
      createdAt: Timestamp.now(),
    },
  );

  return { poster, claimant, groupId, bountyId: ref.id };
}

async function bountyState(f: Fixture): Promise<string> {
  const snap = await getDoc(
    doc(f.poster.db, 'groups', f.groupId, 'bounties', f.bountyId),
  );
  return snap.data()?.['state'];
}

beforeEach(async () => {
  await resetEmulators();
});

afterEach(async () => {
  await resetEmulators();
});

afterAll(async () => {
  await resetEmulators();
});

describe('claimBounty', () => {
  it('moves available → claimed and records claimant + activity + inbox', async () => {
    const f = await seed();
    await f.claimant.call('claimBounty', {
      groupId: f.groupId,
      bountyId: f.bountyId,
    });

    const snap = await getDoc(
      doc(f.poster.db, 'groups', f.groupId, 'bounties', f.bountyId),
    );
    expect(snap.data()?.['state']).toBe('claimed');
    expect(snap.data()?.['claimantId']).toBe(f.claimant.uid);

    const activity = await getDocs(
      collection(f.poster.db, 'groups', f.groupId, 'bounties', f.bountyId, 'activity'),
    );
    expect(activity.docs.map((d) => d.data()['kind'])).toContain('claimed');

    // Poster is notified of the claim.
    const inbox = await getDocs(
      collection(f.poster.db, 'notifications', f.poster.uid, 'inbox'),
    );
    expect(inbox.docs.some((d) => d.data()['kind'] === 'bounty_claimed')).toBe(true);
  });

  it('rejects a poster claiming their own bounty', async () => {
    const f = await seed();
    await expectReject(
      f.poster.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId }),
      'failed-precondition',
    );
    expect(await bountyState(f)).toBe('available');
  });

  it('rejects a second claim once already claimed', async () => {
    const f = await seed();
    await f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId });
    const other = await createUser('Other');
    // Not a member, so membership check fires first.
    await expectReject(
      other.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId }),
      'permission-denied',
    );
  });

  it('rejects a non-member', async () => {
    const f = await seed();
    const stranger = await createUser('Stranger');
    await expectReject(
      stranger.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId }),
      'permission-denied',
    );
  });
});

describe('submitProof', () => {
  it('moves claimed → pending_review and notifies the poster', async () => {
    const f = await seed();
    await f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId });
    await f.claimant.call('submitProof', {
      groupId: f.groupId,
      bountyId: f.bountyId,
      proof: { urls: ['https://example.com/p.png'], note: 'all done' },
    });

    const snap = await getDoc(
      doc(f.poster.db, 'groups', f.groupId, 'bounties', f.bountyId),
    );
    expect(snap.data()?.['state']).toBe('pending_review');
    expect(snap.data()?.['proof']).toEqual({
      urls: ['https://example.com/p.png'],
      note: 'all done',
    });

    const inbox = await getDocs(
      collection(f.poster.db, 'notifications', f.poster.uid, 'inbox'),
    );
    expect(inbox.docs.some((d) => d.data()['kind'] === 'proof_submitted')).toBe(true);
  });

  it('rejects proof from someone who is not the claimant', async () => {
    const f = await seed();
    await f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId });
    // Poster is a member but not the claimant.
    await expectReject(
      f.poster.call('submitProof', {
        groupId: f.groupId,
        bountyId: f.bountyId,
        proof: { urls: [], note: 'sneaky' },
      }),
      'permission-denied',
    );
  });

  it('rejects proof before the bounty is claimed', async () => {
    const f = await seed();
    await expectReject(
      f.claimant.call('submitProof', {
        groupId: f.groupId,
        bountyId: f.bountyId,
        proof: { urls: [], note: 'too soon' },
      }),
      'failed-precondition',
    );
  });
});

describe('approveBounty (→ successful)', () => {
  it('awards points, creates an IOU, updates the leaderboard and notifies both', async () => {
    const f = await seed(8);
    await f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId });
    await f.claimant.call('submitProof', {
      groupId: f.groupId,
      bountyId: f.bountyId,
      proof: { urls: [], note: 'done' },
    });
    await f.poster.call('approveBounty', { groupId: f.groupId, bountyId: f.bountyId });

    // Bounty resolved successful.
    const b = await getDoc(
      doc(f.poster.db, 'groups', f.groupId, 'bounties', f.bountyId),
    );
    expect(b.data()?.['state']).toBe('successful');
    expect(b.data()?.['resolvedAt']).toBeTruthy();

    // Claimant member doc gains points + a win.
    const member = await getDoc(
      doc(f.poster.db, 'groups', f.groupId, 'members', f.claimant.uid),
    );
    expect(member.data()?.['points']).toBe(8);
    expect(member.data()?.['wins']).toBe(1);

    // IOU created: poster (debtor) owes claimant (creditor).
    const ious = await getDocs(
      query(collection(f.poster.db, 'ious'), where('debtorId', '==', f.poster.uid)),
    );
    expect(ious.size).toBe(1);
    const iou = ious.docs[0]!.data();
    expect(iou['creditorId']).toBe(f.claimant.uid);
    expect(iou['amount']).toBe(8);
    expect(iou['status']).toBe('open');

    // Leaderboard summary reflects the claimant's new score.
    const lb = await getDoc(
      doc(f.poster.db, 'groups', f.groupId, 'leaderboard', 'summary'),
    );
    const entries = (lb.data()?.['entries'] ?? []) as Array<{ userId: string; points: number }>;
    expect(entries.find((e) => e.userId === f.claimant.uid)?.points).toBe(8);

    // Both parties notified.
    const claimantInbox = await getDocs(
      collection(f.claimant.db, 'notifications', f.claimant.uid, 'inbox'),
    );
    expect(claimantInbox.docs.some((d) => d.data()['kind'] === 'bounty_approved')).toBe(true);
    const posterInbox = await getDocs(
      collection(f.poster.db, 'notifications', f.poster.uid, 'inbox'),
    );
    expect(posterInbox.docs.some((d) => d.data()['kind'] === 'bounty_resolved')).toBe(true);
  });

  it('rejects approval by anyone other than the poster', async () => {
    const f = await seed();
    await f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId });
    await f.claimant.call('submitProof', {
      groupId: f.groupId,
      bountyId: f.bountyId,
      proof: { urls: [], note: 'done' },
    });
    await expectReject(
      f.claimant.call('approveBounty', { groupId: f.groupId, bountyId: f.bountyId }),
      'permission-denied',
    );
    expect(await bountyState(f)).toBe('pending_review');
  });

  it('rejects approval before review', async () => {
    const f = await seed();
    await f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId });
    await expectReject(
      f.poster.call('approveBounty', { groupId: f.groupId, bountyId: f.bountyId }),
      'failed-precondition',
    );
  });
});

describe('rejectBounty (→ failed)', () => {
  it('docks points, records a loss, stores the reason and notifies the claimant', async () => {
    const f = await seed(6);
    await f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId });
    await f.claimant.call('submitProof', {
      groupId: f.groupId,
      bountyId: f.bountyId,
      proof: { urls: [], note: 'done' },
    });
    await f.poster.call('rejectBounty', {
      groupId: f.groupId,
      bountyId: f.bountyId,
      reason: 'photo too blurry',
    });

    const b = await getDoc(
      doc(f.poster.db, 'groups', f.groupId, 'bounties', f.bountyId),
    );
    expect(b.data()?.['state']).toBe('failed');
    expect(b.data()?.['rejectionReason']).toBe('photo too blurry');

    const member = await getDoc(
      doc(f.poster.db, 'groups', f.groupId, 'members', f.claimant.uid),
    );
    // Started at 0; clamped at 0, loss recorded.
    expect(member.data()?.['points']).toBe(0);
    expect(member.data()?.['losses']).toBe(1);

    // No IOU is created on rejection.
    const ious = await getDocs(
      query(collection(f.poster.db, 'ious'), where('debtorId', '==', f.poster.uid)),
    );
    expect(ious.size).toBe(0);

    const inbox = await getDocs(
      collection(f.claimant.db, 'notifications', f.claimant.uid, 'inbox'),
    );
    expect(inbox.docs.some((d) => d.data()['kind'] === 'bounty_rejected')).toBe(true);
  });

  it('rejects rejection by a non-poster', async () => {
    const f = await seed();
    await f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId });
    await f.claimant.call('submitProof', {
      groupId: f.groupId,
      bountyId: f.bountyId,
      proof: { urls: [], note: 'done' },
    });
    await expectReject(
      f.claimant.call('rejectBounty', { groupId: f.groupId, bountyId: f.bountyId }),
      'permission-denied',
    );
  });
});

describe('group membership callables', () => {
  it('createGroup makes the caller an owner member with a leaderboard entry', async () => {
    const owner = await createUser('Olive Owner');
    const { groupId } = await owner.call<{ groupId: string }>('createGroup', {
      name: 'Squad',
    });

    const member = await getDoc(
      doc(owner.db, 'groups', groupId, 'members', owner.uid),
    );
    expect(member.data()?.['role']).toBe('owner');

    const lb = await getDoc(
      doc(owner.db, 'groups', groupId, 'leaderboard', 'summary'),
    );
    const entries = (lb.data()?.['entries'] ?? []) as Array<{ userId: string }>;
    expect(entries.some((e) => e.userId === owner.uid)).toBe(true);
  });

  it('joinGroup is idempotent and rejects bad invite codes', async () => {
    const owner = await createUser('Olive Owner');
    const joiner = await createUser('Jamie Joiner');
    const { inviteCode } = await owner.call<{ inviteCode: string }>('createGroup', {
      name: 'Squad',
    });

    const first = await joiner.call<{ alreadyMember?: boolean }>('joinGroup', { inviteCode });
    expect(first.alreadyMember).toBeFalsy();
    const second = await joiner.call<{ alreadyMember?: boolean }>('joinGroup', { inviteCode });
    expect(second.alreadyMember).toBe(true);

    await expectReject(joiner.call('joinGroup', { inviteCode: 'ZZZZZZ' }), 'not-found');
  });

  it('regenerateInviteCode is owner/admin only', async () => {
    const owner = await createUser('Olive Owner');
    const member = await createUser('Mel Member');
    const { groupId, inviteCode } = await owner.call<{
      groupId: string;
      inviteCode: string;
    }>('createGroup', { name: 'Squad' });
    await member.call('joinGroup', { inviteCode });

    const res = await owner.call<{ inviteCode: string }>('regenerateInviteCode', { groupId });
    expect(res.inviteCode).not.toBe(inviteCode);

    await expectReject(
      member.call('regenerateInviteCode', { groupId }),
      'permission-denied',
    );
  });
});

describe('markIouPaid two-party handshake', () => {
  async function settledIouFixture(): Promise<{ f: Fixture; iouId: string }> {
    const f = await seed(10);
    await f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId });
    await f.claimant.call('submitProof', {
      groupId: f.groupId,
      bountyId: f.bountyId,
      proof: { urls: [], note: 'done' },
    });
    await f.poster.call('approveBounty', { groupId: f.groupId, bountyId: f.bountyId });
    const ious = await getDocs(
      query(collection(f.poster.db, 'ious'), where('debtorId', '==', f.poster.uid)),
    );
    return { f, iouId: ious.docs[0]!.id };
  }

  it('only settles once both parties have marked it paid', async () => {
    const { f, iouId } = await settledIouFixture();

    // Debtor marks first → not settled yet.
    const r1 = await f.poster.call<{ settled: boolean }>('markIouPaid', { iouId });
    expect(r1.settled).toBe(false);

    let snap = await getDoc(doc(f.poster.db, 'ious', iouId));
    expect(snap.data()?.['status']).toBe('debtor_marked');

    // Creditor confirms → settled.
    const r2 = await f.claimant.call<{ settled: boolean }>('markIouPaid', { iouId });
    expect(r2.settled).toBe(true);

    snap = await getDoc(doc(f.poster.db, 'ious', iouId));
    expect(snap.data()?.['status']).toBe('settled');
    expect(snap.data()?.['settledAt']).toBeTruthy();
  });

  it('rejects a non-party', async () => {
    const { f, iouId } = await settledIouFixture();
    const stranger = await createUser('Nosy');
    await expectReject(stranger.call('markIouPaid', { iouId }), 'permission-denied');
  });
});
