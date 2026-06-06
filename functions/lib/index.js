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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.markIouPaid = exports.regenerateInviteCode = exports.joinGroup = exports.createGroup = exports.onBountyExpiry = exports.rejectBounty = exports.approveBounty = exports.contributeToBounty = exports.submitProof = exports.claimBounty = void 0;
const https_1 = require("firebase-functions/v2/https");
const scheduler_1 = require("firebase-functions/v2/scheduler");
// Pull Timestamp/FieldValue from the modular entry point rather than off
// `admin.firestore.*`. The Functions emulator wraps `admin.firestore()` to
// auto-connect to the local emulator, and that wrapper drops the static
// members (Timestamp, FieldValue) — so `admin.firestore.Timestamp` is
// undefined under the emulator. The modular named exports work in both the
// emulator and production.
const firestore_1 = require("firebase-admin/firestore");
const logger = __importStar(require("firebase-functions/logger"));
const node_crypto_1 = require("node:crypto");
const expiry_1 = require("./expiry");
// `./shared` owns admin.initializeApp() + setGlobalOptions and the auth /
// rate-limit / inbox helpers shared with the Stripe functions. Import it
// first so process setup runs before any function below is defined.
const shared_1 = require("./shared");
// Re-export the Stripe Connect payment functions so the Functions runtime
// discovers them from the single index entry point.
__exportStar(require("./stripe"), exports);
const MAX_LEADERBOARD_ENTRIES = 100;
const MAX_PROOF_NOTE_CHARS = 500;
const MAX_REJECTION_REASON_CHARS = 500;
// Per-contribution money bounds, in whole NZD dollars. These mirror the cash
// `price` bounds enforced for bounty creation in firestore.rules (1..100000) so
// a contribution can't push a bounty total past what the create rule would have
// allowed for a single stake.
const MIN_CONTRIBUTION = 1;
const MAX_CONTRIBUTION = 100000;
/* ── helpers ──────────────────────────────────────────────────────── */
/**
 * Leaderboard points a bounty awards on approval / docks on rejection.
 * Decoupled from the reward: cash bounties pin `points` to the dollar price,
 * custom bounties carry a poster-set value. Falls back to `price` for
 * pre-feature docs that predate the `points` field.
 */
