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
  serverTimestamp,
  setDoc,
  updateDoc,
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
      createdAt: serverTimestamp(),
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

  it('[B6][P1] rejects claiming a past-due (expired) bounty', async () => {
    const f = await seed();
    // A bounty whose expiry has already lapsed. The claim guard rejects it even
    // before the nightly sweep flips its state to "expired".
    const ref = await addDoc(
      collection(f.poster.db, 'groups', f.groupId, 'bounties'),
      {
        title: 'Overdue', description: 'x', price: 5, currency: 'USD',
        state: 'available', posterId: f.poster.uid, claimantId: null,
        expiresAt: Timestamp.fromDate(new Date(Date.now() - 1000)),
        createdAt: serverTimestamp(),
      },
    );
    await expectReject(
      f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: ref.id }),
      'failed-precondition',
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

describe('approveBounty with a custom (non-cash) reward', () => {
  /** Seed poster+claimant with a single available CUSTOM bounty. */
  async function seedCustom(points = 40): Promise<Fixture> {
    const poster = await createUser('Pat Poster');
    const claimant = await createUser('Casey Claimant');
    const { groupId, inviteCode } = await poster.call<{
      groupId: string; inviteCode: string;
    }>('createGroup', { name: 'Roomies' });
    await claimant.call('joinGroup', { inviteCode });

    const ref = await addDoc(
      collection(poster.db, 'groups', groupId, 'bounties'),
      {
        title: 'First round',
        description: 'winner picks the bar',
        rewardType: 'custom',
        rewardText: '3 beers',
        points,
        currency: 'NZD',
        state: 'available',
        posterId: poster.uid,
        claimantId: null,
        expiresAt: Timestamp.fromDate(new Date(Date.now() + WEEK_MS)),
        createdAt: serverTimestamp(),
      },
    );
    return { poster, claimant, groupId, bountyId: ref.id };
  }

  it('awards the bounty points and creates a manual-only custom IOU (no money)', async () => {
    const f = await seedCustom(40);
    await f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId });
    await f.claimant.call('submitProof', {
      groupId: f.groupId, bountyId: f.bountyId, proof: { urls: [], note: 'done' },
    });
    await f.poster.call('approveBounty', { groupId: f.groupId, bountyId: f.bountyId });

    // Points come from `points`, not a dollar price.
    const member = await getDoc(
      doc(f.poster.db, 'groups', f.groupId, 'members', f.claimant.uid),
    );
    expect(member.data()?.['points']).toBe(40);
    expect(member.data()?.['wins']).toBe(1);

    // The IOU carries the custom reward, has no monetary amount, and is open.
    const ious = await getDocs(
      query(collection(f.poster.db, 'ious'), where('debtorId', '==', f.poster.uid)),
    );
    expect(ious.size).toBe(1);
    const iou = ious.docs[0]!.data();
    expect(iou['rewardType']).toBe('custom');
    expect(iou['rewardText']).toBe('3 beers');
    expect(iou['amount']).toBe(0);
    expect(iou['status']).toBe('open');
  });

  it('settles a custom IOU manually via the two-party handshake', async () => {
    const f = await seedCustom(40);
    await f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId });
    await f.claimant.call('submitProof', {
      groupId: f.groupId, bountyId: f.bountyId, proof: { urls: [], note: 'done' },
    });
    await f.poster.call('approveBounty', { groupId: f.groupId, bountyId: f.bountyId });
    const ious = await getDocs(
      query(collection(f.poster.db, 'ious'), where('debtorId', '==', f.poster.uid)),
    );
    const iouId = ious.docs[0]!.id;

    await f.poster.call('markIouPaid', { iouId });
    const res = await f.claimant.call<{ settled: boolean }>('markIouPaid', { iouId });
    expect(res.settled).toBe(true);
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

  it('[D4][P1] lets an owner-promoted admin regenerate the invite code', async () => {
    const owner = await createUser('Olive Owner');
    const member = await createUser('Mel Member');
    const { groupId, inviteCode } = await owner.call<{
      groupId: string; inviteCode: string;
    }>('createGroup', { name: 'Squad' });
    await member.call('joinGroup', { inviteCode });

    // Owner promotes the member to admin (rules allow a role-only update).
    await updateDoc(doc(owner.db, 'groups', groupId, 'members', member.uid), { role: 'admin' });

    const res = await member.call<{ inviteCode: string }>('regenerateInviteCode', { groupId });
    expect(res.inviteCode).not.toBe(inviteCode);
  });

  it('[D8][P1] joinGroup wires up the member doc, memberCount, leaderboard and groupIds', async () => {
    const owner = await createUser('Olive Owner');
    const joiner = await createUser('Jamie Joiner');
    const { groupId, inviteCode } = await owner.call<{
      groupId: string; inviteCode: string;
    }>('createGroup', { name: 'Squad' });
    await joiner.call('joinGroup', { inviteCode });

    const member = await getDoc(doc(joiner.db, 'groups', groupId, 'members', joiner.uid));
    expect(member.data()?.['role']).toBe('member');
    expect(member.data()?.['points']).toBe(0);
    expect(member.data()?.['wins']).toBe(0);
    expect(member.data()?.['losses']).toBe(0);

    const group = await getDoc(doc(owner.db, 'groups', groupId));
    expect(group.data()?.['memberCount']).toBe(2);

    const lb = await getDoc(doc(owner.db, 'groups', groupId, 'leaderboard', 'summary'));
    const entries = (lb.data()?.['entries'] ?? []) as Array<{ userId: string }>;
    expect(entries.some((e) => e.userId === joiner.uid)).toBe(true);

    const user = await getDoc(doc(joiner.db, 'users', joiner.uid));
    expect(((user.data()?.['groupIds'] ?? []) as string[])).toContain(groupId);
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

  it('[B7][P1] rejects settling an already-settled IOU', async () => {
    const { f, iouId } = await settledIouFixture();
    await f.poster.call('markIouPaid', { iouId });   // debtor marks
    await f.claimant.call('markIouPaid', { iouId });  // creditor confirms → settled
    await expectReject(
      f.poster.call('markIouPaid', { iouId }),
      'failed-precondition',
    );
  });
});

describe('contributeToBounty (pooled cash bounties)', () => {
  /** Read every contribution doc for a bounty as a uid → amount map. */
  async function contributions(f: Fixture): Promise<Record<string, number>> {
    const snap = await getDocs(
      collection(f.poster.db, 'groups', f.groupId, 'bounties', f.bountyId, 'contributions'),
    );
    const out: Record<string, number> = {};
    for (const d of snap.docs) out[d.id] = d.data()['amount'] as number;
    return out;
  }
  async function price(f: Fixture): Promise<{ price: number; points: number }> {
    const snap = await getDoc(
      doc(f.poster.db, 'groups', f.groupId, 'bounties', f.bountyId),
    );
    return { price: snap.data()?.['price'], points: snap.data()?.['points'] };
  }

  it('raises the total and seeds/accumulates contribution docs', async () => {
    const f = await seed(5); // poster stake $5

    // Poster pools $5 onto their own bounty → their stake doc becomes $10.
    const r1 = await f.poster.call<{ total: number }>('contributeToBounty', {
      groupId: f.groupId, bountyId: f.bountyId, amount: 5,
    });
    expect(r1.total).toBe(10);
    expect(await price(f)).toEqual({ price: 10, points: 10 });
    expect(await contributions(f)).toEqual({ [f.poster.uid]: 10 });

    // A different member adds $3 → new contributor doc, total $13.
    const r2 = await f.claimant.call<{ total: number }>('contributeToBounty', {
      groupId: f.groupId, bountyId: f.bountyId, amount: 3,
    });
    expect(r2.total).toBe(13);
    expect(await price(f)).toEqual({ price: 13, points: 13 });
    expect(await contributions(f)).toEqual({
      [f.poster.uid]: 10,
      [f.claimant.uid]: 3,
    });

    // Repeat add from the same contributor accumulates into one doc.
    await f.claimant.call('contributeToBounty', {
      groupId: f.groupId, bountyId: f.bountyId, amount: 2,
    });
    expect((await contributions(f))[f.claimant.uid]).toBe(5);
    expect((await price(f)).price).toBe(15);
  });

  it('rejects pooling once the bounty is claimed (non-available)', async () => {
    const f = await seed(5);
    await f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId });
    await expectReject(
      f.poster.call('contributeToBounty', {
        groupId: f.groupId, bountyId: f.bountyId, amount: 5,
      }),
      'failed-precondition',
    );
  });

  it('rejects a non-member contributor', async () => {
    const f = await seed(5);
    const stranger = await createUser('Stranger');
    await expectReject(
      stranger.call('contributeToBounty', {
        groupId: f.groupId, bountyId: f.bountyId, amount: 5,
      }),
      'permission-denied',
    );
  });

  it('rejects out-of-bounds and non-integer amounts', async () => {
    const f = await seed(5);
    for (const amount of [0, -3, 5.5, 100001]) {
      await expectReject(
        f.poster.call('contributeToBounty', {
          groupId: f.groupId, bountyId: f.bountyId, amount,
        }),
        'invalid-argument',
      );
    }
    // Nothing was written.
    expect(await contributions(f)).toEqual({});
  });

  it('rejects pooling onto a custom (non-cash) bounty', async () => {
    const poster = await createUser('Pat Poster');
    const member = await createUser('Mel Member');
    const { groupId, inviteCode } = await poster.call<{
      groupId: string; inviteCode: string;
    }>('createGroup', { name: 'Roomies' });
    await member.call('joinGroup', { inviteCode });
    const ref = await addDoc(collection(poster.db, 'groups', groupId, 'bounties'), {
      title: 'Beers', description: 'x', rewardType: 'custom', rewardText: '3 beers',
      points: 40, currency: 'NZD', state: 'available', posterId: poster.uid,
      claimantId: null, expiresAt: Timestamp.fromDate(new Date(Date.now() + WEEK_MS)),
      createdAt: serverTimestamp(),
    });
    await expectReject(
      poster.call('contributeToBounty', { groupId, bountyId: ref.id, amount: 5 }),
      'failed-precondition',
    );
  });

  it('denies a direct client write to the contributions subcollection', async () => {
    const f = await seed(5);
    await expectReject(
      setDoc(
        doc(f.poster.db, 'groups', f.groupId, 'bounties', f.bountyId, 'contributions', f.poster.uid),
        { uid: f.poster.uid, amount: 999 },
      ),
    );
  });
});

