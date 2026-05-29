/**
 * SDK-driven flow helpers for arranging bounty state in E2E setups, using live
 * `loginSeedUser` actors (real Cloud Functions). Used to put the world into the
 * state a spec wants to *observe* in the browser, without re-driving the whole
 * UI loop each time (that loop is covered end-to-end by a-happy-path.spec).
 */
import { SeedUser, postBounty } from '../fixtures/seed';

interface BountyOpts { title?: string; price?: number; urls?: string[]; note?: string; expiresInMs?: number; }

/** Post (poster) then claim (claimant). Returns the bounty id. */
export async function postAndClaim(
  poster: SeedUser, claimant: SeedUser, gid: string, opts: BountyOpts = {},
): Promise<string> {
  const bid = await postBounty(poster, gid, opts);
  await claimant.call('claimBounty', { groupId: gid, bountyId: bid });
  return bid;
}

/** Post → claim → submit proof. Returns the bounty id (now pending_review). */
export async function toPendingReview(
  poster: SeedUser, claimant: SeedUser, gid: string, opts: BountyOpts = {},
): Promise<string> {
  const bid = await postAndClaim(poster, claimant, gid, opts);
  await claimant.call('submitProof', {
    groupId: gid, bountyId: bid, proof: { urls: opts.urls ?? [], note: opts.note ?? 'done' },
  });
  return bid;
}

export async function approve(poster: SeedUser, gid: string, bid: string): Promise<void> {
  await poster.call('approveBounty', { groupId: gid, bountyId: bid });
}

export async function reject(poster: SeedUser, gid: string, bid: string, reason?: string): Promise<void> {
  await poster.call('rejectBounty', { groupId: gid, bountyId: bid, reason });
}
