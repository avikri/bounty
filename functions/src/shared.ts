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

import {setGlobalOptions} from "firebase-functions";
import {HttpsError, CallableRequest} from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import {Timestamp} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

admin.initializeApp();
setGlobalOptions({maxInstances: 10, region: "australia-southeast1"});

export const db = admin.firestore();

// App Check enforcement on the callables. OFF by default so the app works
// without a reCAPTCHA/App Check provider configured. To turn it on later:
//   1. Configure client App Check (initializeAppCheck with a real site key).
//   2. Set ENFORCE_APP_CHECK=true (e.g. in functions/.env) and redeploy.
// Never enforced under the emulator — App Check can't be attested locally
// (the emulator sets FUNCTIONS_EMULATOR=true), which would break the suites.
const ENFORCE_APP_CHECK =
  process.env.FUNCTIONS_EMULATOR !== "true" &&
  process.env.ENFORCE_APP_CHECK === "true";
export const CALLABLE_OPTS = {enforceAppCheck: ENFORCE_APP_CHECK};

/* ── auth helpers ─────────────────────────────────────────────────── */

export function requireAuth(req: CallableRequest<unknown>): string {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
  return uid;
}

export function requireString(value: unknown, name: string): string {
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
  // Stripe payment callables (stripe.ts).
  createConnectAccountAndOnboardingLink: {max: 20, windowSec: 3600},
  getConnectAccountStatus: {max: 60, windowSec: 3600},
  createIouPaymentIntent: {max: 60, windowSec: 3600},
};

/**
 * Fixed-window per-user rate limit. Throws `resource-exhausted` once a user
 * exceeds the configured number of calls for `action` within its window.
 */
export async function enforceRateLimit(
    uid: string,
    action: string,
): Promise<void> {
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

/* ── feature flags ────────────────────────────────────────────────── */

/**
 * Server-side read of the runtime card-payments kill-switch, stored at
 * config/payments.stripePaymentsEnabled. Defaults OFF whenever the doc or the
 * field is missing, so the card path stays dark until it is explicitly turned
 * on. Read fresh on every call (never cached) so flipping the flag in Firestore
 * disables the Stripe callables immediately — no redeploy. The manual / cash
 * IOU flow never consults this and is therefore completely unaffected.
 */
export async function isStripePaymentsEnabled(): Promise<boolean> {
  try {
    const snap = await db.doc("config/payments").get();
    return snap.data()?.stripePaymentsEnabled === true;
  } catch (e) {
    // Fail safe: if the flag can't be read, treat card payments as disabled.
    logger.warn("payments flag read failed; treating as disabled",
        {error: String(e)});
    return false;
  }
}

/**
 * Guard for the Stripe callables: throw a clean, user-facing error unless card
 * payments are enabled. The message steers the user to the always-available
 * cash path so a disabled flag is never a dead end.
 */
export async function requireStripePaymentsEnabled(): Promise<void> {
  if (!(await isStripePaymentsEnabled())) {
    throw new HttpsError(
        "failed-precondition",
        "Card payments are currently unavailable. " +
        "You can still settle this IOU in cash.",
    );
  }
}

/* ── notifications ────────────────────────────────────────────────── */

export async function writeInbox(
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
export async function memberName(
    groupId: string,
    uid: string,
): Promise<string> {
  try {
    const snap = await db.doc(`groups/${groupId}/members/${uid}`).get();
    return (snap.data()?.displayName as string | undefined) || "Someone";
  } catch {
    return "Someone";
  }
}

/** Best-effort lookup of a top-level user's display name. */
export async function userName(uid: string): Promise<string> {
  try {
    const snap = await db.doc(`users/${uid}`).get();
    return (snap.data()?.displayName as string | undefined) || "Someone";
  } catch {
    return "Someone";
  }
}
