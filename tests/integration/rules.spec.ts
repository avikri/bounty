/**
 * Emulator-backed checks that firestore.rules allow the writes clients are
 * meant to make and deny everything that must flow through Cloud Functions.
 *
 * These exercise direct client reads/writes (NOT callables) so the rules
 * themselves are what's under test.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  TestUser,
  createUser,
  expectReject,
  resetEmulators,
} from './emulator';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface GroupFixture {
  owner: TestUser;
  member: TestUser;
  stranger: TestUser;
  groupId: string;
}

/** owner + a joined member + an unrelated stranger. */
async function seedGroup(): Promise<GroupFixture> {
  const owner = await createUser('Olive Owner');
  const member = await createUser('Mel Member');
  const stranger = await createUser('Sam Stranger');

  const { groupId, inviteCode } = await owner.call<{
    groupId: string;
    inviteCode: string;
  }>('createGroup', { name: 'Roomies' });
  await member.call('joinGroup', { inviteCode });

  return { owner, member, stranger, groupId };
}

function availableBounty(posterId: string) {
  return {
    title: 'Dishes',
    description: 'tonight',
    price: 3,
    currency: 'USD',
    state: 'available' as const,
    posterId,
    claimantId: null,
    expiresAt: Timestamp.fromDate(new Date(Date.now() + WEEK_MS)),
    createdAt: Timestamp.now(),
  };
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

describe('users/{userId}', () => {
  it('allows a signed-in user to read any profile but only write their own', async () => {
    const a = await createUser('A');
    const b = await createUser('B');

    // Read someone else's profile — allowed for any signed-in user.
    const other = await getDoc(doc(a.db, 'users', b.uid));
    expect(other.exists()).toBe(true);

    // Update own profile — allowed.
    await updateDoc(doc(a.db, 'users', a.uid), { displayName: 'A renamed' });

    // Update someone else's — denied.
    await expectReject(
      updateDoc(doc(a.db, 'users', b.uid), { displayName: 'hacked' }),
    );

    // Delete — always denied.
    await expectReject(deleteDoc(doc(a.db, 'users', a.uid)));
  });
});

describe('groups/{gid}', () => {
  it('lets members read and blocks non-members', async () => {
    const { member, stranger, groupId } = await seedGroup();
    const asMember = await getDoc(doc(member.db, 'groups', groupId));
    expect(asMember.exists()).toBe(true);
    await expectReject(getDoc(doc(stranger.db, 'groups', groupId)));
  });

  it('rejects creating a group owned by someone else', async () => {
    const a = await createUser('A');
    const b = await createUser('B');
    await expectReject(
      addDoc(collection(a.db, 'groups'), { name: 'x', ownerId: b.uid }),
    );
  });
});

describe('groups/{gid}/members/{userId}', () => {
  it('forbids clients from creating membership directly', async () => {
    const { stranger, groupId } = await seedGroup();
    await expectReject(
      setDoc(doc(stranger.db, 'groups', groupId, 'members', stranger.uid), {
        role: 'member',
        points: 0,
        wins: 0,
        losses: 0,
        displayName: 'Sneaky',
      }),
    );
  });

  it('lets the owner change a role but nothing else', async () => {
    const { owner, member, groupId } = await seedGroup();

    // Owner promotes member — allowed (only `role` changes).
    await updateDoc(doc(owner.db, 'groups', groupId, 'members', member.uid), {
      role: 'admin',
    });

    // Owner tries to forge points — denied (affects a non-`role` key).
    await expectReject(
      updateDoc(doc(owner.db, 'groups', groupId, 'members', member.uid), {
        points: 9999,
      }),
    );

    // Member cannot promote themselves.
    await expectReject(
      updateDoc(doc(member.db, 'groups', groupId, 'members', member.uid), {
        role: 'owner',
      }),
    );
  });

  it('lets a member leave and the owner remove members', async () => {
    const { owner, member, groupId } = await seedGroup();
    // Member leaves.
    await deleteDoc(doc(member.db, 'groups', groupId, 'members', member.uid));
    // Owner can delete (re-seed a second member to remove).
    const m2 = await createUser('Second');
    const grp = await getDoc(doc(owner.db, 'groups', groupId));
    await m2.call('joinGroup', { inviteCode: grp.data()?.['inviteCode'] });
    await deleteDoc(doc(owner.db, 'groups', groupId, 'members', m2.uid));
  });
});

describe('groups/{gid}/bounties/{bid}', () => {
  it('allows a member to post an available bounty as themselves', async () => {
    const { member, groupId } = await seedGroup();
    const ref = await addDoc(
      collection(member.db, 'groups', groupId, 'bounties'),
      availableBounty(member.uid),
    );
    expect(ref.id).toBeTruthy();
  });

  it('rejects posting as a different poster or in a non-available state', async () => {
    const { owner, member, groupId } = await seedGroup();
    await expectReject(
      addDoc(collection(member.db, 'groups', groupId, 'bounties'), availableBounty(owner.uid)),
    );
    await expectReject(
      addDoc(collection(member.db, 'groups', groupId, 'bounties'), {
        ...availableBounty(member.uid),
        state: 'claimed',
      }),
    );
  });

  it('rejects a non-member posting at all', async () => {
    const { stranger, groupId } = await seedGroup();
    await expectReject(
      addDoc(collection(stranger.db, 'groups', groupId, 'bounties'), availableBounty(stranger.uid)),
    );
  });

  it('forbids any direct client update (transitions are CF-only)', async () => {
    const { member, groupId } = await seedGroup();
    const ref = await addDoc(
      collection(member.db, 'groups', groupId, 'bounties'),
      availableBounty(member.uid),
    );
    await expectReject(updateDoc(ref, { state: 'successful' }));
  });

  it('lets the poster delete their own available bounty but not a claimed one', async () => {
    const { member, groupId } = await seedGroup();
    const ref = await addDoc(
      collection(member.db, 'groups', groupId, 'bounties'),
      availableBounty(member.uid),
    );
    // Available + own → allowed.
    await deleteDoc(ref);

    // A claimed bounty can't be deleted by the client. Seed one via callables.
    const poster = member;
    const claimant = await createUser('Claimy');
    const grp = await getDoc(doc(poster.db, 'groups', groupId));
    await claimant.call('joinGroup', { inviteCode: grp.data()?.['inviteCode'] });
    const ref2 = await addDoc(
      collection(poster.db, 'groups', groupId, 'bounties'),
      availableBounty(poster.uid),
    );
    await claimant.call('claimBounty', { groupId, bountyId: ref2.id });
    await expectReject(deleteDoc(ref2));
  });

  it('forbids writing to the activity timeline directly', async () => {
    const { member, groupId } = await seedGroup();
    const ref = await addDoc(
      collection(member.db, 'groups', groupId, 'bounties'),
      availableBounty(member.uid),
    );
    await expectReject(
      addDoc(collection(member.db, 'groups', groupId, 'bounties', ref.id, 'activity'), {
        kind: 'claimed',
        actorId: member.uid,
        at: Timestamp.now(),
      }),
    );
  });
});

describe('groups/{gid}/leaderboard', () => {
  it('is member-readable but client-write-forbidden', async () => {
    const { member, stranger, groupId } = await seedGroup();
    const lb = await getDoc(doc(member.db, 'groups', groupId, 'leaderboard', 'summary'));
    expect(lb.exists()).toBe(true);
    await expectReject(
      setDoc(doc(member.db, 'groups', groupId, 'leaderboard', 'summary'), { entries: [] }),
    );
    await expectReject(getDoc(doc(stranger.db, 'groups', groupId, 'leaderboard', 'summary')));
  });
});

describe('ious/{iouId}', () => {
  it('forbids any direct client write', async () => {
    const a = await createUser('A');
    const b = await createUser('B');
    await expectReject(
      addDoc(collection(a.db, 'ious'), {
        debtorId: a.uid,
        creditorId: b.uid,
        amount: 5,
        status: 'open',
      }),
    );
  });
});

describe('notifications/{userId}/inbox', () => {
  it('forbids client creation but allows self read + marking read', async () => {
    const f = await seedGroup();
    const claimant = await createUser('Claimy');
    const grp = await getDoc(doc(f.owner.db, 'groups', f.groupId));
    await claimant.call('joinGroup', { inviteCode: grp.data()?.['inviteCode'] });
    const ref = await addDoc(
      collection(f.owner.db, 'groups', f.groupId, 'bounties'),
      availableBounty(f.owner.uid),
    );
    // Generate a real notification (poster gets "bounty_claimed").
    await claimant.call('claimBounty', { groupId: f.groupId, bountyId: ref.id });

    // Owner can read their own inbox and mark a notification read.
    const inbox = await getDocs(
      collection(f.owner.db, 'notifications', f.owner.uid, 'inbox'),
    );
    expect(inbox.size).toBeGreaterThan(0);
    await updateDoc(
      doc(f.owner.db, 'notifications', f.owner.uid, 'inbox', inbox.docs[0]!.id),
      { read: true },
    );

    // Nobody can create inbox docs directly.
    await expectReject(
      addDoc(collection(f.owner.db, 'notifications', f.owner.uid, 'inbox'), {
        kind: 'bounty_claimed',
        title: 'x',
        body: 'y',
        read: false,
        createdAt: Timestamp.now(),
      }),
    );

    // A different user cannot read someone else's inbox.
    await expectReject(
      getDocs(collection(claimant.db, 'notifications', f.owner.uid, 'inbox')),
    );
  });
});
