export type BountyState =
  | 'available'
  | 'claimed'
  | 'pending_review'
  | 'successful'
  | 'failed'
  | 'expired';

export interface User {
  uid: string;
  displayName: string;
  handle: string;
  initials: string;
  avatarVariant: 1 | 2 | 3 | 4 | 5;
  totalPoints: number;
  /**
   * Stripe Connect (Express) fields, written exclusively by Cloud Functions and
   * readable only by the user themselves. Absent until a payout first becomes
   * relevant (lazy onboarding) — `stripePayable` is `null` until onboarding has
   * started, then `false`/`true` as the account becomes able to receive funds.
   */
  stripeConnectAccountId?: string;
  stripeChargesEnabled?: boolean;
  stripePayoutsEnabled?: boolean;
  stripePayable?: boolean | null;
}

export interface Member extends User {
  role: 'owner' | 'admin' | 'member';
  points: number;
  wins: number;
  losses: number;
}

export interface Group {
  id: string;
  name: string;
  emoji: string;
  ownerId: string;
  inviteCode: string;
  memberIds: string[];
  defaultExpiryDays: number;
  unreadCount: number;
  surfaceTone: 'primary' | 'info' | 'success' | 'purple' | 'warn';
}

export interface Bounty {
  id: string;
  groupId: string;
  title: string;
  description: string;
  price: number;
  /** ISO 4217 currency the price is denominated in (NZD for new bounties). */
  currency?: string;
  state: BountyState;
  posterId: string;
  claimantId: string | null;
  proof?: { urls: string[]; note: string };
  expiresAt: Date;
  createdAt: Date;
  resolvedAt?: Date;
  rejectionReason?: string;
}

export interface ActivityEvent {
  id: string;
  bountyId: string;
  kind: 'created' | 'claimed' | 'submitted' | 'approved' | 'rejected' | 'expired';
  actorId: string;
  at: Date;
  note?: string | null;
}

export interface IOU {
  id: string;
  groupId: string;
  debtorId: string;
  creditorId: string;
  amount: number;
  bountyId: string;
  status: 'open' | 'debtor_marked' | 'creditor_marked' | 'settled';
  createdAt: Date;
  settledAt?: Date;
  /** ISO 4217 currency for a real-money settlement (NZD). */
  currency?: string;
  /** How the IOU was/will be settled. Absent until a method is chosen. */
  paymentMethod?: 'manual' | 'stripe';
  /** Set once a card PaymentIntent has been created for this IOU. */
  stripePaymentIntentId?: string;
  /** Mirror of the PaymentIntent's last-known status. */
  stripeStatus?: string;
  /**
   * Denormalized so the debtor can decide whether to offer card payment without
   * reading the creditor's user doc. Written by Cloud Functions.
   */
  creditorPayable?: boolean;
  /**
   * True while a debtor is waiting for the creditor to finish onboarding before
   * they can pay by card; cleared (and the debtor notified) once payable.
   */
  awaitingCreditorOnboarding?: boolean;
}

export interface LeaderboardEntry {
  userId: string;
  rank: number;
  user: User;
  points: number;
  wins: number;
  losses: number;
  netIou: number;
}

/**
 * Result of the createIouPaymentIntent callable. A discriminated union: `ok`
 * carries the per-payment client secret to confirm with Stripe.js;
 * `creditor_not_onboarded` means the creditor can't receive funds yet (the
 * backend has flagged the IOU and notified them to set up payouts).
 */
export type CreateIouPaymentIntentResult =
  | { status: 'ok'; clientSecret: string; paymentIntentId: string }
  | { status: 'creditor_not_onboarded' };

/** Result of the getConnectAccountStatus callable. */
export interface ConnectAccountStatus {
  onboarded: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  payable: boolean;
}

export type NotificationKind =
  | 'bounty_claimed'
  | 'proof_submitted'
  | 'bounty_approved'
  | 'bounty_rejected'
  | 'bounty_resolved'
  | 'iou_marked'
  | 'iou_settled'
  // A debtor wants to pay the creditor by card — prompt them to set up payouts.
  | 'iou_payment_request'
  // The creditor finished onboarding — the waiting debtor can now pay by card.
  | 'iou_creditor_ready'
  // A card payment landed for the creditor (settles the IOU).
  | 'iou_payment_received'
  // A card payment on a settled IOU was later refunded (IOU left unchanged).
  | 'iou_payment_refunded'
  // A card payment on a settled IOU was disputed/charged back (IOU unchanged).
  | 'iou_payment_disputed';

/** Per-user inbox doc at notifications/{uid}/inbox/{id}. Written by Cloud Functions. */
export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  groupId?: string;
  bountyId?: string;
  iouId?: string;
  actorId?: string;
  actorName?: string;
  amount?: number;
  read: boolean;
  createdAt: Date;
}
