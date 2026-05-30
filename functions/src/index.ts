/**
 * Cloud Functions for the Bounty app.
 *
 * State-transition writes (claim / submit / approve / reject) live here so
 * clients can never mutate `bounties.{state,claimantId,proof,resolvedAt}`
 * directly. Each callable runs its core mutation inside a single Firestore
 * transaction so the state machine, points, IOUs, leaderboard summary, and
 * activity timeline stay consistent.
 *
 * Inbox notifications and best-effort denormalized counters are written
 * after the transaction commits — they are not load-bearing for the state
 * machine, so a transient failure shouldn't roll back the resolution.
 */

import {setGlobalOptions} from "firebase-functions";
import {HttpsError, onCall, CallableRequest} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
// Pull Timestamp/FieldValue from the modular entry point rather than off
// `admin.firestore.*`. The Functions emulator wraps `admin.firestore()` to
// auto-connect to the local emulator, and that wrapper drops the static
// members (Timestamp, FieldValue) — so `admin.firestore.Timestamp` is
// undefined under the emulator. The modular named exports work in both the
// emulator and production.
import {FieldValue, Timestamp} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {randomInt} from "node:crypto";
import {runBountyExpiry} from "./expiry";

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({maxInstances: 10, region: "australia-southeast1"});

// App Check enforcement on the callables. OFF by default so the app works
// without a reCAPTCHA/App Check provider configured. To turn it on later:
//   1. Configure client App Check (initializeAppCheck with a real site key).
//   2. Set ENFORCE_APP_CHECK=true (e.g. in functions/.env) and redeploy.
// Never enforced under the emulator — App Check can't be attested locally
// (the emulator sets FUNCTIONS_EMULATOR=true), which would break the suites.
const ENFORCE_APP_CHECK =
  process.env.FUNCTIONS_EMULATOR !== "true" &&
  process.env.ENFORCE_APP_CHECK === "true";
const CALLABLE_OPTS = {enforceAppCheck: ENFORCE_APP_CHECK};

const MAX_LEADERBOARD_ENTRIES = 100;
const MAX_PROOF_NOTE_CHARS = 500;
const MAX_REJECTION_REASON_CHARS = 500;

/* ── shared types ─────────────────────────────────────────────────── */

type BountyState =
  | "available" | "claimed" | "pending_review"
  | "successful" | "failed" | "expired";

interface BountyData {
  title: string;
  description: string;
  price: number;
  state: BountyState;
  posterId: string;
  claimantId?: string | null;
  proof?: { urls: string[]; note: string };
  expiresAt: Timestamp;
  createdAt: Timestamp;
  resolvedAt?: Timestamp;
  rejectionReason?: string;
}

interface MemberData {
  role: "owner" | "admin" | "member";
  points: number;
  wins: number;
  losses: number;
  displayName: string;
  photoURL?: string | null;
}

interface LeaderboardEntry {
  userId: string;
  name: string;
  photoURL: string | null;
  points: number;
  wins: number;
  losses: number;
}

/* ── helpers ──────────────────────────────────────────────────────── */

function requireAuth(req: CallableRequest<unknown>): string {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
  return uid;
}

async function requireMembership(groupId: string, uid: string): Promise<void> {
  const memberSnap = await db.doc(`groups/${groupId}/members/${uid}`).get();
  if (!memberSnap.exists) {
    throw new HttpsError("permission-denied", "Not a member of this group.");
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpsError("invalid-argument", `${name} required.`);
  }
  return value;
}

/* ── rate limiting ────────────────────────────────────────────────── */

interface RateRule { max: number; windowSec: number; }

// Per-user fixed-window caps — generous for real use, tight enough to stop
// tight-loop abuse / cost amplification (esp. unbounded group creation and
// invite-code brute-forcing). Counters live in rateLimits/{uid}, which is
// Cloud-Function-only (denied to clients by firestore.rules).
const RATE_RULES: Record<string, RateRule> = {
  createGroup: {max: 10, windowSec: 3600},
  joinGroup: {max: 20, windowSec: 3600},
  regenerateInviteCode: {max: 20, windowSec: 3600},
  claimBounty: {max: 60, windowSec: 3600},
  submitProof: {max: 60, windowSec: 3600},
  approveBounty: {max: 120, windowSec: 3600},
  rejectBounty: {max: 120, windowSec: 3600},
  markIouPaid: {max: 120, windowSec: 3600},
};

