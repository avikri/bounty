"use strict";
/**
 * Shared Cloud Functions plumbing used by both the bounty state-machine
 * callables (index.ts) and the Stripe payment functions (stripe.ts).
 *
 * This module owns one-time process setup — `admin.initializeApp()` and
 * `setGlobalOptions` — so that it runs before *any* function is defined,
 * regardless of which file's functions are evaluated first. Keeping the auth,
 * rate-limit, and inbox helpers here (rather than duplicating them in the
 * Stripe module) means there is a single source of truth for the security
 * checks that gate every callable.
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
exports.CALLABLE_OPTS = exports.db = void 0;
exports.requireAuth = requireAuth;
exports.requireString = requireString;
exports.enforceRateLimit = enforceRateLimit;
exports.isStripePaymentsEnabled = isStripePaymentsEnabled;
exports.requireStripePaymentsEnabled = requireStripePaymentsEnabled;
exports.writeInbox = writeInbox;
exports.memberName = memberName;
exports.userName = userName;
const firebase_functions_1 = require("firebase-functions");
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const logger = __importStar(require("firebase-functions/logger"));
admin.initializeApp();
(0, firebase_functions_1.setGlobalOptions)({ maxInstances: 10, region: "australia-southeast1" });
exports.db = admin.firestore();
// App Check enforcement on the callables. OFF by default so the app works
// without a reCAPTCHA/App Check provider configured. To turn it on later:
//   1. Configure client App Check (initializeAppCheck with a real site key).
//   2. Set ENFORCE_APP_CHECK=true (e.g. in functions/.env) and redeploy.
// Never enforced under the emulator — App Check can't be attested locally
// (the emulator sets FUNCTIONS_EMULATOR=true), which would break the suites.
const ENFORCE_APP_CHECK = process.env.FUNCTIONS_EMULATOR !== "true" &&
    process.env.ENFORCE_APP_CHECK === "true";
exports.CALLABLE_OPTS = { enforceAppCheck: ENFORCE_APP_CHECK };
/* ── auth helpers ─────────────────────────────────────────────────── */
function requireAuth(req) {
    var _a;
    const uid = (_a = req.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!uid)
        throw new https_1.HttpsError("unauthenticated", "Sign-in required.");
    return uid;
}
function requireString(value, name) {
    if (typeof value !== "string" || value.length === 0) {
        throw new https_1.HttpsError("invalid-argument", `${name} required.`);
    }
    return value;
}
// Per-user fixed-window caps — generous for real use, tight enough to stop
// tight-loop abuse / cost amplification (esp. unbounded group creation and
// invite-code brute-forcing). Counters live in rateLimits/{uid}, which is
// Cloud-Function-only (denied to clients by firestore.rules).
const RATE_RULES = {
    createGroup: { max: 10, windowSec: 3600 },
    joinGroup: { max: 20, windowSec: 3600 },
    regenerateInviteCode: { max: 20, windowSec: 3600 },
    claimBounty: { max: 60, windowSec: 3600 },
    submitProof: { max: 60, windowSec: 3600 },
    approveBounty: { max: 120, windowSec: 3600 },
    rejectBounty: { max: 120, windowSec: 3600 },
    markIouPaid: { max: 120, windowSec: 3600 },
    // Stripe payment callables (stripe.ts).
    createConnectAccountAndOnboardingLink: { max: 20, windowSec: 3600 },
    getConnectAccountStatus: { max: 60, windowSec: 3600 },
    createIouPaymentIntent: { max: 60, windowSec: 3600 },
};
/**
 * Fixed-window per-user rate limit. Throws `resource-exhausted` once a user
 * exceeds the configured number of calls for `action` within its window.
 */
async function enforceRateLimit(uid, action) {
    const rule = RATE_RULES[action];
    if (!rule)
        return;
    const ref = exports.db.doc(`rateLimits/${uid}`);
    const nowMs = Date.now();
    const windowMs = rule.windowSec * 1000;
    await exports.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const all = (snap.exists ? snap.data() : {});
        const bucket = all[action];
        if (!bucket || nowMs - bucket.windowStart >= windowMs) {
            tx.set(ref, { [action]: { count: 1, windowStart: nowMs } }, { merge: true });
            return;
        }
        if (bucket.count >= rule.max) {
            throw new https_1.HttpsError("resource-exhausted", "Too many requests — please slow down and try again later.");
        }
        tx.set(ref, { [action]: { count: bucket.count + 1, windowStart: bucket.windowStart } }, { merge: true });
    });
}
/* ── feature flags ────────────────────────────────────────────────── */
/**
 * Server-side read of the runtime card-payments kill-switch, stored at
 * config/payments.stripePaymentsEnabled. Defaults OFF whenever the doc or the
 * field is missing, so the card path stays dark until it is explicitly turned
 * on. Read fresh on every call (never cached) so flipping the flag in Firestore
 * disables the Stripe callables immediately — no redeploy. The manual / cash
 * IOU flow never consults this and is therefore completely unaffected.
 */
async function isStripePaymentsEnabled() {
    var _a;
    try {
        const snap = await exports.db.doc("config/payments").get();
        return ((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.stripePaymentsEnabled) === true;
    }
    catch (e) {
        // Fail safe: if the flag can't be read, treat card payments as disabled.
        logger.warn("payments flag read failed; treating as disabled", { error: String(e) });
        return false;
    }
}
/**
 * Guard for the Stripe callables: throw a clean, user-facing error unless card
 * payments are enabled. The message steers the user to the always-available
 * cash path so a disabled flag is never a dead end.
 */
async function requireStripePaymentsEnabled() {
    if (!(await isStripePaymentsEnabled())) {
        throw new https_1.HttpsError("failed-precondition", "Card payments are currently unavailable. " +
            "You can still settle this IOU in cash.");
    }
}
/* ── notifications ────────────────────────────────────────────────── */
async function writeInbox(userId, payload) {
    try {
        await exports.db.collection(`notifications/${userId}/inbox`).add(Object.assign(Object.assign({}, payload), { createdAt: firestore_1.Timestamp.now(), read: false }));
    }
    catch (e) {
        logger.warn("inbox write failed", { userId, error: String(e) });
    }
}
/** Best-effort lookup of a member's cached display name within a group. */
async function memberName(groupId, uid) {
    var _a;
    try {
        const snap = await exports.db.doc(`groups/${groupId}/members/${uid}`).get();
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
        const snap = await exports.db.doc(`users/${uid}`).get();
        return ((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.displayName) || "Someone";
    }
    catch (_b) {
        return "Someone";
    }
}
//# sourceMappingURL=shared.js.map