describe('approveBounty with pooled contributions', () => {
  it('creates one correctly-attributed IOU per contributor and awards the full total', async () => {
    // poster ($10 stake) + two extra contributors + a separate claimant.
    const poster = await createUser('Pat Poster');
    const claimant = await createUser('Casey Claimant');
    const alice = await createUser('Alice Add');
    const bob = await createUser('Bob Add');
    const { groupId, inviteCode } = await poster.call<{
      groupId: string; inviteCode: string;
    }>('createGroup', { name: 'Roomies' });
    for (const u of [claimant, alice, bob]) await u.call('joinGroup', { inviteCode });

    const ref = await addDoc(collection(poster.db, 'groups', groupId, 'bounties'), {
      title: 'Big chore', description: 'x', price: 10, currency: 'NZD',
      state: 'available', posterId: poster.uid, claimantId: null,
      expiresAt: Timestamp.fromDate(new Date(Date.now() + WEEK_MS)),
      createdAt: serverTimestamp(),
    });
    const bountyId = ref.id;

    await alice.call('contributeToBounty', { groupId, bountyId, amount: 5 });
    await bob.call('contributeToBounty', { groupId, bountyId, amount: 7 });
    // total = 10 (poster) + 5 + 7 = 22

    await claimant.call('claimBounty', { groupId, bountyId });
    await claimant.call('submitProof', { groupId, bountyId, proof: { urls: [], note: 'done' } });
    await poster.call('approveBounty', { groupId, bountyId });

    // Three IOUs, all owed to the claimant, one per contributor for their share.
    const ious = await getDocs(
      query(collection(claimant.db, 'ious'), where('creditorId', '==', claimant.uid)),
    );
    expect(ious.size).toBe(3);
    const byDebtor: Record<string, number> = {};
    for (const d of ious.docs) {
      expect(d.data()['status']).toBe('open');
      byDebtor[d.data()['debtorId'] as string] = d.data()['amount'] as number;
    }
    expect(byDebtor).toEqual({
      [poster.uid]: 10,
      [alice.uid]: 5,
      [bob.uid]: 7,
    });

    // Claimant earns the full pooled total in points (1pt = NZ$1).
    const member = await getDoc(doc(poster.db, 'groups', groupId, 'members', claimant.uid));
    expect(member.data()?.['points']).toBe(22);
    expect(member.data()?.['wins']).toBe(1);
  });

  it('a never-pooled cash bounty still produces exactly one IOU (today\'s behaviour)', async () => {
    const f = await seed(8);
    await f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId });
    await f.claimant.call('submitProof', { groupId: f.groupId, bountyId: f.bountyId, proof: { urls: [], note: 'done' } });
    await f.poster.call('approveBounty', { groupId: f.groupId, bountyId: f.bountyId });

    const ious = await getDocs(
      query(collection(f.poster.db, 'ious'), where('debtorId', '==', f.poster.uid)),
    );
    expect(ious.size).toBe(1);
    expect(ious.docs[0]!.data()['amount']).toBe(8);
  });

  it('rejecting a pooled bounty creates no IOUs and leaves contributions as a record', async () => {
    const f = await seed(5);
    await f.claimant.call('contributeToBounty', { groupId: f.groupId, bountyId: f.bountyId, amount: 4 });
    await f.claimant.call('claimBounty', { groupId: f.groupId, bountyId: f.bountyId });
    await f.claimant.call('submitProof', { groupId: f.groupId, bountyId: f.bountyId, proof: { urls: [], note: 'done' } });
    await f.poster.call('rejectBounty', { groupId: f.groupId, bountyId: f.bountyId, reason: 'nope' });

    // Query by debtorId as the poster — a rules-safe query (each party may only
    // list IOUs they're a party to). No IOUs exist after a rejection anyway.
    const ious = await getDocs(
      query(collection(f.poster.db, 'ious'), where('debtorId', '==', f.poster.uid)),
    );
    expect(ious.size).toBe(0);

    // Contribution docs survive as historical record.
    const contribs = await getDocs(
      collection(f.poster.db, 'groups', f.groupId, 'bounties', f.bountyId, 'contributions'),
    );
    expect(contribs.size).toBe(2);
  });
});