/**
 * Fixed-window per-user rate limit. Throws `resource-exhausted` once a user
 * exceeds the configured number of calls for `action` within its window.
 */
async function enforceRateLimit(uid: string, action: string): Promise<void> {
  const rule = RATE_RULES[action];
  if (!rule) return;
  const ref = db.doc(`rateLimits/${uid}`);
  const nowMs = Date.now();
  const windowMs = rule.windowSec * 1000;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const all = (snap.exists ? snap.data() : {}) as
      Record<string, { count: number; windowStart: number } | undefined>;
    const bucket = all[action];

    if (!bucket || nowMs - bucket.windowStart >= windowMs) {
      tx.set(ref, {[action]: {count: 1, windowStart: nowMs}}, {merge: true});
      return;
    }
    if (bucket.count >= rule.max) {
      throw new HttpsError(
          "resource-exhausted",
          "Too many requests — please slow down and try again later.",
      );
    }
    tx.set(
        ref,
        {[action]: {count: bucket.count + 1, windowStart: bucket.windowStart}},
        {merge: true},
    );
  });
}

/** Insert or replace an entry, then sort by points desc and cap. */
function upsertLeaderboardEntry(
    current: LeaderboardEntry[],
    entry: LeaderboardEntry,
): LeaderboardEntry[] {
  const next = current.filter((e) => e.userId !== entry.userId);
  next.push(entry);
  next.sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
  return next.slice(0, MAX_LEADERBOARD_ENTRIES);
}

async function writeInbox(
    userId: string,
    payload: Record<string, unknown>,
): Promise<void> {
  try {
    await db.collection(`notifications/${userId}/inbox`).add({
      ...payload,
      createdAt: Timestamp.now(),
      read: false,
    });
  } catch (e) {
    logger.warn("inbox write failed", {userId, error: String(e)});
  }
}

/** Best-effort lookup of a member's cached display name within a group. */
async function memberName(groupId: string, uid: string): Promise<string> {
  try {
    const snap = await db.doc(`groups/${groupId}/members/${uid}`).get();
    return (snap.data()?.displayName as string | undefined) || "Someone";
  } catch {
    return "Someone";
  }
}

/** Best-effort lookup of a top-level user's display name. */
async function userName(uid: string): Promise<string> {
  try {
    const snap = await db.doc(`users/${uid}`).get();
    return (snap.data()?.displayName as string | undefined) || "Someone";
  } catch {
    return "Someone";
  }
}

/* ── claimBounty ──────────────────────────────────────────────────── */

export const claimBounty = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireAuth(req);
  await enforceRateLimit(uid, "claimBounty");
  const data = (req.data ?? {}) as { groupId?: string; bountyId?: string };
  const groupId = requireString(data.groupId, "groupId");
  const bountyId = requireString(data.bountyId, "bountyId");
  await requireMembership(groupId, uid);

  const bountyRef = db.doc(`groups/${groupId}/bounties/${bountyId}`);
  const activityRef = db
      .collection(`groups/${groupId}/bounties/${bountyId}/activity`)
      .doc();
  const now = Timestamp.now();

  const result = await db.runTransaction(async (tx) => {
    const bountySnap = await tx.get(bountyRef);
    if (!bountySnap.exists) {
      throw new HttpsError("not-found", "Bounty not found.");
    }
    const bounty = bountySnap.data() as BountyData;

    if (bounty.state !== "available") {
      throw new HttpsError(
          "failed-precondition",
          `Cannot claim a bounty in state '${bounty.state}'.`,
      );
    }
    if (bounty.posterId === uid) {
      throw new HttpsError(
          "failed-precondition",
          "You can't claim your own bounty.",
      );
    }
    if (bounty.expiresAt && bounty.expiresAt.toMillis() <= Date.now()) {
      throw new HttpsError("failed-precondition", "Bounty has expired.");
    }

    tx.update(bountyRef, {state: "claimed", claimantId: uid});
    tx.set(activityRef, {kind: "claimed", actorId: uid, at: now});

    return {posterId: bounty.posterId, bountyTitle: bounty.title};
  });

  const actorName = await memberName(groupId, uid);
  await writeInbox(result.posterId, {
    kind: "bounty_claimed",
    groupId,
    bountyId,
    actorId: uid,
    actorName,
    title: "Bounty claimed",
    body: `${actorName} claimed "${result.bountyTitle}".`,
  });

  return {ok: true};
});

