"use strict";
/**
 * Stripe Connect (Express, New Zealand) payment plumbing.
 *
 * Real money moves from the debtor to the creditor of an IOU via a Stripe
 * **destination charge**: the debtor pays a PaymentIntent on the platform
 * account, and `transfer_data.destination` routes the funds to the creditor's
 * NZ Express connected account. There is no platform fee.
 *
 * Hard rules mirrored from the rest of the backend:
 *  - Clients never write /ious directly. Stripe-driven settlement happens
 *    *only* inside `stripeWebhook` (the source of truth), never from the client.
 *  - The webhook is signature-verified and idempotent (Stripe redelivers).
 *  - A confirmed card payment counts as BOTH parties' confirmation → settled,
 *    and is race-safe against the manual mark-paid flow (one wins via a
 *    transaction; the other is a no-op).
 *  - The Stripe secret key and webhook signing secret live in Secret Manager;
 *    clients only ever receive the publishable key and a per-PI client_secret.
 *
 * The manual / cash settlement path (markIouPaid in index.ts) is unchanged and
 * needs no Stripe account.
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripeWebhook = exports.createIouPaymentIntent = exports.getConnectAccountStatus = exports.createConnectAccountAndOnboardingLink = void 0;
const https_1 = require("firebase-functions/v2/https");
const params_1 = require("firebase-functions/params");
const firestore_1 = require("firebase-admin/firestore");
const logger = __importStar(require("firebase-functions/logger"));
const stripe_1 = __importDefault(require("stripe"));
const shared_1 = require("./shared");
/* ── config & secrets ─────────────────────────────────────────────── */
// Secret Manager values (never in the repo / client). Set for the emulator in
// functions/.secret.local, and for deploy via `firebase functions:secrets:set`.
const STRIPE_SECRET_KEY = (0, params_1.defineSecret)("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = (0, params_1.defineSecret)("STRIPE_WEBHOOK_SECRET");
// Base URL of the deployed web app, used to build the Stripe-hosted onboarding
// return/refresh links. Server-controlled (not client-supplied) so the redirect
// target can't be tampered with. Override per-env via the APP_BASE_URL param.
const APP_BASE_URL = (0, params_1.defineString)("APP_BASE_URL", {
    default: "https://bountification.web.app",
});
// Connected accounts are New Zealand; PaymentIntents are NZD.
const CONNECT_COUNTRY = "NZ";
const IOU_CURRENCY = "nzd";
// Points → NZD conversion: 1 point = NZ$1, and Stripe charges in the smallest
// currency unit (NZD cents), so 1 point = 100 cents.
const POINTS_TO_CENTS = 100;
/** Convert an IOU's integer point amount to NZD cents for Stripe. */
function iouAmountToCents(amount) {
    return Math.round(amount * POINTS_TO_CENTS);
}
// Pinned to the API version bundled with the installed stripe SDK.
const STRIPE_API_VERSION = "2026-05-27.dahlia";
let _stripe = null;
/**
 * Lazily construct the Stripe client. Only call this inside a handler that
 * declares STRIPE_SECRET_KEY in its `secrets`, since `.value()` is only
 * available at runtime.
 */
function stripe() {
    if (!_stripe) {
        _stripe = new stripe_1.default(STRIPE_SECRET_KEY.value(), {
            apiVersion: STRIPE_API_VERSION,
        });
    }
    return _stripe;
}
/* ── createConnectAccountAndOnboardingLink ────────────────────────── */
/**
 * Lazily create the caller's NZ Express connected account (only if absent) and
 * return a fresh Stripe-hosted onboarding Account Link. Called on demand when a
 * payout first becomes relevant — never at signup or IOU creation.
 */
exports.createConnectAccountAndOnboardingLink = (0, https_1.onCall)(Object.assign(Object.assign({}, shared_1.CALLABLE_OPTS), { secrets: [STRIPE_SECRET_KEY] }), async (req) => {
    const uid = (0, shared_1.requireAuth)(req);
    // Kill-switch: when card payments are off, no Connect onboarding either.
    await (0, shared_1.requireStripePaymentsEnabled)();
    await (0, shared_1.enforceRateLimit)(uid, "createConnectAccountAndOnboardingLink");
    const userRef = shared_1.db.doc(`users/${uid}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
        throw new https_1.HttpsError("failed-precondition", "User profile missing.");
    }
    const user = userSnap.data();
    let accountId = user.stripeConnectAccountId;
    if (!accountId) {
        const account = await stripe().accounts.create({
            type: "express",
            country: CONNECT_COUNTRY,
            capabilities: {
                card_payments: { requested: true },
                transfers: { requested: true },
            },
            metadata: { uid },
        });
        accountId = account.id;
        // Persist immediately so a retry can't orphan a second account. The
        // payable flag moves from null (never onboarded) → false (known not
        // yet payable); it becomes true via the account.updated webhook.
        await userRef.set({
            stripeConnectAccountId: accountId,
            stripeChargesEnabled: false,
            stripePayoutsEnabled: false,
            stripePayable: false,
        }, { merge: true });
    }
    const base = APP_BASE_URL.value().replace(/\/+$/, "");
    const link = await stripe().accountLinks.create({
        account: accountId,
        refresh_url: `${base}/profile?stripe=refresh`,
        return_url: `${base}/profile?stripe=return`,
        type: "account_onboarding",
    });
    return { url: link.url, accountId };
});
/* ── getConnectAccountStatus ──────────────────────────────────────── */
/**
 * Report whether the caller's connected account can receive funds, refreshing
 * the cached flags on their user doc. "payable" = charges + payouts enabled.
 */
exports.getConnectAccountStatus = (0, https_1.onCall)(Object.assign(Object.assign({}, shared_1.CALLABLE_OPTS), { secrets: [STRIPE_SECRET_KEY] }), async (req) => {
    var _a;
    const uid = (0, shared_1.requireAuth)(req);
    await (0, shared_1.requireStripePaymentsEnabled)();
    await (0, shared_1.enforceRateLimit)(uid, "getConnectAccountStatus");
    const userRef = shared_1.db.doc(`users/${uid}`);
    const userSnap = await userRef.get();
    const accountId = (_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.stripeConnectAccountId;
    if (!accountId) {
        return {
            onboarded: false,
            chargesEnabled: false,
            payoutsEnabled: false,
            payable: false,
        };
    }
    const account = await stripe().accounts.retrieve(accountId);
    const chargesEnabled = account.charges_enabled === true;
    const payoutsEnabled = account.payouts_enabled === true;
    const payable = chargesEnabled && payoutsEnabled;
    await userRef.set({
        stripeChargesEnabled: chargesEnabled,
        stripePayoutsEnabled: payoutsEnabled,
        stripePayable: payable,
    }, { merge: true });
    return {
        onboarded: account.details_submitted === true,
        chargesEnabled,
        payoutsEnabled,
        payable,
    };
});
/* ── createIouPaymentIntent ───────────────────────────────────────── */
/**
 * Build a destination-charge PaymentIntent so the debtor can pay the creditor
 * an IOU by card. Validates the caller is the debtor and the IOU is unsettled.
 * If the creditor isn't payable yet, returns the distinct
 * `{status: "creditor_not_onboarded"}` result (not an error) and notifies the
 * creditor to set up payouts — the frontend uses this to prompt onboarding.
 */
exports.createIouPaymentIntent = (0, https_1.onCall)(Object.assign(Object.assign({}, shared_1.CALLABLE_OPTS), { secrets: [STRIPE_SECRET_KEY] }), async (req) => {
    var _a;
    const uid = (0, shared_1.requireAuth)(req);
    // Kill-switch: reject card settlement early; the cash path is unaffected.
    await (0, shared_1.requireStripePaymentsEnabled)();
    await (0, shared_1.enforceRateLimit)(uid, "createIouPaymentIntent");
    const data = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    const iouId = (0, shared_1.requireString)(data.iouId, "iouId");
    const iouRef = shared_1.db.doc(`ious/${iouId}`);
    const iouSnap = await iouRef.get();
    if (!iouSnap.exists) {
        throw new https_1.HttpsError("not-found", "IOU not found.");
    }
    const iou = iouSnap.data();
    if (iou.debtorId !== uid) {
        throw new https_1.HttpsError("permission-denied", "Only the debtor can pay this IOU.");
    }
    if (iou.status === "settled") {
        throw new https_1.HttpsError("failed-precondition", "IOU already settled.");
    }
    // Can the creditor actually receive funds?
    const creditorSnap = await shared_1.db.doc(`users/${iou.creditorId}`).get();
    const creditor = creditorSnap.data();
    const accountId = creditor === null || creditor === void 0 ? void 0 : creditor.stripeConnectAccountId;
    const payable = (creditor === null || creditor === void 0 ? void 0 : creditor.stripePayable) === true;
    if (!accountId || !payable) {
        // Distinct, non-error result so the client can run its notify-and-prompt
        // flow. Record that a debtor is waiting so the account.updated webhook
        // can ping them once the creditor finishes onboarding.
        await iouRef.set({ awaitingCreditorOnboarding: true, creditorPayable: false }, { merge: true });
        const actorName = await (0, shared_1.userName)(uid);
        await (0, shared_1.writeInbox)(iou.creditorId, {
            kind: "iou_payment_request",
            iouId,
            actorId: uid,
            actorName,
            amount: iou.amount,
            title: "Someone wants to pay you by card",
            body: `${actorName} wants to settle an IOU by card. ` +
                "Set up payouts to receive it.",
        });
        return { status: "creditor_not_onboarded" };
    }
    // Destination charge: platform collects, funds routed to the creditor's
    // connected account. No application_fee_amount (no platform fee). The
    // idempotency key keeps retries for the same IOU from creating duplicate
    // PaymentIntents. on_behalf_of makes the creditor the settlement merchant.
    const pi = await stripe().paymentIntents.create({
        amount: iouAmountToCents(iou.amount),
        currency: IOU_CURRENCY,
        on_behalf_of: accountId,
        transfer_data: { destination: accountId },
        metadata: {
            iouId,
            debtorId: iou.debtorId,
            creditorId: iou.creditorId,
        },
    }, { idempotencyKey: `pi_create_${iouId}` });
    await iouRef.set({
        paymentMethod: "stripe",
        stripePaymentIntentId: pi.id,
        stripeStatus: pi.status,
        creditorPayable: true,
        awaitingCreditorOnboarding: false,
    }, { merge: true });
    return {
        status: "ok",
        clientSecret: pi.client_secret,
        paymentIntentId: pi.id,
    };
});
/* ── stripeWebhook (HTTP — the source of truth) ───────────────────── */
/**
 * Signature-verified Stripe webhook. IOU settlement from a card payment happens
 * here and nowhere else. Idempotent: each event id is processed at most once,
 * recorded atomically with the state change it drives so a handler failure
 * (which returns 500) lets Stripe safely redeliver.
 *
 * Deliberately NOT gated by the stripePaymentsEnabled kill-switch: flipping the
 * flag off stops *new* card payments (the callables reject) but the webhook must
 * keep settling any already-authorized PaymentIntent and processing
 * account.updated, so money in flight is never stranded.
 */
exports.stripeWebhook = (0, https_1.onRequest)({ secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] }, async (req, res) => {
    const sig = req.headers["stripe-signature"];
    if (typeof sig !== "string") {
        res.status(400).send("Missing stripe-signature header");
        return;
    }
    let event;
    try {
        event = stripe().webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET.value());
    }
    catch (e) {
        // Includes the case where a third party sends a forged event.
        logger.warn("stripe webhook signature verification failed", { error: String(e) });
        res.status(400).send("Webhook signature verification failed");
        return;
    }
    try {
        let afterCommit = async () => { };
        if (event.type === "payment_intent.succeeded") {
            afterCommit = await settleFromPaymentIntent(event.id, event.data.object);
        }
        else if (event.type === "account.updated") {
            afterCommit = await applyAccountUpdate(event.id, event.data.object);
        }
        else if (event.type === "charge.refunded") {
            const charge = event.data.object;
            afterCommit = await recordChargeIssue(event.id, "refund", charge.payment_intent, { amount: charge.amount_refunded });
        }
        else if (event.type === "charge.dispute.created") {
            const dispute = event.data.object;
            afterCommit = await recordChargeIssue(event.id, "dispute", dispute.payment_intent, { amount: dispute.amount, reason: dispute.reason });
        }
        // Side effects (notifications) run only after the transaction committed.
        await afterCommit();
        res.status(200).send("ok");
    }
    catch (e) {
        // 5xx asks Stripe to redeliver; the event id wasn't persisted because
        // the transaction rolled back, so reprocessing is safe.
        logger.error("stripe webhook handler failed", { type: event.type, error: String(e) });
        res.status(500).send("handler error");
    }
});
/**
 * Settle the IOU referenced by a succeeded PaymentIntent, exactly once.
 * Returns a post-commit runner that fires the settlement notifications.
 */
async function settleFromPaymentIntent(eventId, pi) {
    var _a;
    const iouId = (_a = pi.metadata) === null || _a === void 0 ? void 0 : _a.iouId;
    if (!iouId) {
        logger.warn("payment_intent.succeeded without iouId metadata", { paymentIntent: pi.id });
        return async () => { };
    }
    const iouRef = shared_1.db.doc(`ious/${iouId}`);
    const eventRef = shared_1.db.doc(`stripeEvents/${eventId}`);
    const result = await shared_1.db.runTransaction(async (tx) => {
        const eventSnap = await tx.get(eventRef);
        if (eventSnap.exists)
            return { settled: false };
        const iouSnap = await tx.get(iouRef);
        tx.set(eventRef, {
            type: "payment_intent.succeeded",
            iouId,
            receivedAt: firestore_1.Timestamp.now(),
        });
        if (!iouSnap.exists) {
            logger.warn("payment_intent.succeeded for missing IOU", { iouId });
            return { settled: false };
        }
        const iou = iouSnap.data();
        // Guard double-settle: a manual settle may have already won the race, or
        // Stripe may be redelivering. Record the PI but don't re-settle.
        if (iou.status === "settled") {
            tx.set(iouRef, {
                paymentMethod: "stripe",
                stripePaymentIntentId: pi.id,
                stripeStatus: "succeeded",
            }, { merge: true });
            return { settled: false };
        }
        tx.update(iouRef, {
            status: "settled",
            settledAt: firestore_1.Timestamp.now(),
            paymentMethod: "stripe",
            stripePaymentIntentId: pi.id,
            stripeStatus: "succeeded",
            awaitingCreditorOnboarding: false,
        });
        return {
            settled: true,
            debtorId: iou.debtorId,
            creditorId: iou.creditorId,
            amount: iou.amount,
        };
    });
    if (!result.settled)
        return async () => { };
    return async () => {
        await Promise.all([
            // Existing "settled" notification to both parties (unchanged UX).
            (0, shared_1.writeInbox)(result.debtorId, {
                kind: "iou_settled",
                iouId,
                title: "IOU settled",
                body: "Your card payment went through — this IOU is now settled.",
            }),
            (0, shared_1.writeInbox)(result.creditorId, {
                kind: "iou_settled",
                iouId,
                title: "IOU settled",
                body: "An IOU between you two is now settled.",
            }),
            // Money-specific notice to the creditor.
            (0, shared_1.writeInbox)(result.creditorId, {
                kind: "iou_payment_received",
                iouId,
                amount: result.amount,
                title: "Payment received",
                body: "You were paid by card. The IOU is settled.",
            }),
        ]);
    };
}
/**
 * Track a connected account's payable status from account.updated, and — when a
 * creditor first becomes payable — notify any debtor who was waiting to pay.
 * Returns a post-commit runner that performs those notifications.
 */
async function applyAccountUpdate(eventId, account) {
    const accountId = account.id;
    const chargesEnabled = account.charges_enabled === true;
    const payoutsEnabled = account.payouts_enabled === true;
    const payable = chargesEnabled && payoutsEnabled;
    // Find the user who owns this connected account.
    const ownerQuery = await shared_1.db.collection("users")
        .where("stripeConnectAccountId", "==", accountId)
        .limit(1)
        .get();
    if (ownerQuery.empty) {
        logger.warn("account.updated for unknown connected account", { accountId });
        return async () => { };
    }
    const userRef = ownerQuery.docs[0].ref;
    const userId = ownerQuery.docs[0].id;
    const eventRef = shared_1.db.doc(`stripeEvents/${eventId}`);
    const becamePayable = await shared_1.db.runTransaction(async (tx) => {
        var _a;
        const eventSnap = await tx.get(eventRef);
        if (eventSnap.exists)
            return false;
        const userSnap = await tx.get(userRef);
        const wasPayable = ((_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.stripePayable) === true;
        tx.set(eventRef, {
            type: "account.updated",
            accountId,
            receivedAt: firestore_1.Timestamp.now(),
        });
        tx.set(userRef, {
            stripeChargesEnabled: chargesEnabled,
            stripePayoutsEnabled: payoutsEnabled,
            stripePayable: payable,
        }, { merge: true });
        return payable && !wasPayable;
    });
    if (!becamePayable)
        return async () => { };
    return async () => {
        // Debtors who tried to pay this creditor before they were onboarded.
        const waiting = await shared_1.db.collection("ious")
            .where("creditorId", "==", userId)
            .where("awaitingCreditorOnboarding", "==", true)
            .get();
        await Promise.all(waiting.docs.map(async (docSnap) => {
            const iou = docSnap.data();
            if (iou.status === "settled")
                return;
            await docSnap.ref.set({ creditorPayable: true, awaitingCreditorOnboarding: false }, { merge: true });
            await (0, shared_1.writeInbox)(iou.debtorId, {
                kind: "iou_creditor_ready",
                iouId: docSnap.id,
                actorId: userId,
                actorName: await (0, shared_1.userName)(userId),
                amount: iou.amount,
                title: "Ready for card payment",
                body: "They set up card payments — you can now settle the IOU by card.",
            });
        }));
    };
}
/**
 * Record a refund (charge.refunded) or chargeback (charge.dispute.created) on a
 * card-settled IOU and notify both parties. Product decision: this does NOT
 * reopen the IOU — its status is deliberately left untouched (settled stays
 * settled); the event is logged, both parties are pinged, and reconciliation is
 * handled out of band. The IOU is located via its stored stripePaymentIntentId.
 * Idempotent on the Stripe event id, like the other handlers, so redelivery is a
 * no-op. Returns a post-commit runner that sends the notifications.
 */
async function recordChargeIssue(eventId, kind, paymentIntentId, detail) {
    if (!paymentIntentId) {
        logger.warn(`charge.${kind} without payment_intent`, { eventId });
        return async () => { };
    }
    const iouQuery = await shared_1.db.collection("ious")
        .where("stripePaymentIntentId", "==", paymentIntentId)
        .limit(1)
        .get();
    if (iouQuery.empty) {
        logger.warn(`charge.${kind} for unknown payment_intent`, { paymentIntentId });
        return async () => { };
    }
    const iouRef = iouQuery.docs[0].ref;
    const iou = iouQuery.docs[0].data();
    const eventRef = shared_1.db.doc(`stripeEvents/${eventId}`);
    const firstTime = await shared_1.db.runTransaction(async (tx) => {
        const eventSnap = await tx.get(eventRef);
        if (eventSnap.exists)
            return false;
        tx.set(eventRef, {
            type: `charge.${kind}`,
            paymentIntentId,
            iouId: iouRef.id,
            receivedAt: firestore_1.Timestamp.now(),
        });
        // Audit marker only — status is intentionally NOT changed.
        tx.set(iouRef, kind === "refund" ?
            { stripeRefunded: true } :
            { stripeDisputed: true }, { merge: true });
        return true;
    });
    if (!firstTime)
        return async () => { };
    // Surface prominently in logs for manual reconciliation / follow-up.
    logger.warn(`stripe charge.${kind} on IOU`, Object.assign({ iouId: iouRef.id, paymentIntentId }, detail));
    return async () => {
        const isRefund = kind === "refund";
        const title = isRefund ? "Card payment refunded" : "Card payment disputed";
        const body = isRefund ?
            "A card payment on a settled IOU was refunded. The IOU is unchanged — " +
                "settle up between yourselves." :
            "A card payment on a settled IOU was disputed with the bank. The IOU is " +
                "unchanged — settle up between yourselves.";
        const notifKind = isRefund ? "iou_payment_refunded" : "iou_payment_disputed";
        await Promise.all([
            (0, shared_1.writeInbox)(iou.debtorId, {
                kind: notifKind, iouId: iouRef.id, amount: iou.amount, title, body,
            }),
            (0, shared_1.writeInbox)(iou.creditorId, {
                kind: notifKind, iouId: iouRef.id, amount: iou.amount, title, body,
            }),
        ]);
    };
}
//# sourceMappingURL=stripe.js.map