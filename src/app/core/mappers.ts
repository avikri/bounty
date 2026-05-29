/**
 * Pure Firestore-document → app-model mappers and the small synchronous
 * helpers they rely on. Extracted from DataService so they can be unit-tested
 * without bootstrapping Angular or Firebase — nothing here touches the
 * `@angular/fire` runtime (the `Timestamp` import is types-only and erased at
 * compile time).
 */
import type { Timestamp } from '@angular/fire/firestore';
import {
  AppNotification,
  Bounty,
  BountyState,
  Group,
  IOU,
  Member,
  NotificationKind,
  User,
} from './models';

export const PLACEHOLDER_USER: User = {
  uid: '',
  displayName: 'Signed out',
  handle: 'anon',
  initials: '??',
  avatarVariant: 1,
  totalPoints: 0,
};

export function pickVariant(uid: string): 1 | 2 | 3 | 4 | 5 {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] ?? '';
  const b = parts[1]?.[0] ?? '';
  return (a + b).toUpperCase() || (parts[0]?.slice(0, 2) ?? '??').toUpperCase();
}

export function toDate(v: Timestamp | Date | { toDate(): Date } | undefined | null): Date {
  if (!v) return new Date();
  if (v instanceof Date) return v;
  if (typeof (v as { toDate?: () => Date }).toDate === 'function') return (v as { toDate(): Date }).toDate();
  return new Date(v as unknown as number);
}

export function hashCode(s: string): number {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/* ── Firestore doc shapes ──────────────────────────────────────────── */

export interface GroupDoc {
  name: string; emoji?: string; ownerId: string; inviteCode: string;
  memberCount?: number; defaultExpiryDays?: number;
}

export interface MemberDoc {
  role: 'owner' | 'admin' | 'member';
  points: number; wins: number; losses: number;
  displayName: string; photoURL?: string;
}

export interface BountyDoc {
  title: string; description: string; price: number;
  state: BountyState; posterId: string; claimantId?: string | null;
  proof?: { urls: string[]; note: string };
  expiresAt: Timestamp; createdAt: Timestamp; resolvedAt?: Timestamp;
  rejectionReason?: string;
}

export interface IouDoc {
  groupId: string; debtorId: string; creditorId: string;
  amount: number; bountyId: string;
  status: IOU['status']; createdAt: Timestamp;
  settledAt?: Timestamp;
}

export interface NotificationDoc {
  kind: NotificationKind;
  title?: string;
  body?: string;
  text?: string; // legacy field name
  groupId?: string;
  bountyId?: string;
  iouId?: string;
  actorId?: string;
  actorName?: string;
  amount?: number;
  read?: boolean;
  createdAt: Timestamp;
}

/* ── doc → model ───────────────────────────────────────────────────── */

export function mapGroup(id: string, d: GroupDoc, memberIds: string[]): Group {
  const tone = (['primary', 'info', 'success', 'purple', 'warn'] as const)[
    Math.abs(hashCode(id)) % 5
  ];
  return {
    id,
    name: d.name,
    emoji: d.emoji ?? '👥',
    ownerId: d.ownerId,
    inviteCode: d.inviteCode,
    memberIds,
    defaultExpiryDays: d.defaultExpiryDays ?? 7,
    unreadCount: 0,
    surfaceTone: tone,
  };
}

export function mapMember(uid: string, d: MemberDoc): Member {
  return {
    uid,
    displayName: d.displayName,
    handle: d.displayName.toLowerCase().replace(/\s+/g, ''),
    initials: initialsOf(d.displayName),
    avatarVariant: pickVariant(uid),
    totalPoints: d.points ?? 0,
    role: d.role,
    points: d.points ?? 0,
    wins: d.wins ?? 0,
    losses: d.losses ?? 0,
  };
}

export function mapBounty(id: string, groupId: string, d: BountyDoc): Bounty {
  return {
    id, groupId,
    title: d.title, description: d.description, price: d.price,
    state: d.state, posterId: d.posterId, claimantId: d.claimantId ?? null,
    proof: d.proof,
    expiresAt: toDate(d.expiresAt),
    createdAt: toDate(d.createdAt),
    resolvedAt: d.resolvedAt ? toDate(d.resolvedAt) : undefined,
    rejectionReason: d.rejectionReason,
  };
}

export function mapIou(id: string, d: IouDoc): IOU {
  const { createdAt, settledAt, ...rest } = d;
  return {
    id,
    ...rest,
    createdAt: toDate(createdAt),
    settledAt: settledAt ? toDate(settledAt) : undefined,
  };
}

export function mapNotification(id: string, d: NotificationDoc): AppNotification {
  return {
    id,
    kind: d.kind,
    title: d.title ?? 'Notification',
    body: d.body ?? d.text ?? '',
    groupId: d.groupId,
    bountyId: d.bountyId,
    iouId: d.iouId,
    actorId: d.actorId,
    actorName: d.actorName,
    amount: d.amount,
    read: d.read ?? false,
    createdAt: toDate(d.createdAt),
  };
}