/* ── submitProof ──────────────────────────────────────────────────── */

export const submitProof = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireAuth(req);
  await enforceRateLimit(uid, "submitProof");
  const data = (req.data ?? {}) as {
    groupId?: string;
    bountyId?: string;
    proof?: { urls?: unknown; note?: unknown };
  };
  const groupId = requireString(data.groupId, "groupId");
  const bountyId = requireString(data.bountyId, "bountyId");
  if (!data.proof) {
    throw new HttpsError("invalid-argument", "proof required.");
  }
  const urls = Array.isArray(data.proof.urls) ?
    (data.proof.urls as unknown[]).filter((u): u is string => typeof u === "string").slice(0, 3) :
    [];
  const noteRaw = typeof data.proof.note === "string" ? data.proof.note : "";
  const note = noteRaw.slice(0, MAX_PROOF_NOTE_CHARS);

  await requireMembership(groupId, uid);

  const bountyRef = db.doc(`groups/${groupId}/bounties/${bountyId}`);
  const activityRef = db
      .collection(`groups/${groupId}/bounties/${bountyId}/activity`)
      .doc();
  const now = Timestamp.now();

  const result = await db.runTransaction(async (tx) => {
    const bountySnap = await tx.get(bountyRef);
    if (!bountySnap.exists) {
      throw new HttpsError("not-found", "Bounty not found.");
    }
    const bounty = bountySnap.data() as BountyData;

    if (bounty.state !== "claimed") {
      throw new HttpsError(
          "failed-precondition",
          `Cannot submit proof for a bounty in state '${bounty.state}'.`,
      );
    }
    if (bounty.claimantId !== uid) {
      throw new HttpsError(
          "permission-denied",
          "Only the current claimant can submit proof.",
      );
    }

    tx.update(bountyRef, {
      state: "pending_review",
      proof: {urls, note},
    });
    tx.set(activityRef, {
      kind: "submitted",
      actorId: uid,
      at: now,
      note: note || null,
    });

    return {posterId: bounty.posterId, bountyTitle: bounty.title};
  });

  // The reviewer for a bounty is its original poster, so notifying the OP
  // covers "notify reviewers when a bounty enters pending_review".
  const actorName = await memberName(groupId, uid);
  await writeInbox(result.posterId, {
    kind: "proof_submitted",
    groupId,
    bountyId,
    actorId: uid,
    actorName,
    title: "Proof submitted",
    body: `${actorName} submitted proof on "${result.bountyTitle}" — your call.`,
  });

  return {ok: true};
});

/* ── approveBounty ────────────────────────────────────────────────── */

