/**
 * [G] Emulator-backed checks for storage.rules on the proof-upload path
 * (groups/{gid}/bounties/{bid}/proof/{uid}/{file}).
 *
 * These exercise direct Storage SDK uploads (not the app) so the rules are what
 * is under test: only the current claimant may write, only under their own uid
 * path, and only image/* or video/* content types. Reads are limited to group
 * members.
 *
 * Note on the size cap: the rule enforces `request.resource.size < 25MB`, but
 * uploading a large object through the emulator in a unit test is impractical,
 * so that boundary is documented rather than exercised here. The rule also
 * restricts writes to bounties still in the `claimed` state, so a claimant
 * can't keep uploading after the bounty is resolved.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Timestamp, addDoc, collection, serverTimestamp } from 'firebase/firestore';
import {
  FirebaseStorage,
  connectStorageEmulator,
  getStorage,
  ref,
  uploadBytes,
} from 'firebase/storage';
import { TestUser, createUser, expectReject, resetEmulators } from './emulator';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BUCKET = 'gs://bounty-c5ee6.firebasestorage.app';
const connected = new WeakSet<object>();

function storageFor(user: TestUser): FirebaseStorage {
  const s = getStorage(user.app, BUCKET);
  if (!connected.has(s)) {
    connectStorageEmulator(s, '127.0.0.1', 9199);
    connected.add(s);
  }
  return s;
}

const TINY_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Fixture {
  poster: TestUser;
  claimant: TestUser;
  stranger: TestUser;
  groupId: string;
  bountyId: string;
}

/** poster + claimant in a group, with a bounty already claimed by claimant. */
async function seedClaimed(): Promise<Fixture> {
  const poster = await createUser('Pat Poster');
  const claimant = await createUser('Casey Claimant');
  const stranger = await createUser('Sam Stranger');

  const { groupId, inviteCode } = await poster.call<{
    groupId: string; inviteCode: string;
  }>('createGroup', { name: 'Roomies' });
  await claimant.call('joinGroup', { inviteCode });

  const bountyRef = await addDoc(
    collection(poster.db, 'groups', groupId, 'bounties'),
    {
      title: 'Proof me', description: 'x', price: 5, currency: 'USD',
      state: 'available', posterId: poster.uid, claimantId: null,
      expiresAt: Timestamp.fromDate(new Date(Date.now() + WEEK_MS)),
      createdAt: serverTimestamp(),
    },
  );
  await claimant.call('claimBounty', { groupId, bountyId: bountyRef.id });

  return { poster, claimant, stranger, groupId, bountyId: bountyRef.id };
}

function proofRef(user: TestUser, f: Fixture, uid: string, name: string) {
  return ref(storageFor(user), `groups/${f.groupId}/bounties/${f.bountyId}/proof/${uid}/${name}`);
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

describe('storage.rules — proof upload', () => {
  it('[G][P1] lets the current claimant upload an image under their own uid path', async () => {
    const f = await seedClaimed();
    const res = await uploadBytes(
      proofRef(f.claimant, f, f.claimant.uid, 'shot.png'),
      TINY_PNG,
      { contentType: 'image/png' },
    );
    expect(res.metadata.fullPath).toContain(`proof/${f.claimant.uid}/`);
  });

  it('[G4][P1] accepts a video content type', async () => {
    const f = await seedClaimed();
    const res = await uploadBytes(
      proofRef(f.claimant, f, f.claimant.uid, 'clip.mp4'),
      TINY_PNG, // bytes are irrelevant to the rule; only contentType is checked
      { contentType: 'video/mp4' },
    );
    expect(res.metadata.contentType).toBe('video/mp4');
  });

  it('[G5][P1] rejects a non-image/video content type (e.g. pdf)', async () => {
    const f = await seedClaimed();
    await expectReject(
      uploadBytes(
        proofRef(f.claimant, f, f.claimant.uid, 'doc.pdf'),
        TINY_PNG,
        { contentType: 'application/pdf' },
      ),
      'unauthorized',
    );
  });

  it('[G][P1] rejects a non-claimant (the poster) uploading proof', async () => {
    const f = await seedClaimed();
    await expectReject(
      uploadBytes(
        proofRef(f.poster, f, f.poster.uid, 'shot.png'),
        TINY_PNG,
        { contentType: 'image/png' },
      ),
      'unauthorized',
    );
  });

  it('[G][P1] rejects uploading under another user\'s uid path', async () => {
    const f = await seedClaimed();
    await expectReject(
      uploadBytes(
        proofRef(f.claimant, f, f.poster.uid, 'shot.png'),
        TINY_PNG,
        { contentType: 'image/png' },
      ),
      'unauthorized',
    );
  });

  it('[G][P1] rejects a non-member uploading proof', async () => {
    const f = await seedClaimed();
    await expectReject(
      uploadBytes(
        proofRef(f.stranger, f, f.stranger.uid, 'shot.png'),
        TINY_PNG,
        { contentType: 'image/png' },
      ),
      'unauthorized',
    );
  });
});