function bountyPoints(b) {
    var _a, _b;
    return (_b = (_a = b.points) !== null && _a !== void 0 ? _a : b.price) !== null && _b !== void 0 ? _b : 0;
}
async function requireMembership(groupId, uid) {
    const memberSnap = await shared_1.db.doc(`groups/${groupId}/members/${uid}`).get();
    if (!memberSnap.exists) {
        throw new https_1.HttpsError("permission-denied", "Not a member of this group.");
    }
}
/** Insert or replace an entry, then sort by points desc and cap. */
function upsertLeaderboardEntry(current, entry) {
    const next = current.filter((e) => e.userId !== entry.userId);
    next.push(entry);
    next.sort((a, b) => { var _a, _b; return ((_a = b.points) !== null && _a !== void 0 ? _a : 0) - ((_b = a.points) !== null && _b !== void 0 ? _b : 0); });
    return next.slice(0, MAX_LEADERBOARD_ENTRIES);
}
/* ── claimBounty ──────────────────────────────────────────────────── */
exports.claimBounty = (0, https_1.onCall)(shared_1.CALLABLE_OPTS, async (req) => {
    var _a;
    const uid = (0, shared_1.requireAuth)(req);
    await (0, shared_1.enforceRateLimit)(uid, "claimBounty");
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const groupId = (0, shared_1.requireString)(data.groupId, "groupId");
    const bountyId = (0, shared_1.requireString)(data.bountyId, "bountyId");
    await requireMembership(groupId, uid);
    const bountyRef = shared_1.db.doc(`groups/${groupId}/bounties/${bountyId}`);
    const activityRef = shared_1.db
        .collection(`groups/${groupId}/bounties/${bountyId}/activity`)
        .doc();
    const now = firestore_1.Timestamp.now();
    const result = await shared_1.db.runTransaction(async (tx) => {
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
    const actorName = await (0, shared_1.memberName)(groupId, uid);
    await (0, shared_1.writeInbox)(result.posterId, {
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
exports.submitProof = (0, https_1.onCall)(shared_1.CALLABLE_OPTS, async (req) => {
    var _a;
    const uid = (0, shared_1.requireAuth)(req);
    await (0, shared_1.enforceRateLimit)(uid, "submitProof");
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const groupId = (0, shared_1.requireString)(data.groupId, "groupId");
    const bountyId = (0, shared_1.requireString)(data.bountyId, "bountyId");
    if (!data.proof) {
        throw new https_1.HttpsError("invalid-argument", "proof required.");
    }
    const urls = Array.isArray(data.proof.urls) ?
        data.proof.urls.filter((u) => typeof u === "string").slice(0, 3) :
        [];
    const noteRaw = typeof data.proof.note === "string" ? data.proof.note : "";
    const note = noteRaw.slice(0, MAX_PROOF_NOTE_CHARS);
    await requireMembership(groupId, uid);
    const bountyRef = shared_1.db.doc(`groups/${groupId}/bounties/${bountyId}`);
    const activityRef = shared_1.db
        .collection(`groups/${groupId}/bounties/${bountyId}/activity`)
        .doc();
    const now = firestore_1.Timestamp.now();
    const result = await shared_1.db.runTransaction(async (tx) => {
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
    const actorName = await (0, shared_1.memberName)(groupId, uid);
    await (0, shared_1.writeInbox)(result.posterId, {
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
/* ── contributeToBounty ───────────────────────────────────────────── */
/**
 * Pool money onto an `available` **cash** bounty, raising its total. Any group
 * member — including the poster again — may add to the pot before the bounty is
 * claimed; once claimed (or otherwise resolved) this rejects. Each contribution
 * is recorded per-contributor so that on approval every contributor owes the
 * claimant exactly their own share (see approveBounty).
 *
 * The bounty total is the live `price` field (whole NZD dollars), kept equal to
 * the sum of the contribution docs and with `points` pinned to it (1pt = NZ$1).
 * The poster's original stake is implicit in `price` until the first pool, at
 * which point it's materialised as the poster's own contribution doc so the
 * "total === sum(contributions)" invariant holds from then on.
 */
exports.contributeToBounty = (0, https_1.onCall)(shared_1.CALLABLE_OPTS, async (req) => {
    var _a;
    const uid = (0, shared_1.requireAuth)(req);
    await (0, shared_1.enforceRateLimit)(uid, "contributeToBounty");
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const groupId = (0, shared_1.requireString)(data.groupId, "groupId");
    const bountyId = (0, shared_1.requireString)(data.bountyId, "bountyId");
    const amount = data.amount;
    if (typeof amount !== "number" || !Number.isInteger(amount) ||
        amount < MIN_CONTRIBUTION || amount > MAX_CONTRIBUTION) {
        throw new https_1.HttpsError("invalid-argument", `amount must be a whole dollar value between ${MIN_CONTRIBUTION} ` +
            `and ${MAX_CONTRIBUTION}.`);
    }
    // Caller must be a member of the bounty's group (mirrors the other callables).
    await requireMembership(groupId, uid);
    const bountyRef = shared_1.db.doc(`groups/${groupId}/bounties/${bountyId}`);
    const activityRef = shared_1.db
        .collection(`groups/${groupId}/bounties/${bountyId}/activity`)
        .doc();
    const result = await shared_1.db.runTransaction(async (tx) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const bountySnap = await tx.get(bountyRef);
        if (!bountySnap.exists) {
            throw new https_1.HttpsError("not-found", "Bounty not found.");
        }
        const bounty = bountySnap.data();
        // Pooling is cash-only: a custom reward ("3 beers") has no divisible amount.
        if (bounty.rewardType === "custom") {
            throw new https_1.HttpsError("failed-precondition", "Only cash bounties can be added to.");
        }
        // Money only moves at approval, so pooling is closed once a bounty leaves
        // `available` (a claim, resolution, or expiry all end the window).
        if (bounty.state !== "available") {
            throw new https_1.HttpsError("failed-precondition", `Cannot add to a bounty in state '${bounty.state}'.`);
        }
        const posterId = bounty.posterId;
        const total = (_a = bounty.price) !== null && _a !== void 0 ? _a : 0;
        const posterRef = bountyRef.collection("contributions").doc(posterId);
        const callerRef = bountyRef.collection("contributions").doc(uid);
        const callerMemberRef = shared_1.db.doc(`groups/${groupId}/members/${uid}`);
        // All reads first (Firestore requires reads before writes).
        const posterSnap = await tx.get(posterRef);
        const callerSnap = uid === posterId ? posterSnap : await tx.get(callerRef);
        const callerMemberSnap = await tx.get(callerMemberRef);
        // The poster's display name is only needed when seeding their stake doc.
        const seedPoster = !posterSnap.exists && uid !== posterId;
        const posterMemberSnap = seedPoster ?
            await tx.get(shared_1.db.doc(`groups/${groupId}/members/${posterId}`)) :
            null;
        /* ── all reads done; now writes ── */
        const now = firestore_1.Timestamp.now();
        const callerName = (_c = (_b = callerMemberSnap.data()) === null || _b === void 0 ? void 0 : _b.displayName) !== null && _c !== void 0 ? _c : "";
        // First pool ever: materialise the poster's original stake (== the current
        // total) as a contribution doc so totals stay = sum(contributions). Missing
        // poster doc ⟺ no contributions yet ⟺ price is still the original stake.
        if (seedPoster) {
            tx.set(posterRef, {
                uid: posterId,
                displayName: (_e = (_d = posterMemberSnap === null || posterMemberSnap === void 0 ? void 0 : posterMemberSnap.data()) === null || _d === void 0 ? void 0 : _d.displayName) !== null && _e !== void 0 ? _e : "",
                amount: total,
                createdAt: now,
                updatedAt: now,
            });
        }
        // The caller's prior stake. When the poster pools for the first time their
        // own doc doesn't exist yet but the original stake is baked into `total`.
        const callerPrev = callerSnap.exists ?
            ((_g = (_f = callerSnap.data()) === null || _f === void 0 ? void 0 : _f.amount) !== null && _g !== void 0 ? _g : 0) :
            (uid === posterId ? total : 0);
        const callerCreatedAt = callerSnap.exists ?
            ((_j = (_h = callerSnap.data()) === null || _h === void 0 ? void 0 : _h.createdAt) !== null && _j !== void 0 ? _j : now) :
            now;
        tx.set(callerRef, {
            uid,
            displayName: callerName,
            amount: callerPrev + amount,
            createdAt: callerCreatedAt,
            updatedAt: now,
        });
        const newTotal = total + amount;
        // `price` is the live total; `points` stays pinned to it (1pt = NZ$1) so the
        // leaderboard award on approval reflects the full pooled value.
        tx.update(bountyRef, { price: newTotal, points: newTotal });
        // Activity event is a post-commit-style side effect, but cheap and safe to
        // write in-band here; it isn't load-bearing for the total.
        tx.set(activityRef, {
            kind: "contributed",
            actorId: uid,
            at: now,
            amount,
        });
        return { posterId, newTotal, bountyTitle: bounty.title };
    });
    return { ok: true, total: result.newTotal };
});
/* ── approveBounty ────────────────────────────────────────────────── */
exports.approveBounty = (0, https_1.onCall)(shared_1.CALLABLE_OPTS, async (req) => {
    var _a;
    const uid = (0, shared_1.requireAuth)(req);
    await (0, shared_1.enforceRateLimit)(uid, "approveBounty");
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const groupId = (0, shared_1.requireString)(data.groupId, "groupId");
    const bountyId = (0, shared_1.requireString)(data.bountyId, "bountyId");
    await requireMembership(groupId, uid);
    const bountyRef = shared_1.db.doc(`groups/${groupId}/bounties/${bountyId}`);
    const contributionsRef = bountyRef.collection("contributions");
    const leaderboardRef = shared_1.db.doc(`groups/${groupId}/leaderboard/summary`);
    const activityRef = shared_1.db
        .collection(`groups/${groupId}/bounties/${bountyId}/activity`)
        .doc();
    const now = firestore_1.Timestamp.now();
    const result = await shared_1.db.runTransaction(async (tx) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
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
        const memberRef = shared_1.db.doc(`groups/${groupId}/members/${claimantId}`);
        const userRef = shared_1.db.doc(`users/${claimantId}`);
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
        // Pooled contributions (cash only). Read with the other reads so we can fan
        // out one IOU per contributor below. Empty ⟺ nobody pooled, in which case
        // we fall back to the single-IOU behaviour using the bounty's own price.
        const isCustom = bounty.rewardType === "custom";
        const contribSnap = isCustom ?
            null : await tx.get(contributionsRef);
        /* ── all reads done; now writes ── */
        const pts = bountyPoints(bounty);
        const newPoints = ((_e = member.points) !== null && _e !== void 0 ? _e : 0) + pts;
        const newWins = ((_f = member.wins) !== null && _f !== void 0 ? _f : 0) + 1;
        const newUserTotal = userTotal + pts;
        tx.update(bountyRef, { state: "successful", resolvedAt: now });
        tx.update(memberRef, { points: newPoints, wins: newWins });
        tx.set(userRef, { totalPoints: newUserTotal }, { merge: true });
        // One IOU per debtor, each settling independently (cash or Stripe):
        //  • Custom reward → a single manual-only IOU carrying the reward text with
        //    no monetary amount; the Stripe callable refuses to build a PI for it.
        //  • Pooled cash bounty → one cash IOU per contributor for their own share
        //    (the poster's stake is just another contributor). A contributor who is
        //    also the winner is skipped — they don't owe themselves.
        //  • Cash bounty nobody pooled on (or a legacy doc) → today's single IOU
        //    for the full price.
        let posterOwed = (_g = bounty.price) !== null && _g !== void 0 ? _g : 0;
        if (isCustom) {
            tx.set(shared_1.db.collection("ious").doc(), {
                groupId,
                debtorId: bounty.posterId,
                creditorId: claimantId,
                amount: 0,
                rewardType: "custom",
                rewardText: (_h = bounty.rewardText) !== null && _h !== void 0 ? _h : "",
                bountyId,
                status: "open",
                createdAt: now,
            });
        }
        else if (contribSnap && !contribSnap.empty) {
            posterOwed = 0;
            for (const c of contribSnap.docs) {
                const cData = c.data();
                const debtorId = (_j = cData.uid) !== null && _j !== void 0 ? _j : c.id;
                const amount = (_k = cData.amount) !== null && _k !== void 0 ? _k : 0;
                if (amount <= 0 || debtorId === claimantId)
                    continue;
                if (debtorId === bounty.posterId)
                    posterOwed = amount;
                tx.set(shared_1.db.collection("ious").doc(), {
                    groupId,
                    debtorId,
                    creditorId: claimantId,
                    amount,
                    bountyId,
                    status: "open",
                    createdAt: now,
                });
            }
        }
        else {
            tx.set(shared_1.db.collection("ious").doc(), {
                groupId,
                debtorId: bounty.posterId,
                creditorId: claimantId,
                amount: bounty.price,
                bountyId,
                status: "open",
                createdAt: now,
            });
        }
        const updatedEntries = upsertLeaderboardEntry(currentEntries, {
            userId: claimantId,
            name: (_l = member.displayName) !== null && _l !== void 0 ? _l : "",
            photoURL: (_m = member.photoURL) !== null && _m !== void 0 ? _m : null,
            points: newPoints,
            wins: newWins,
            losses: (_o = member.losses) !== null && _o !== void 0 ? _o : 0,
        });
        tx.set(leaderboardRef, {
            entries: updatedEntries,
            updatedAt: now,
        }, { merge: true });
        tx.set(activityRef, { kind: "approved", actorId: uid, at: now });
        return {
            claimantId,
            posterId: bounty.posterId,
            points: pts,
            isCustom,
            // What the poster now owes, phrased for the notification body. With a
            // pooled bounty the poster owes only their own share; other contributors
            // get their own IOUs (and their own notification is out of scope here).
            owed: isCustom ? ((_p = bounty.rewardText) !== null && _p !== void 0 ? _p : "the reward") : `$${posterOwed}`,
            bountyTitle: bounty.title,
        };
    });
    const reviewerName = await (0, shared_1.memberName)(groupId, uid);
    await Promise.all([
        (0, shared_1.writeInbox)(result.claimantId, {
            kind: "bounty_approved",
            groupId,
            bountyId,
            actorId: uid,
            actorName: reviewerName,
            amount: result.points,
            title: "Claim approved",
            body: `Your claim on "${result.bountyTitle}" was approved. ` +
                `+${result.points} pts.`,
        }),
        (0, shared_1.writeInbox)(result.posterId, {
            kind: "bounty_resolved",
            groupId,
            bountyId,
            actorId: uid,
            amount: result.points,
            title: "Bounty resolved",
            body: `You approved "${result.bountyTitle}". You now owe ${result.owed}.`,
        }),
    ]);
    return { ok: true };
});
/* ── rejectBounty ─────────────────────────────────────────────────── */
exports.rejectBounty = (0, https_1.onCall)(shared_1.CALLABLE_OPTS, async (req) => {
    var _a;
    const uid = (0, shared_1.requireAuth)(req);
    await (0, shared_1.enforceRateLimit)(uid, "rejectBounty");
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const groupId = (0, shared_1.requireString)(data.groupId, "groupId");
    const bountyId = (0, shared_1.requireString)(data.bountyId, "bountyId");
    const reasonRaw = typeof data.reason === "string" ? data.reason : "";
    const reason = reasonRaw.slice(0, MAX_REJECTION_REASON_CHARS) || null;
    await requireMembership(groupId, uid);
    const bountyRef = shared_1.db.doc(`groups/${groupId}/bounties/${bountyId}`);
    const leaderboardRef = shared_1.db.doc(`groups/${groupId}/leaderboard/summary`);
    const activityRef = shared_1.db
        .collection(`groups/${groupId}/bounties/${bountyId}/activity`)
        .doc();
    const now = firestore_1.Timestamp.now();
    const result = await shared_1.db.runTransaction(async (tx) => {
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
        const memberRef = shared_1.db.doc(`groups/${groupId}/members/${claimantId}`);
        const userRef = shared_1.db.doc(`users/${claimantId}`);
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
        const pts = bountyPoints(bounty);
        const newPoints = Math.max(0, ((_e = member.points) !== null && _e !== void 0 ? _e : 0) - pts);
        const newLosses = ((_f = member.losses) !== null && _f !== void 0 ? _f : 0) + 1;
        const newUserTotal = Math.max(0, userTotal - pts);
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
            points: pts,
            bountyTitle: bounty.title,
        };
    });
    const reviewerName = await (0, shared_1.memberName)(groupId, uid);
    await (0, shared_1.writeInbox)(result.claimantId, {
        kind: "bounty_rejected",
        groupId,
        bountyId,
        actorId: uid,
        actorName: reviewerName,
        amount: result.points,
        reason,
        title: "Claim rejected",
        body: `Your claim on "${result.bountyTitle}" was rejected.` +
            (reason ? ` Reason: ${reason}` : "") + ` -${result.points} pts.`,
    });
    return { ok: true };
});
/* ── onBountyExpiry (nightly sweep) ───────────────────────────────── */
exports.onBountyExpiry = (0, scheduler_1.onSchedule)("every day 03:00", async () => {
    // The scheduled trigger is a thin wrapper; the actual sweep lives in the
    // exported `runBountyExpiry` handler so it can be integration-tested with a
    // controllable `now` against the emulator (see tests/integration/expiry.spec).
    const expired = await (0, expiry_1.runBountyExpiry)(shared_1.db, firestore_1.Timestamp.now());
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
    // crypto.randomInt is a CSPRNG — unlike Math.random(), its output isn't
    // predictable from observed codes, so invite codes can't be guessed by
    // reconstructing the PRNG state.
    let s = "";
    for (let i = 0; i < INVITE_CODE_LEN; i++) {
        s += INVITE_CODE_ALPHABET[(0, node_crypto_1.randomInt)(INVITE_CODE_ALPHABET.length)];
    }
    return s;
}
async function uniqueInviteCode() {
    for (let attempt = 0; attempt < 10; attempt++) {
        const code = randomInviteCode();
        const existing = await shared_1.db.collection("groups").where("inviteCode", "==", code).limit(1).get();
        if (existing.empty)
            return code;
    }
    throw new https_1.HttpsError("internal", "Could not allocate invite code.");
}
exports.createGroup = (0, https_1.onCall)(shared_1.CALLABLE_OPTS, async (req) => {
    var _a, _b, _c, _d, _e;
    const uid = (0, shared_1.requireAuth)(req);
    await (0, shared_1.enforceRateLimit)(uid, "createGroup");
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const name = (0, shared_1.requireString)(data.name, "name").slice(0, MAX_GROUP_NAME).trim();
    if (name.length === 0) {
        throw new https_1.HttpsError("invalid-argument", "name required.");
    }
    const emoji = typeof data.emoji === "string" && data.emoji.length > 0 ?
        data.emoji.slice(0, 8) : "👥";
    const userRef = shared_1.db.doc(`users/${uid}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
        throw new https_1.HttpsError("failed-precondition", "User profile missing.");
    }
    const user = userSnap.data();
    const inviteCode = await uniqueInviteCode();
    const groupRef = shared_1.db.collection("groups").doc();
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
    const batch = shared_1.db.batch();
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
exports.joinGroup = (0, https_1.onCall)(shared_1.CALLABLE_OPTS, async (req) => {
    var _a;
    const uid = (0, shared_1.requireAuth)(req);
    await (0, shared_1.enforceRateLimit)(uid, "joinGroup");
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const inviteCode = (0, shared_1.requireString)(data.inviteCode, "inviteCode")
        .trim()
        .toUpperCase()
        .slice(0, INVITE_CODE_LEN);
    const groupQuery = await shared_1.db
        .collection("groups")
        .where("inviteCode", "==", inviteCode)
        .limit(1)
        .get();
    if (groupQuery.empty) {
        throw new https_1.HttpsError("not-found", "No group matches that invite code.");
    }
    const groupDoc = groupQuery.docs[0];
    const groupId = groupDoc.id;
    const memberRef = shared_1.db.doc(`groups/${groupId}/members/${uid}`);
    const memberSnap = await memberRef.get();
    if (memberSnap.exists) {
        return { ok: true, groupId, alreadyMember: true };
    }
    const userRef = shared_1.db.doc(`users/${uid}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
        throw new https_1.HttpsError("failed-precondition", "User profile missing.");
    }
    const user = userSnap.data();
    const leaderboardRef = shared_1.db.doc(`groups/${groupId}/leaderboard/summary`);
    const groupRef = shared_1.db.doc(`groups/${groupId}`);
    const now = firestore_1.Timestamp.now();
    await shared_1.db.runTransaction(async (tx) => {
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
exports.regenerateInviteCode = (0, https_1.onCall)(shared_1.CALLABLE_OPTS, async (req) => {
    var _a;
    const uid = (0, shared_1.requireAuth)(req);
    await (0, shared_1.enforceRateLimit)(uid, "regenerateInviteCode");
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const groupId = (0, shared_1.requireString)(data.groupId, "groupId");
    const groupRef = shared_1.db.doc(`groups/${groupId}`);
    const memberRef = shared_1.db.doc(`groups/${groupId}/members/${uid}`);
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
exports.markIouPaid = (0, https_1.onCall)(shared_1.CALLABLE_OPTS, async (req) => {
    var _a;
    const uid = (0, shared_1.requireAuth)(req);
    await (0, shared_1.enforceRateLimit)(uid, "markIouPaid");
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const iouId = (0, shared_1.requireString)(data.iouId, "iouId");
    const iouRef = shared_1.db.doc(`ious/${iouId}`);
    const now = firestore_1.Timestamp.now();
    const result = await shared_1.db.runTransaction(async (tx) => {
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
            (0, shared_1.writeInbox)(result.debtorId, {
                kind: "iou_settled",
                iouId,
                title: "IOU settled",
                body: "An IOU between you two is now settled.",
            }),
            (0, shared_1.writeInbox)(result.creditorId, {
                kind: "iou_settled",
                iouId,
                title: "IOU settled",
                body: "An IOU between you two is now settled.",
            }),
        ]);
    }
    else if (result.marked) {
        const actorName = await (0, shared_1.userName)(uid);
        const verb = result.isDebtor ? "paid" : "received";
        await (0, shared_1.writeInbox)(result.otherParty, {
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