export const approveBounty = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireAuth(req);
  await enforceRateLimit(uid, "approveBounty");
  const data = (req.data ?? {}) as { groupId?: string; bountyId?: string };
  const groupId = requireString(data.groupId, "groupId");
  const bountyId = requireString(data.bountyId, "bountyId");
  await requireMembership(groupId, uid);

  const bountyRef = db.doc(`groups/${groupId}/bounties/${bountyId}`);
  const leaderboardRef = db.doc(`groups/${groupId}/leaderboard/summary`);
  const activityRef = db
      .collection(`groups/${groupId}/bounties/${bountyId}/activity`)
      .doc();
  const iouRef = db.collection("ious").doc();
  const now = Timestamp.now();

  const result = await db.runTransaction(async (tx) => {
    const bountySnap = await tx.get(bountyRef);
    if (!bountySnap.exists) {
      throw new HttpsError("not-found", "Bounty not found.");
    }
    const bounty = bountySnap.data() as BountyData;

    if (bounty.state !== "pending_review") {
      throw new HttpsError(
          "failed-precondition",
          `Cannot approve a bounty in state '${bounty.state}'.`,
      );
    }
    if (bounty.posterId !== uid) {
      throw new HttpsError(
          "permission-denied",
          "Only the original poster can approve this bounty.",
      );
    }
    const claimantId = bounty.claimantId;
    if (!claimantId) {
      throw new HttpsError("failed-precondition", "Bounty has no claimant.");
    }

    const memberRef = db.doc(`groups/${groupId}/members/${claimantId}`);
    const userRef = db.doc(`users/${claimantId}`);
    const memberSnap = await tx.get(memberRef);
    if (!memberSnap.exists) {
      throw new HttpsError("not-found", "Claimant is no longer a member.");
    }
    const member = memberSnap.data() as MemberData;
    const userSnap = await tx.get(userRef);
    const userTotal = (userSnap.data()?.totalPoints as number | undefined) ?? 0;

    const lbSnap = await tx.get(leaderboardRef);
    const currentEntries: LeaderboardEntry[] = lbSnap.exists ?
      ((lbSnap.data()?.entries as LeaderboardEntry[]) ?? []) :
      [];

    /* ── all reads done; now writes ── */

    const newPoints = (member.points ?? 0) + bounty.price;
    const newWins = (member.wins ?? 0) + 1;
    const newUserTotal = userTotal + bounty.price;

    tx.update(bountyRef, {state: "successful", resolvedAt: now});

    tx.update(memberRef, {points: newPoints, wins: newWins});
    tx.set(userRef, {totalPoints: newUserTotal}, {merge: true});

    tx.set(iouRef, {
      groupId,
      debtorId: bounty.posterId,
      creditorId: claimantId,
      amount: bounty.price,
      bountyId,
      status: "open",
      createdAt: now,
    });

    const updatedEntries = upsertLeaderboardEntry(currentEntries, {
      userId: claimantId,
      name: member.displayName ?? "",
      photoURL: member.photoURL ?? null,
      points: newPoints,
      wins: newWins,
      losses: member.losses ?? 0,
    });
    tx.set(leaderboardRef, {
      entries: updatedEntries,
      updatedAt: now,
    }, {merge: true});

    tx.set(activityRef, {kind: "approved", actorId: uid, at: now});

    return {
      claimantId,
      posterId: bounty.posterId,
      price: bounty.price,
      bountyTitle: bounty.title,
    };
  });

  const reviewerName = await memberName(groupId, uid);
  await Promise.all([
    writeInbox(result.claimantId, {
      kind: "bounty_approved",
      groupId,
      bountyId,
      actorId: uid,
      actorName: reviewerName,
      amount: result.price,
      title: "Claim approved",
      body: `Your claim on "${result.bountyTitle}" was approved. +${result.price} pts.`,
    }),
    writeInbox(result.posterId, {
      kind: "bounty_resolved",
      groupId,
      bountyId,
      actorId: uid,
      amount: result.price,
      title: "Bounty resolved",
      body: `You approved "${result.bountyTitle}". You now owe $${result.price}.`,
    }),
  ]);

  return {ok: true};
});

/* ── rejectBounty ─────────────────────────────────────────────────── */

