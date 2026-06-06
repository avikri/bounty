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
  serverTimestamp,
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
    // serverTimestamp() resolves to request.time, which the create rule
    // requires (mirrors DataService.postBounty).
    createdAt: serverTimestamp(),
  };
}

/** A cash bounty in the new explicit shape (rewardType + points pinned to price). */
function cashBounty(posterId: string, overrides: Record<string, unknown> = {}) {
  return {
    title: 'Dishes',
    description: 'tonight',
    rewardType: 'cash' as const,
    price: 3,
    points: 3,
    currency: 'NZD',
    state: 'available' as const,
    posterId,
    claimantId: null,
    expiresAt: Timestamp.fromDate(new Date(Date.now() + WEEK_MS)),
    createdAt: serverTimestamp(),
    ...overrides,
  };
}

/** A custom (freeform-reward) bounty: rewardText + bounded points, no price. */
function customBounty(posterId: string, overrides: Record<string, unknown> = {}) {
  return {
    title: 'Beers',
    description: 'winner picks the bar',
    rewardType: 'custom' as const,
    rewardText: '3 beers',
    points: 40,
    currency: 'NZD',
    state: 'available' as const,
    posterId,
    claimantId: null,
    expiresAt: Timestamp.fromDate(new Date(Date.now() + WEEK_MS)),
    createdAt: serverTimestamp(),
    ...overrides,
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
  it('lets a user read and write only their own profile', async () => {
    const a = await createUser('A');
    const b = await createUser('B');

    // Read own profile — allowed.
    const own = await getDoc(doc(a.db, 'users', a.uid));
    expect(own.exists()).toBe(true);

    // Read someone else's profile — denied (no user-base enumeration).
    await expectReject(getDoc(doc(a.db, 'users', b.uid)));

    // Update own profile field — allowed (in the editable whitelist).
    await updateDoc(doc(a.db, 'users', a.uid), { displayName: 'A renamed' });

    // Forge own totalPoints — denied (CF-maintained aggregate).
    await expectReject(
      updateDoc(doc(a.db, 'users', a.uid), { totalPoints: 9999 }),
    );

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

  it('[D2][P1] blocks a non-member from reading the bounties collection', async () => {
    const { owner, stranger, groupId } = await seedGroup();
    await addDoc(
      collection(owner.db, 'groups', groupId, 'bounties'),
      availableBounty(owner.uid),
    );
    await expectReject(getDocs(collection(stranger.db, 'groups', groupId, 'bounties')));
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

  it('[D3][P1] forbids a plain member from changing another member\'s role', async () => {
    const { owner, member, groupId } = await seedGroup();
    // Seed a second member for `member` to attempt to promote.
    const other = await createUser('Other Member');
    const grp = await getDoc(doc(owner.db, 'groups', groupId));
    await other.call('joinGroup', { inviteCode: grp.data()?.['inviteCode'] });

    await expectReject(
      updateDoc(doc(member.db, 'groups', groupId, 'members', other.uid), {
        role: 'admin',
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

  it('[P1] allows a valid cash bounty in the explicit rewardType/points shape', async () => {
    const { member, groupId } = await seedGroup();
    const ref = await addDoc(
      collection(member.db, 'groups', groupId, 'bounties'),
      cashBounty(member.uid, { price: 25, points: 25 }),
    );
    expect(ref.id).toBeTruthy();
  });

  it('[P1] allows a valid custom bounty (rewardText + bounded points, no price)', async () => {
    const { member, groupId } = await seedGroup();
    const ref = await addDoc(
      collection(member.db, 'groups', groupId, 'bounties'),
      customBounty(member.uid),
    );
    expect(ref.id).toBeTruthy();
  });

  it('[P1] rejects a custom bounty that also carries a price', async () => {
    const { member, groupId } = await seedGroup();
    await expectReject(
      addDoc(collection(member.db, 'groups', groupId, 'bounties'),
        customBounty(member.uid, { price: 5 })),
    );
  });

  it('[P1] rejects a cash bounty with no price', async () => {
    const { member, groupId } = await seedGroup();
    // rewardType cash but the price field omitted entirely.
    const { price, ...noPrice } = cashBounty(member.uid);
    void price;
    await expectReject(
      addDoc(collection(member.db, 'groups', groupId, 'bounties'), noPrice),
    );
  });

  it('[P1] rejects a custom bounty with oversized rewardText (>10 chars)', async () => {
    const { member, groupId } = await seedGroup();
    await expectReject(
      addDoc(collection(member.db, 'groups', groupId, 'bounties'),
        customBounty(member.uid, { rewardText: 'x'.repeat(11) })),
    );
  });

  it('[P1] rejects forged points (custom points above the 1000 cap)', async () => {
    const { member, groupId } = await seedGroup();
    await expectReject(
      addDoc(collection(member.db, 'groups', groupId, 'bounties'),
        customBounty(member.uid, { points: 5000 })),
    );
  });

  it('[P1] rejects cash points that do not equal the dollar price', async () => {
    const { member, groupId } = await seedGroup();
    await expectReject(
      addDoc(collection(member.db, 'groups', groupId, 'bounties'),
        cashBounty(member.uid, { price: 10, points: 9999 })),
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

  it('forbids writing to the contributions subcollection directly', async () => {
    const { member, groupId } = await seedGroup();
    const ref = await addDoc(
      collection(member.db, 'groups', groupId, 'bounties'),
      availableBounty(member.uid),
    );
    // The running total is raised only by the contributeToBounty callable.
    await expectReject(
      setDoc(
        doc(member.db, 'groups', groupId, 'bounties', ref.id, 'contributions', member.uid),
        { uid: member.uid, amount: 999 },
      ),
    );
    // …but a group member may read the (server-written) contributor list.
    const list = await getDocs(
      collection(member.db, 'groups', groupId, 'bounties', ref.id, 'contributions'),
    );
    expect(list.empty).toBe(true);
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

describe('groups/{gid}/bounties/{bid}/comments/{commentId}', () => {
  interface CommentFixture {
    owner: TestUser;
    poster: TestUser;
    commenter: TestUser;
    other: TestUser;
    stranger: TestUser;
    groupId: string;
    bountyId: string;
  }

  /** owner + 3 joined members (poster, commenter, other) + a stranger, with a
   *  bounty posted by `poster`. Lets us separate the author / poster / owner
   *  delete branches and exercise the member/non-member split. */
  async function seedComments(): Promise<CommentFixture> {
    const owner = await createUser('Olive Owner');
    const poster = await createUser('Pat Poster');
    const commenter = await createUser('Cory Commenter');
    const other = await createUser('Ola Other');
    const stranger = await createUser('Sam Stranger');

    const { groupId, inviteCode } = await owner.call<{ groupId: string; inviteCode: string }>(
      'createGroup', { name: 'Roomies' },
    );
    await poster.call('joinGroup', { inviteCode });
    await commenter.call('joinGroup', { inviteCode });
    await other.call('joinGroup', { inviteCode });

    const bountyRef = await addDoc(
      collection(poster.db, 'groups', groupId, 'bounties'),
      availableBounty(poster.uid),
    );
    return { owner, poster, commenter, other, stranger, groupId, bountyId: bountyRef.id };
  }

  function commentsCol(u: TestUser, f: CommentFixture) {
    return collection(u.db, 'groups', f.groupId, 'bounties', f.bountyId, 'comments');
  }
  function commentRef(u: TestUser, f: CommentFixture, id: string) {
    return doc(u.db, 'groups', f.groupId, 'bounties', f.bountyId, 'comments', id);
  }
  function comment(authorUid: string, overrides: Record<string, unknown> = {}) {
    return {
      authorUid,
      authorDisplayName: 'Cory Commenter',
      text: 'first!',
      createdAt: serverTimestamp(),
      ...overrides,
    };
  }

  it('lets a group member post a comment and read the thread', async () => {
    const f = await seedComments();
    const ref = await addDoc(commentsCol(f.commenter, f), comment(f.commenter.uid));
    expect(ref.id).toBeTruthy();
    const snap = await getDocs(commentsCol(f.commenter, f));
    expect(snap.size).toBe(1);
  });

  it('forbids a non-member from reading or posting comments', async () => {
    const f = await seedComments();
    await addDoc(commentsCol(f.commenter, f), comment(f.commenter.uid));
    await expectReject(getDocs(commentsCol(f.stranger, f)));
    await expectReject(addDoc(commentsCol(f.stranger, f), comment(f.stranger.uid)));
  });

  it('forbids forging authorUid as another user', async () => {
    const f = await seedComments();
    await expectReject(
      addDoc(commentsCol(f.commenter, f), comment(f.poster.uid)),
    );
  });

  it('rejects empty and over-length (>500) comment text', async () => {
    const f = await seedComments();
    await expectReject(addDoc(commentsCol(f.commenter, f), comment(f.commenter.uid, { text: '' })));
    await expectReject(
      addDoc(commentsCol(f.commenter, f), comment(f.commenter.uid, { text: 'x'.repeat(501) })),
    );
  });

  it('rejects a comment carrying a field outside the allowlist', async () => {
    const f = await seedComments();
    // editedAt may only appear on an update, never on create.
    await expectReject(
      addDoc(commentsCol(f.commenter, f), comment(f.commenter.uid, { editedAt: serverTimestamp() })),
    );
  });

  it('lets the author edit only their own comment text', async () => {
    const f = await seedComments();
    const ref = await addDoc(commentsCol(f.commenter, f), comment(f.commenter.uid));

    // Author edits text (+ editedAt stamp) — allowed.
    await updateDoc(commentRef(f.commenter, f, ref.id), {
      text: 'edited', editedAt: serverTimestamp(),
    });

    // Author tries to rewrite authorUid — denied (outside the {text,editedAt} set).
    await expectReject(
      updateDoc(commentRef(f.commenter, f, ref.id), {
        authorUid: f.other.uid, editedAt: serverTimestamp(),
      }),
    );

    // Another member tries to edit it — denied (not the author).
    await expectReject(
      updateDoc(commentRef(f.other, f, ref.id), {
        text: 'hax', editedAt: serverTimestamp(),
      }),
    );
  });

  it("forbids a plain member from deleting someone else's comment", async () => {
    const f = await seedComments();
    const ref = await addDoc(commentsCol(f.commenter, f), comment(f.commenter.uid));
    // `other` is a member but neither the author, the poster, nor the owner.
    await expectReject(deleteDoc(commentRef(f.other, f, ref.id)));
  });

  it('lets the author, the bounty poster, and the group owner delete a comment', async () => {
    const f = await seedComments();

    // Author deletes their own.
    const a = await addDoc(commentsCol(f.commenter, f), comment(f.commenter.uid));
    await deleteDoc(commentRef(f.commenter, f, a.id));

    // Bounty poster (not the owner) moderates a member's comment.
    const b = await addDoc(commentsCol(f.commenter, f), comment(f.commenter.uid));
    await deleteDoc(commentRef(f.poster, f, b.id));

    // Group owner (not the poster) moderates a member's comment.
    const c = await addDoc(commentsCol(f.commenter, f), comment(f.commenter.uid));
    await deleteDoc(commentRef(f.owner, f, c.id));
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
