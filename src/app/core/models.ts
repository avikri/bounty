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
