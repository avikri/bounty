"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.markIouPaid = exports.regenerateInviteCode = exports.joinGroup = exports.createGroup = exports.onBountyExpiry = exports.rejectBounty = exports.approveBounty = exports.submitProof = exports.claimBounty = void 0;
const firebase_functions_1 = require("firebase-functions");
const https_1 = require("firebase-functions/v2/https");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const admin = __importStar(require("firebase-admin"));
// Pull Timestamp/FieldValue from the modular entry point rather than off
// `admin.firestore.*`. The Functions emulator wraps `admin.firestore()` to
// auto-connect to the local emulator, and that wrapper drops the static
// members (Timestamp, FieldValue) — so `admin.firestore.Timestamp` is
// undefined under the emulator. The modular named exports work in both the
// emulator and production.
const firestore_1 = require("firebase-admin/firestore");
const logger = __importStar(require("firebase-functions/logger"));
const expiry_1 = require("./expiry");
admin.initializeApp();
const db = admin.firestore();
(0, firebase_functions_1.setGlobalOptions)({ maxInstances: 10, region: "australia-southeast1" });
const MAX_LEADERBOARD_ENTRIES = 100;
const MAX_PROOF_NOTE_CHARS = 500;
const MAX_REJECTION_REASON_CHARS = 500;
/* ── helpers ──────────────────────────────────────────────────────── */
function requireAuth(req) {
    var _a;
    const uid = (_a = req.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!uid)
        throw new https_1.HttpsError("unauthenticated", "Sign-in required.");
    return uid;
}
async function requireMembership(groupId, uid) {
    const memberSnap = await db.doc(`groups/${groupId}/members/${uid}`).get();
    if (!memberSnap.exists) {
        throw new https_1.HttpsError("permission-denied", "Not a member of this group.");
    }
}
function requireString(value, name) {
    if (typeof value !== "string" || value.length === 0) {
        throw new https_1.HttpsError("invalid-argument", `${name} required.`);
    }
    return value;
}
/** Insert or replace an entry, then sort by points desc and cap. */
function upsertLeaderboardEntry(current, entry) {
    const next = current.filter((e) => e.userId !== entry.userId);
    next.push(entry);
    next.sort((a, b) => { var _a, _b; return ((_a = b.points) !== null && _a !== void 0 ? _a : 0) - ((_b = a.points) !== null && _b !== void 0 ? _b : 0); });
    return next.slice(0, MAX_LEADERBOARD_ENTRIES);
}
async function writeInbox(userId, payload) {
    try {
        await db.collection(`notifications/${userId}/inbox`).add(Object.assign(Object.assign({}, payload), { createdAt: firestore_1.Timestamp.now(), read: false }));
    }
    catch (e) {
        logger.warn("inbox write failed", { userId, error: String(e) });
    }
}
/** Best-effort lookup of a member's cached display name within a group. */
async function memberName(groupId, uid) {
    var _a;
    try {
        const snap = await db.doc(`groups/${groupId}/members/${uid}`).get();
        return ((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.displayName) || "Someone";
    }
    catch (_b) {
        return "Someone";
    }
}
/** Best-effort lookup of a top-level user's display name. */
async function userName(uid) {
    var _a;
    try {
        const snap = await db.doc(`users/${uid}`).get();
        return ((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.displayName) || "Someone";
    }
    catch (_b) {
        return "Someone";
    }
}
/* ── claimBounty ──────────────────────────────────────────────────── */
exports.claimBounty = (0, https_1.onCall)(async (req) => {
    var _a;
    const uid = requireAuth(req);
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const groupId = requireString(data.groupId, "groupId");
    const bountyId = requireString(data.bountyId, "bountyId");
    await requireMembership(groupId, uid);
    const bountyRef = db.doc(`groups/${groupId}/bounties/${bountyId}`);
    const activityRef = db
        .collection(`groups/${groupId}/bounties/${bountyId}/activity`)
        .doc();
    const now = firestore_1.Timestamp.now();
    const result = await db.runTransaction(async (tx) => {
        const bountySnap = await tx.get(bountyRef);
        if (!bountySnap.exists) {
            throw new https_1.HttpsError("not-found", "Bounty not found.");
        }
        const bounty = bountySnap.data();
        if (bounty.state !== "available") {
            throw new https_1.HttpsError("failed-precondition", `Cannot claim a bounty in state '${bounty.state}'.`);
        }
        if (bounty.posterId === uid) {
            throw new https_1.HttpsError("failed-precondition", "You can't claim your own bounty.");
        }
        if (bounty.expiresAt && bounty.expiresAt.toMillis() <= Date.now()) {
            throw new https_1.HttpsError("failed-precondition", "Bounty has expired.");
        }
        tx.update(bountyRef, { state: "claimed", claimantId: uid });
        tx.set(activityRef, { kind: "claimed", actorId: uid, at: now });
        return { posterId: bounty.posterId, bountyTitle: bounty.title };
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
    return { ok: true };
});
/* ── submitProof ──────────────────────────────────────────────────── */
exports.submitProof = (0, https_1.onCall)(async (req) => {
    var _a;
    const uid = requireAuth(req);
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const groupId = requireString(data.groupId, "groupId");
    const bountyId = requireString(data.bountyId, "bountyId");
    if (!data.proof) {
        throw new https_1.HttpsError("invalid-argument", "proof required.");
    }
    const urls = Array.isArray(data.proof.urls) ?
        data.proof.urls.filter((u) => typeof u === "string").slice(0, 3) :
        [];
    const noteRaw = typeof data.proof.note === "string" ? data.proof.note : "";
    const note = noteRaw.slice(0, MAX_PROOF_NOTE_CHARS);
    await requireMembership(groupId, uid);
    const bountyRef = db.doc(`groups/${groupId}/bounties/${bountyId}`);
    const activityRef = db
        .collection(`groups/${groupId}/bounties/${bountyId}/activity`)
        .doc();
    const now = firestore_1.Timestamp.now();
    const result = await db.runTransaction(async (tx) => {
        const bountySnap = await tx.get(bountyRef);
        if (!bountySnap.exists) {
            throw new https_1.HttpsError("not-found", "Bounty not found.");
        }
        const bounty = bountySnap.data();
        if (bounty.state !== "claimed") {
            throw new https_1.HttpsError("failed-precondition", `Cannot submit proof for a bounty in state '${bounty.state}'.`);
        }
        if (bounty.claimantId !== uid) {
            throw new https_1.HttpsError("permission-denied", "Only the current claimant can submit proof.");
        }
        tx.update(bountyRef, {
            state: "pending_review",
            proof: { urls, note },
        });
        tx.set(activityRef, {
            kind: "submitted",
            actorId: uid,
            at: now,
            note: note || null,
        });
        return { posterId: bounty.posterId, bountyTitle: bounty.title };
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
    return { ok: true };
});
/* ── approveBounty ────────────────────────────────────────────────── */
exports.approveBounty = (0, https_1.onCall)(async (req) => {
    var _a;
    const uid = requireAuth(req);
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const groupId = requireString(data.groupId, "groupId");
    const bountyId = requireString(data.bountyId, "bountyId");
    await requireMembership(groupId, uid);
    const bountyRef = db.doc(`groups/${groupId}/bounties/${bountyId}`);
    const leaderboardRef = db.doc(`groups/${groupId}/leaderboard/summary`);
    const activityRef = db
        .collection(`groups/${groupId}/bounties/${bountyId}/activity`)
        .doc();
    const iouRef = db.collection("ious").doc();
    const now = firestore_1.Timestamp.now();
    const result = await db.runTransaction(async (tx) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const bountySnap = await tx.get(bountyRef);
        if (!bountySnap.exists) {
            throw new https_1.HttpsError("not-found", "Bounty not found.");
        }
        const bounty = bountySnap.data();
        if (bounty.state !== "pending_review") {
            throw new https_1.HttpsError("failed-precondition", `Cannot approve a bounty in state '${bounty.state}'.`);
        }
        if (bounty.posterId !== uid) {
            throw new https_1.HttpsError("permission-denied", "Only the original poster can approve this bounty.");
        }
        const claimantId = bounty.claimantId;
        if (!claimantId) {
            throw new https_1.HttpsError("failed-precondition", "Bounty has no claimant.");
        }
        const memberRef = db.doc(`groups/${groupId}/members/${claimantId}`);
        const userRef = db.doc(`users/${claimantId}`);
        const memberSnap = await tx.get(memberRef);
        if (!memberSnap.exists) {
            throw new https_1.HttpsError("not-found", "Claimant is no longer a member.");
        }
        const member = memberSnap.data();
        const userSnap = await tx.get(userRef);
        const userTotal = (_b = (_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.totalPoints) !== null && _b !== void 0 ? _b : 0;
        const lbSnap = await tx.get(leaderboardRef);
        const currentEntries = lbSnap.exists ?
            ((_d = (_c = lbSnap.data()) === null || _c === void 0 ? void 0 : _c.entries) !== null && _d !== void 0 ? _d : []) :
            [];
        /* ── all reads done; now writes ── */
        const newPoints = ((_e = member.points) !== null && _e !== void 0 ? _e : 0) + bounty.price;
        const newWins = ((_f = member.wins) !== null && _f !== void 0 ? _f : 0) + 1;
        const newUserTotal = userTotal + bounty.price;
        tx.update(bountyRef, { state: "successful", resolvedAt: now });
        tx.update(memberRef, { points: newPoints, wins: newWins });
        tx.set(userRef, { totalPoints: newUserTotal }, { merge: true });
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
            name: (_g = member.displayName) !== null && _g !== void 0 ? _g : "",
            photoURL: (_h = member.photoURL) !== null && _h !== void 0 ? _h : null,
            points: newPoints,
            wins: newWins,
            losses: (_j = member.losses) !== null && _j !== void 0 ? _j : 0,
        });
        tx.set(leaderboardRef, {
            entries: updatedEntries,
            updatedAt: now,
        }, { merge: true });
        tx.set(activityRef, { kind: "approved", actorId: uid, at: now });
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
    return { ok: true };
});
/* ── rejectBounty ─────────────────────────────────────────────────── */
exports.rejectBounty = (0, https_1.onCall)(async (req) => {
    var _a;
    const uid = requireAuth(req);
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
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
    const now = firestore_1.Timestamp.now();
    const result = await db.runTransaction(async (tx) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const bountySnap = await tx.get(bountyRef);
        if (!bountySnap.exists) {
            throw new https_1.HttpsError("not-found", "Bounty not found.");
        }
        const bounty = bountySnap.data();
        if (bounty.state !== "pending_review") {
            throw new https_1.HttpsError("failed-precondition", `Cannot reject a bounty in state '${bounty.state}'.`);
        }
        if (bounty.posterId !== uid) {
            throw new https_1.HttpsError("permission-denied", "Only the original poster can reject this bounty.");
        }
        const claimantId = bounty.claimantId;
        if (!claimantId) {
            throw new https_1.HttpsError("failed-precondition", "Bounty has no claimant.");
        }
        const memberRef = db.doc(`groups/${groupId}/members/${claimantId}`);
        const userRef = db.doc(`users/${claimantId}`);
        const memberSnap = await tx.get(memberRef);
        if (!memberSnap.exists) {
            throw new https_1.HttpsError("not-found", "Claimant is no longer a member.");
        }
        const member = memberSnap.data();
        const userSnap = await tx.get(userRef);
        const userTotal = (_b = (_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.totalPoints) !== null && _b !== void 0 ? _b : 0;
        const lbSnap = await tx.get(leaderboardRef);
        const currentEntries = lbSnap.exists ?
            ((_d = (_c = lbSnap.data()) === null || _c === void 0 ? void 0 : _c.entries) !== null && _d !== void 0 ? _d : []) :
            [];
        /* ── all reads done; now writes ── */
        const newPoints = Math.max(0, ((_e = member.points) !== null && _e !== void 0 ? _e : 0) - bounty.price);
        const newLosses = ((_f = member.losses) !== null && _f !== void 0 ? _f : 0) + 1;
        const newUserTotal = Math.max(0, userTotal - bounty.price);
        tx.update(bountyRef, {
            state: "failed",
            resolvedAt: now,
            rejectionReason: reason,
        });
        tx.update(memberRef, { points: newPoints, losses: newLosses });
        tx.set(userRef, { totalPoints: newUserTotal }, { merge: true });
        const updatedEntries = upsertLeaderboardEntry(currentEntries, {
            userId: claimantId,
            name: (_g = member.displayName) !== null && _g !== void 0 ? _g : "",
            photoURL: (_h = member.photoURL) !== null && _h !== void 0 ? _h : null,
            points: newPoints,
            wins: (_j = member.wins) !== null && _j !== void 0 ? _j : 0,
            losses: newLosses,
        });
        tx.set(leaderboardRef, {
            entries: updatedEntries,
            updatedAt: now,
        }, { merge: true });
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
    return { ok: true };
});
/* ── onBountyExpiry (nightly sweep) ───────────────────────────────── */
exports.onBountyExpiry = (0, scheduler_1.onSchedule)("every day 03:00", async () => {
    // The scheduled trigger is a thin wrapper; the actual sweep lives in the
    // exported `runBountyExpiry` handler so it can be integration-tested with a
    // controllable `now` against the emulator (see tests/integration/expiry.spec).
    const expired = await (0, expiry_1.runBountyExpiry)(db, firestore_1.Timestamp.now());
    if (expired === 0) {
        logger.info("onBountyExpiry: nothing to expire");
    }
    else {
        logger.info("onBountyExpiry: expired bounties", { count: expired });
    }
});
/* ── createGroup ──────────────────────────────────────────────────── */
const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
const INVITE_CODE_LEN = 6;
const MAX_GROUP_NAME = 60;
function randomInviteCode() {
    let s = "";
    for (let i = 0; i < INVITE_CODE_LEN; i++) {
        s += INVITE_CODE_ALPHABET[Math.floor(Math.random() * INVITE_CODE_ALPHABET.length)];
    }
    return s;
}
async function uniqueInviteCode() {
    for (let attempt = 0; attempt < 10; attempt++) {
        const code = randomInviteCode();
        const existing = await db.collection("groups").where("inviteCode", "==", code).limit(1).get();
        if (existing.empty)
            return code;
    }
    throw new https_1.HttpsError("internal", "Could not allocate invite code.");
}
exports.createGroup = (0, https_1.onCall)(async (req) => {
    var _a, _b, _c, _d, _e;
    const uid = requireAuth(req);
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const name = requireString(data.name, "name").slice(0, MAX_GROUP_NAME).trim();
    if (name.length === 0) {
        throw new https_1.HttpsError("invalid-argument", "name required.");
    }
    const emoji = typeof data.emoji === "string" && data.emoji.length > 0 ?
        data.emoji.slice(0, 8) : "👥";
    const userRef = db.doc(`users/${uid}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
        throw new https_1.HttpsError("failed-precondition", "User profile missing.");
    }
    const user = userSnap.data();
    const inviteCode = await uniqueInviteCode();
    const groupRef = db.collection("groups").doc();
    const memberRef = groupRef.collection("members").doc(uid);
    const leaderboardRef = groupRef.collection("leaderboard").doc("summary");
    const now = firestore_1.Timestamp.now();
    const ownerEntry = {
        userId: uid,
        name: (_b = user.displayName) !== null && _b !== void 0 ? _b : "",
        photoURL: (_c = user.photoURL) !== null && _c !== void 0 ? _c : null,
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
        displayName: (_d = user.displayName) !== null && _d !== void 0 ? _d : "",
        photoURL: (_e = user.photoURL) !== null && _e !== void 0 ? _e : null,
        joinedAt: now,
    });
    batch.set(leaderboardRef, { entries: [ownerEntry], updatedAt: now });
    batch.update(userRef, {
        groupIds: firestore_1.FieldValue.arrayUnion(groupRef.id),
    });
    await batch.commit();
    return { ok: true, groupId: groupRef.id, inviteCode };
});
/* ── joinGroup ────────────────────────────────────────────────────── */
exports.joinGroup = (0, https_1.onCall)(async (req) => {
    var _a;
    const uid = requireAuth(req);
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
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
        throw new https_1.HttpsError("not-found", "No group matches that invite code.");
    }
    const groupDoc = groupQuery.docs[0];
    const groupId = groupDoc.id;
    const memberRef = db.doc(`groups/${groupId}/members/${uid}`);
    const memberSnap = await memberRef.get();
    if (memberSnap.exists) {
        return { ok: true, groupId, alreadyMember: true };
    }
    const userRef = db.doc(`users/${uid}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
        throw new https_1.HttpsError("failed-precondition", "User profile missing.");
    }
    const user = userSnap.data();
    const leaderboardRef = db.doc(`groups/${groupId}/leaderboard/summary`);
    const groupRef = db.doc(`groups/${groupId}`);
    const now = firestore_1.Timestamp.now();
    await db.runTransaction(async (tx) => {
        var _a, _b, _c, _d, _e, _f;
        const lbSnap = await tx.get(leaderboardRef);
        const currentEntries = lbSnap.exists ?
            ((_b = (_a = lbSnap.data()) === null || _a === void 0 ? void 0 : _a.entries) !== null && _b !== void 0 ? _b : []) :
            [];
        const entries = upsertLeaderboardEntry(currentEntries, {
            userId: uid,
            name: (_c = user.displayName) !== null && _c !== void 0 ? _c : "",
            photoURL: (_d = user.photoURL) !== null && _d !== void 0 ? _d : null,
            points: 0,
            wins: 0,
            losses: 0,
        });
        tx.set(memberRef, {
            role: "member",
            points: 0,
            wins: 0,
            losses: 0,
            displayName: (_e = user.displayName) !== null && _e !== void 0 ? _e : "",
            photoURL: (_f = user.photoURL) !== null && _f !== void 0 ? _f : null,
            joinedAt: now,
        });
        tx.update(groupRef, {
            memberCount: firestore_1.FieldValue.increment(1),
        });
        tx.set(leaderboardRef, { entries, updatedAt: now }, { merge: true });
        tx.set(userRef, {
            groupIds: firestore_1.FieldValue.arrayUnion(groupId),
        }, { merge: true });
    });
    return { ok: true, groupId };
});
/* ── regenerateInviteCode ─────────────────────────────────────────── */
exports.regenerateInviteCode = (0, https_1.onCall)(async (req) => {
    var _a;
    const uid = requireAuth(req);
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const groupId = requireString(data.groupId, "groupId");
    const groupRef = db.doc(`groups/${groupId}`);
    const memberRef = db.doc(`groups/${groupId}/members/${uid}`);
    const [groupSnap, memberSnap] = await Promise.all([groupRef.get(), memberRef.get()]);
    if (!groupSnap.exists) {
        throw new https_1.HttpsError("not-found", "Group not found.");
    }
    if (!memberSnap.exists) {
        throw new https_1.HttpsError("permission-denied", "Not a member.");
    }
    const role = memberSnap.data().role;
    if (role !== "owner" && role !== "admin") {
        throw new https_1.HttpsError("permission-denied", "Owner/admin only.");
    }
    const code = await uniqueInviteCode();
    await groupRef.update({ inviteCode: code });
    return { inviteCode: code };
});
/* ── markIouPaid ──────────────────────────────────────────────────── */
exports.markIouPaid = (0, https_1.onCall)(async (req) => {
    var _a;
    const uid = requireAuth(req);
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const iouId = requireString(data.iouId, "iouId");
    const iouRef = db.doc(`ious/${iouId}`);
    const now = firestore_1.Timestamp.now();
    const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(iouRef);
        if (!snap.exists) {
            throw new https_1.HttpsError("not-found", "IOU not found.");
        }
        const iou = snap.data();
        if (iou.status === "settled") {
            throw new https_1.HttpsError("failed-precondition", "IOU already settled.");
        }
        const isDebtor = iou.debtorId === uid;
        const isCreditor = iou.creditorId === uid;
        if (!isDebtor && !isCreditor) {
            throw new https_1.HttpsError("permission-denied", "Not a party to this IOU.");
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
            tx.update(iouRef, { status: myMark });
            return Object.assign(Object.assign({}, base), { settled: false, marked: true });
        }
        if (iou.status === myMark) {
            // already marked by me — no-op
            return Object.assign(Object.assign({}, base), { settled: false, marked: false });
        }
        if (iou.status === otherMark) {
            tx.update(iouRef, { status: "settled", settledAt: now });
            return Object.assign(Object.assign({}, base), { settled: true, marked: false });
        }
        throw new https_1.HttpsError("internal", "Unknown IOU state.");
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
    }
    else if (result.marked) {
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
    return { ok: true, settled: result.settled };
});
//# sourceMappingURL=index.js.map