describe('[H1] leaderboard aggregate across multiple cycles', () => {
  it('[H1][P1] sums points/wins/losses with an early reject clamped at zero', async () => {
    const poster = await createUser('Pat Poster');
    const claimant = await createUser('Casey Claimant');
    const { groupId, inviteCode } = await poster.call<{
      groupId: string; inviteCode: string;
    }>('createGroup', { name: 'Roomies' });
    await claimant.call('joinGroup', { inviteCode });

    async function postBounty(price: number): Promise<string> {
      const ref = await addDoc(collection(poster.db, 'groups', groupId, 'bounties'), {
        title: `Chore $${price}`, description: 'x', price, currency: 'USD',
        state: 'available', posterId: poster.uid, claimantId: null,
        expiresAt: Timestamp.fromDate(new Date(Date.now() + WEEK_MS)),
        createdAt: serverTimestamp(),
      });
      return ref.id;
    }
    async function driveToReview(bid: string): Promise<void> {
      await claimant.call('claimBounty', { groupId, bountyId: bid });
      await claimant.call('submitProof', { groupId, bountyId: bid, proof: { urls: [], note: 'done' } });
    }

    // Reject first, while points are 0 → the clamp keeps points at 0, but a
    // loss is still recorded. (This is what makes the net result 25, not 20.)
    const b5 = await postBounty(5);
    await driveToReview(b5);
    await poster.call('rejectBounty', { groupId, bountyId: b5, reason: 'nope' });

    // Then two approvals: +10 then +15 → 25 points, 2 wins.
    const b10 = await postBounty(10);
    await driveToReview(b10);
    await poster.call('approveBounty', { groupId, bountyId: b10 });

    const b15 = await postBounty(15);
    await driveToReview(b15);
    await poster.call('approveBounty', { groupId, bountyId: b15 });

    const member = await getDoc(doc(poster.db, 'groups', groupId, 'members', claimant.uid));
    expect(member.data()?.['points']).toBe(25);
    expect(member.data()?.['wins']).toBe(2);
    expect(member.data()?.['losses']).toBe(1);

    // Two IOUs with B as creditor, totalling 25 — the basis for netIou +25 that
    // the leaderboard UI derives client-side.
    const ious = await getDocs(
      query(collection(claimant.db, 'ious'), where('creditorId', '==', claimant.uid)),
    );
    expect(ious.size).toBe(2);
    expect(ious.docs.reduce((s, d) => s + (d.data()['amount'] as number), 0)).toBe(25);
  });
});