export const rejectBounty = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireAuth(req);
  await enforceRateLimit(uid, "rejectBounty");
  const data = (req.data ?? {}) as {
    groupId?: string;
    bountyId?: string;
    reason?: unknown;
  };
  const groupId = requireString(data.groupId, "groupId");
  const bountyId = requireString(data.bountyId, "bountyId");
  const reasonRaw = typeof data.reason === "string" ? data.reason : "";
  const reason = reasonRaw.slice(0, MAX_REJECTION_REASON_CHARS) || null;

  await requireMembership(groupId, uid);

  const bountyRef = db.doc(`groups/${groupId}/bounties/${bountyId}`);
  const leaderboardRef = db.doc(`groups/${groupId}/leaderboard/summary`);
  const activityRef = db
      .collection(`groups/${groupId}/bounties/${bountyId}/activity`)
      .doc();
  const now = Timestamp.now();

  const result = await db.runTransaction(async (tx) => {
    const bountySnap = await tx.get(bountyRef);
    if (!bountySnap.exists) {
      throw new HttpsError("not-found", "Bounty not found.");
    }
    const bounty = bountySnap.data() as BountyData;

    if (bounty.state !== "pending_review") {
      throw new HttpsError(
          "failed-precondition",
          `Cannot reject a bounty in state '${bounty.state}'.`,
      );
    }
    if (bounty.posterId !== uid) {
      throw new HttpsError(
          "permission-denied",
          "Only the original poster can reject this bounty.",
      );
    }
    const claimantId = bounty.claimantId;
    if (!claimantId) {
      throw new HttpsError("failed-precondition", "Bounty has no claimant.");
    }

    const memberRef = db.doc(`groups/${groupId}/members/${claimantId}`);
    const userRef = db.doc(`users/${claimantId}`);
    const memberSnap = await tx.get(memberRef);
    if (!memberSnap.exists) {
      throw new HttpsError("not-found", "Claimant is no longer a member.");
    }
    const member = memberSnap.data() as MemberData;
    const userSnap = await tx.get(userRef);
    const userTotal = (userSnap.data()?.totalPoints as number | undefined) ?? 0;

    const lbSnap = await tx.get(leaderboardRef);
    const currentEntries: LeaderboardEntry[] = lbSnap.exists ?
      ((lbSnap.data()?.entries as LeaderboardEntry[]) ?? []) :
      [];

    /* ── all reads done; now writes ── */

    const newPoints = Math.max(0, (member.points ?? 0) - bounty.price);
    const newLosses = (member.losses ?? 0) + 1;
    const newUserTotal = Math.max(0, userTotal - bounty.price);

    tx.update(bountyRef, {
      state: "failed",
      resolvedAt: now,
      rejectionReason: reason,
    });

    tx.update(memberRef, {points: newPoints, losses: newLosses});
    tx.set(userRef, {totalPoints: newUserTotal}, {merge: true});

    const updatedEntries = upsertLeaderboardEntry(currentEntries, {
      userId: claimantId,
      name: member.displayName ?? "",
      photoURL: member.photoURL ?? null,
      points: newPoints,
      wins: member.wins ?? 0,
      losses: newLosses,
    });
    tx.set(leaderboardRef, {
      entries: updatedEntries,
      updatedAt: now,
    }, {merge: true});

    tx.set(activityRef, {
      kind: "rejected",
      actorId: uid,
      at: now,
      note: reason,
    });

    return {
      claimantId,
      posterId: bounty.posterId,
      price: bounty.price,
      bountyTitle: bounty.title,
    };
  });

  const reviewerName = await memberName(groupId, uid);
  await writeInbox(result.claimantId, {
    kind: "bounty_rejected",
    groupId,
    bountyId,
    actorId: uid,
    actorName: reviewerName,
    amount: result.price,
    reason,
    title: "Claim rejected",
    body: `Your claim on "${result.bountyTitle}" was rejected.` +
      (reason ? ` Reason: ${reason}` : "") + ` -${result.price} pts.`,
  });

  return {ok: true};
});

/* ── onBountyExpiry (nightly sweep) ───────────────────────────────── */

export const onBountyExpiry = onSchedule("every day 03:00", async () => {
  // The scheduled trigger is a thin wrapper; the actual sweep lives in the
  // exported `runBountyExpiry` handler so it can be integration-tested with a
  // controllable `now` against the emulator (see tests/integration/expiry.spec).
  const expired = await runBountyExpiry(db, Timestamp.now());
  if (expired === 0) {
    logger.info("onBountyExpiry: nothing to expire");
  } else {
    logger.info("onBountyExpiry: expired bounties", {count: expired});
  }
});

/* ── createGroup ──────────────────────────────────────────────────── */

const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
const INVITE_CODE_LEN = 6;
const MAX_GROUP_NAME = 60;

function randomInviteCode(): string {
  // crypto.randomInt is a CSPRNG — unlike Math.random(), its output isn't
  // predictable from observed codes, so invite codes can't be guessed by
  // reconstructing the PRNG state.
  let s = "";
  for (let i = 0; i < INVITE_CODE_LEN; i++) {
    s += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return s;
}

async function uniqueInviteCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomInviteCode();
    const existing = await db.collection("groups").where("inviteCode", "==", code).limit(1).get();
    if (existing.empty) return code;
  }
  throw new HttpsError("internal", "Could not allocate invite code.");
}

export const createGroup = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireAuth(req);
  await enforceRateLimit(uid, "createGroup");
  const data = (req.data ?? {}) as { name?: string; emoji?: string };
  const name = requireString(data.name, "name").slice(0, MAX_GROUP_NAME).trim();
  if (name.length === 0) {
    throw new HttpsError("invalid-argument", "name required.");
  }
  const emoji = typeof data.emoji === "string" && data.emoji.length > 0 ?
    data.emoji.slice(0, 8) : "👥";

  const userRef = db.doc(`users/${uid}`);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new HttpsError("failed-precondition", "User profile missing.");
  }
  const user = userSnap.data() as {
    displayName?: string; photoURL?: string | null; groupIds?: string[];
  };

  const inviteCode = await uniqueInviteCode();
  const groupRef = db.collection("groups").doc();
  const memberRef = groupRef.collection("members").doc(uid);
  const leaderboardRef = groupRef.collection("leaderboard").doc("summary");
  const now = Timestamp.now();

  const ownerEntry: LeaderboardEntry = {
    userId: uid,
    name: user.displayName ?? "",
    photoURL: user.photoURL ?? null,
    points: 0,
    wins: 0,
    losses: 0,
  };

  const batch = db.batch();
  batch.set(groupRef, {
    name,
    emoji,
    ownerId: uid,
    inviteCode,
    memberCount: 1,
    defaultExpiryDays: 7,
    createdAt: now,
  });
  batch.set(memberRef, {
    role: "owner",
    points: 0,
    wins: 0,
    losses: 0,
    displayName: user.displayName ?? "",
    photoURL: user.photoURL ?? null,
    joinedAt: now,
  });
  batch.set(leaderboardRef, {entries: [ownerEntry], updatedAt: now});
  batch.update(userRef, {
    groupIds: FieldValue.arrayUnion(groupRef.id),
  });
  await batch.commit();

  return {ok: true, groupId: groupRef.id, inviteCode};
});

/* ── joinGroup ────────────────────────────────────────────────────── */

export const joinGroup = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireAuth(req);
  await enforceRateLimit(uid, "joinGroup");
  const data = (req.data ?? {}) as { inviteCode?: string };
  const inviteCode = requireString(data.inviteCode, "inviteCode")
      .trim()
      .toUpperCase()
      .slice(0, INVITE_CODE_LEN);

  const groupQuery = await db
      .collection("groups")
      .where("inviteCode", "==", inviteCode)
      .limit(1)
      .get();
  if (groupQuery.empty) {
    throw new HttpsError("not-found", "No group matches that invite code.");
  }
  const groupDoc = groupQuery.docs[0]!;
  const groupId = groupDoc.id;

  const memberRef = db.doc(`groups/${groupId}/members/${uid}`);
  const memberSnap = await memberRef.get();
  if (memberSnap.exists) {
    return {ok: true, groupId, alreadyMember: true};
  }

  const userRef = db.doc(`users/${uid}`);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new HttpsError("failed-precondition", "User profile missing.");
  }
  const user = userSnap.data() as {
    displayName?: string; photoURL?: string | null;
  };

  const leaderboardRef = db.doc(`groups/${groupId}/leaderboard/summary`);
  const groupRef = db.doc(`groups/${groupId}`);
  const now = Timestamp.now();

  await db.runTransaction(async (tx) => {
    const lbSnap = await tx.get(leaderboardRef);
    const currentEntries: LeaderboardEntry[] = lbSnap.exists ?
      ((lbSnap.data()?.entries as LeaderboardEntry[]) ?? []) :
      [];

    const entries = upsertLeaderboardEntry(currentEntries, {
      userId: uid,
      name: user.displayName ?? "",
      photoURL: user.photoURL ?? null,
      points: 0,
      wins: 0,
      losses: 0,
    });

    tx.set(memberRef, {
      role: "member",
      points: 0,
      wins: 0,
      losses: 0,
      displayName: user.displayName ?? "",
      photoURL: user.photoURL ?? null,
      joinedAt: now,
    });
    tx.update(groupRef, {
      memberCount: FieldValue.increment(1),
    });
    tx.set(leaderboardRef, {entries, updatedAt: now}, {merge: true});
    tx.set(userRef, {
      groupIds: FieldValue.arrayUnion(groupId),
    }, {merge: true});
  });

  return {ok: true, groupId};
});

/* ── regenerateInviteCode ─────────────────────────────────────────── */

export const regenerateInviteCode = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireAuth(req);
  await enforceRateLimit(uid, "regenerateInviteCode");
  const data = (req.data ?? {}) as { groupId?: string };
  const groupId = requireString(data.groupId, "groupId");

  const groupRef = db.doc(`groups/${groupId}`);
  const memberRef = db.doc(`groups/${groupId}/members/${uid}`);
  const [groupSnap, memberSnap] = await Promise.all([groupRef.get(), memberRef.get()]);
  if (!groupSnap.exists) {
    throw new HttpsError("not-found", "Group not found.");
  }
  if (!memberSnap.exists) {
    throw new HttpsError("permission-denied", "Not a member.");
  }
  const role = (memberSnap.data() as MemberData).role;
  if (role !== "owner" && role !== "admin") {
    throw new HttpsError("permission-denied", "Owner/admin only.");
  }

  const code = await uniqueInviteCode();
  await groupRef.update({inviteCode: code});
  return {inviteCode: code};
});

/* ── markIouPaid ──────────────────────────────────────────────────── */

export const markIouPaid = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireAuth(req);
  await enforceRateLimit(uid, "markIouPaid");
  const data = (req.data ?? {}) as { iouId?: string };
  const iouId = requireString(data.iouId, "iouId");

  const iouRef = db.doc(`ious/${iouId}`);
  const now = Timestamp.now();

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(iouRef);
    if (!snap.exists) {
      throw new HttpsError("not-found", "IOU not found.");
    }
    const iou = snap.data() as {
      debtorId: string;
      creditorId: string;
      status: "open" | "debtor_marked" | "creditor_marked" | "settled";
    };
    if (iou.status === "settled") {
      throw new HttpsError("failed-precondition", "IOU already settled.");
    }
    const isDebtor = iou.debtorId === uid;
    const isCreditor = iou.creditorId === uid;
    if (!isDebtor && !isCreditor) {
      throw new HttpsError("permission-denied", "Not a party to this IOU.");
    }

    const myMark = isDebtor ? "debtor_marked" : "creditor_marked";
    const otherMark = isDebtor ? "creditor_marked" : "debtor_marked";
    const base = {
      debtorId: iou.debtorId,
      creditorId: iou.creditorId,
      isDebtor,
      otherParty: isDebtor ? iou.creditorId : iou.debtorId,
    };

    if (iou.status === "open") {
      tx.update(iouRef, {status: myMark});
      return {...base, settled: false, marked: true};
    }
    if (iou.status === myMark) {
      // already marked by me — no-op
      return {...base, settled: false, marked: false};
    }
    if (iou.status === otherMark) {
      tx.update(iouRef, {status: "settled", settledAt: now});
      return {...base, settled: true, marked: false};
    }
    throw new HttpsError("internal", "Unknown IOU state.");
  });

  if (result.settled) {
    await Promise.all([
      writeInbox(result.debtorId, {
        kind: "iou_settled",
        iouId,
        title: "IOU settled",
        body: "An IOU between you two is now settled.",
      }),
      writeInbox(result.creditorId, {
        kind: "iou_settled",
        iouId,
        title: "IOU settled",
        body: "An IOU between you two is now settled.",
      }),
    ]);
  } else if (result.marked) {
    const actorName = await userName(uid);
    const verb = result.isDebtor ? "paid" : "received";
    await writeInbox(result.otherParty, {
      kind: "iou_marked",
      iouId,
      actorId: uid,
      actorName,
      title: "IOU awaiting confirmation",
      body: `${actorName} marked an IOU as ${verb}. Confirm to settle it.`,
    });
  }

  return {ok: true, settled: result.settled};
});
