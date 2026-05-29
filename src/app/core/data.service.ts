import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  Firestore,
  Timestamp,
  addDoc,
  collection,
  collectionData,
  doc,
  docData,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Unsubscribe,
  updateDoc,
  where,
  writeBatch,
} from '@angular/fire/firestore';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { Storage, ref, uploadBytesResumable, getDownloadURL } from '@angular/fire/storage';
import { Observable, combineLatest, of, switchMap } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  ActivityEvent,
  AppNotification,
  Bounty,
  BountyState,
  Group,
  IOU,
  LeaderboardEntry,
  Member,
  NotificationKind,
  User,
} from './models';
import { AuthService } from './auth.service';
import { ToastService } from '../shared/toast.service';

const PLACEHOLDER_USER: User = {
  uid: '',
  displayName: 'Signed out',
  handle: 'anon',
  initials: '??',
  avatarVariant: 1,
  totalPoints: 0,
};

function pickVariant(uid: string): 1 | 2 | 3 | 4 | 5 {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] ?? '';
  const b = parts[1]?.[0] ?? '';
  return (a + b).toUpperCase() || (parts[0]?.slice(0, 2) ?? '??').toUpperCase();
}

function toDate(v: Timestamp | Date | { toDate(): Date } | undefined | null): Date {
  if (!v) return new Date();
  if (v instanceof Date) return v;
  if (typeof (v as { toDate?: () => Date }).toDate === 'function') return (v as { toDate(): Date }).toDate();
  return new Date(v as unknown as number);
}

/* ── Firestore doc → app model mappers ─────────────────────────────── */

interface GroupDoc {
  name: string; emoji?: string; ownerId: string; inviteCode: string;
  memberCount?: number; defaultExpiryDays?: number;
}

function mapGroup(id: string, d: GroupDoc, memberIds: string[]): Group {
  const tone = (['primary','info','success','purple','warn'] as const)[
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

function hashCode(s: string): number {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

interface MemberDoc {
  role: 'owner' | 'admin' | 'member';
  points: number; wins: number; losses: number;
  displayName: string; photoURL?: string;
}

function mapMember(uid: string, d: MemberDoc): Member {
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

interface BountyDoc {
  title: string; description: string; price: number;
  state: BountyState; posterId: string; claimantId?: string | null;
  proof?: { urls: string[]; note: string };
  expiresAt: Timestamp; createdAt: Timestamp; resolvedAt?: Timestamp;
  rejectionReason?: string;
}

function mapBounty(id: string, groupId: string, d: BountyDoc): Bounty {
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

interface IouDoc {
  groupId: string; debtorId: string; creditorId: string;
  amount: number; bountyId: string;
  status: IOU['status']; createdAt: Timestamp;
  settledAt?: Timestamp;
}

function mapIou(id: string, d: IouDoc): IOU {
  const { createdAt, settledAt, ...rest } = d;
  return {
    id,
    ...rest,
    createdAt: toDate(createdAt),
    settledAt: settledAt ? toDate(settledAt) : undefined,
  };
}

interface NotificationDoc {
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

function mapNotification(id: string, d: NotificationDoc): AppNotification {
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

/* ── DataService ───────────────────────────────────────────────────── */

@Injectable({ providedIn: 'root' })
export class DataService {
  private readonly auth = inject(AuthService);
  private readonly firestore = inject(Firestore);
  private readonly functions = inject(Functions);
  private readonly storage = inject(Storage);
  private readonly toast = inject(ToastService);

  /* Backing signals — same public surface as the in-memory version. */
  private readonly _users    = signal<User[]>([]);
  private readonly _groups   = signal<Group[]>([]);
  private readonly _bounties = signal<Bounty[]>([]);
  private readonly _ious     = signal<IOU[]>([]);
  private readonly _notifications = signal<AppNotification[]>([]);

  readonly users    = this._users.asReadonly();
  readonly groups   = this._groups.asReadonly();
  readonly bounties = this._bounties.asReadonly();
  readonly ious     = this._ious.asReadonly();
  readonly notifications = this._notifications.asReadonly();
  readonly unreadCount = computed(() => this._notifications().filter((n) => !n.read).length);

  get currentUserId(): string {
    return this.auth.fbUser()?.uid ?? '';
  }

  readonly me = computed<User>(() => {
    const uid = this.currentUserId;
    return this._users().find((u) => u.uid === uid) ?? this.auth.user() ?? PLACEHOLDER_USER;
  });

  /* Subscription bookkeeping — one set of listeners per signed-in session. */
  private rootSub: Unsubscribe | null = null;
  private groupSubs = new Map<string, Unsubscribe[]>();
  private membersByGroup = new Map<string, Member[]>();
  private bountiesByGroup = new Map<string, Bounty[]>();

  constructor() {
    effect(() => {
      const uid = this.auth.fbUser()?.uid;
      this.teardown();
      if (uid) this.bootstrap(uid);
    }, { allowSignalWrites: true });
  }

  private bootstrap(uid: string): void {
    // Listen to my user doc to discover groupIds.
    const meRef = doc(this.firestore, 'users', uid);
    this.rootSub = onSnapshot(
      meRef,
      (snap) => {
        const data = (snap.data() as { groupIds?: string[] } | undefined) ?? {};
        const groupIds = data.groupIds ?? [];
        this.reconcileGroupListeners(groupIds);
      },
      (err) => this.reportListenerError('user profile', err),
    );

    // Listen to IOUs where I'm involved (two queries, merged).
    const iousAsDebtor = query(
      collection(this.firestore, 'ious'),
      where('debtorId', '==', uid),
    );
    const iousAsCreditor = query(
      collection(this.firestore, 'ious'),
      where('creditorId', '==', uid),
    );
    let asDebtor: IOU[] = [];
    let asCreditor: IOU[] = [];
    const merge = () => {
      const map = new Map<string, IOU>();
      for (const i of [...asDebtor, ...asCreditor]) map.set(i.id, i);
      this._ious.set([...map.values()]);
    };
    const sub1 = onSnapshot(iousAsDebtor,
      (snap) => { asDebtor = snap.docs.map((d) => mapIou(d.id, d.data() as IouDoc)); merge(); },
      (err) => this.reportListenerError('IOUs', err),
    );
    const sub2 = onSnapshot(iousAsCreditor,
      (snap) => { asCreditor = snap.docs.map((d) => mapIou(d.id, d.data() as IouDoc)); merge(); },
      (err) => this.reportListenerError('IOUs', err),
    );
    this.groupSubs.set('__ious__', [sub1, sub2]);

    // Listen to my notification inbox, most recent first.
    const inboxQuery = query(
      collection(this.firestore, 'notifications', uid, 'inbox'),
      orderBy('createdAt', 'desc'),
      limit(100),
    );
    const inboxSub = onSnapshot(inboxQuery,
      (snap) => this._notifications.set(
        snap.docs.map((d) => mapNotification(d.id, d.data() as NotificationDoc)),
      ),
      (err) => this.reportListenerError('notifications', err),
    );
    this.groupSubs.set('__notifs__', [inboxSub]);
  }

  private reportListenerError(scope: string, err: unknown): void {
    const code = (err as { code?: string }).code;
    if (code === 'permission-denied') {
      this.toast.error(`You don't have access to ${scope}.`);
    } else {
      console.error(`[firestore] ${scope} listener error`, err);
    }
  }

  private teardown(): void {
    this.rootSub?.();
    this.rootSub = null;
    for (const subs of this.groupSubs.values()) for (const u of subs) u();
    this.groupSubs.clear();
    this.membersByGroup.clear();
    this.bountiesByGroup.clear();
    this._users.set([]);
    this._groups.set([]);
    this._bounties.set([]);
    this._ious.set([]);
    this._notifications.set([]);
  }

  private reconcileGroupListeners(desiredIds: string[]): void {
    // Detach removed groups.
    for (const id of [...this.groupSubs.keys()]) {
      if (id === '__ious__' || id === '__notifs__') continue;
      if (!desiredIds.includes(id)) {
        for (const u of this.groupSubs.get(id) ?? []) u();
        this.groupSubs.delete(id);
        this.membersByGroup.delete(id);
        this.bountiesByGroup.delete(id);
      }
    }
    // Attach new groups.
    for (const gid of desiredIds) {
      if (this.groupSubs.has(gid)) continue;
      this.attachGroupListeners(gid);
    }
    this.rebuildGroupsSignal();
  }

  private attachGroupListeners(gid: string): void {
    const subs: Unsubscribe[] = [];
    const groupRef = doc(this.firestore, 'groups', gid);
    let groupDoc: GroupDoc | null = null;

    subs.push(onSnapshot(groupRef,
      (snap) => {
        groupDoc = (snap.data() as GroupDoc | undefined) ?? null;
        this.rebuildGroupsSignal(gid, groupDoc);
      },
      (err) => this.reportListenerError('group', err),
    ));

    const membersRef = collection(this.firestore, 'groups', gid, 'members');
    subs.push(onSnapshot(membersRef,
      (snap) => {
        const members = snap.docs.map((d) => mapMember(d.id, d.data() as MemberDoc));
        this.membersByGroup.set(gid, members);
        this.mergeUsers();
        this.rebuildGroupsSignal(gid, groupDoc);
      },
      (err) => this.reportListenerError('members', err),
    ));

    const bountiesRef = query(
      collection(this.firestore, 'groups', gid, 'bounties'),
      orderBy('createdAt', 'desc'),
    );
    subs.push(onSnapshot(bountiesRef,
      (snap) => {
        const list = snap.docs.map((d) => mapBounty(d.id, gid, d.data() as BountyDoc));
        this.bountiesByGroup.set(gid, list);
        this.rebuildBountiesSignal();
      },
      (err) => this.reportListenerError('bounties', err),
    ));

    this.groupSubs.set(gid, subs);
  }

  private rebuildGroupsSignal(updatedGid?: string, updatedDoc?: GroupDoc | null): void {
    const ids = [...this.groupSubs.keys()].filter((k) => k !== '__ious__' && k !== '__notifs__');
    const groups: Group[] = [];
    for (const id of ids) {
      // If this is the just-updated group, prefer its fresh doc; otherwise reuse the cached one.
      const cached = this._groups().find((g) => g.id === id);
      const doc = id === updatedGid ? updatedDoc : undefined;
      const memberIds = (this.membersByGroup.get(id) ?? []).map((m) => m.uid);
      if (doc) {
        groups.push(mapGroup(id, doc, memberIds));
      } else if (cached) {
        groups.push({ ...cached, memberIds });
      }
    }
    this._groups.set(groups);
  }

  private rebuildBountiesSignal(): void {
    const all: Bounty[] = [];
    for (const list of this.bountiesByGroup.values()) all.push(...list);
    all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    this._bounties.set(all);
  }

  private mergeUsers(): void {
    const map = new Map<string, User>();
    for (const ms of this.membersByGroup.values()) {
      for (const m of ms) map.set(m.uid, m as User);
    }
    const self = this.auth.user();
    if (self) map.set(self.uid, self);
    this._users.set([...map.values()]);
  }

  /* ── Synchronous lookups used by templates ───────────────────────── */

  userById(uid: string): User | undefined {
    return this._users().find((u) => u.uid === uid);
  }

  groupById(id: string): Group | undefined {
    return this._groups().find((g) => g.id === id);
  }

  bountyById(id: string): Bounty | undefined {
    return this._bounties().find((b) => b.id === id);
  }

  bountiesInGroup(groupId: string, state?: BountyState | 'mine'): Bounty[] {
    let list = this._bounties().filter((b) => b.groupId === groupId);
    if (state === 'mine') {
      list = list.filter((b) => b.posterId === this.currentUserId || b.claimantId === this.currentUserId);
    } else if (state) {
      list = list.filter((b) => b.state === state);
    }
    return list;
  }

  pendingReviewsForMe(): Bounty[] {
    return this._bounties()
      .filter((b) => b.posterId === this.currentUserId && b.state === 'pending_review');
  }

  leaderboard(groupId: string): LeaderboardEntry[] {
    const members = this.membersByGroup.get(groupId) ?? [];
    const ious = this._ious().filter((i) => i.groupId === groupId);
    const entries = members.map((m) => {
      const netIou = ious.reduce((s, i) =>
        s + (i.creditorId === m.uid ? i.amount : i.debtorId === m.uid ? -i.amount : 0), 0);
      return {
        userId: m.uid,
        rank: 0,
        user: m as User,
        points: m.points,
        wins: m.wins,
        losses: m.losses,
        netIou,
      } as LeaderboardEntry;
    });
    entries.sort((a, b) => b.points - a.points);
    entries.forEach((e, i) => (e.rank = i + 1));
    return entries;
  }

  myIousList(): IOU[] {
    return this._ious()
      .filter((i) => i.debtorId === this.currentUserId || i.creditorId === this.currentUserId)
      .sort((a, b) => (b.createdAt.getTime() ?? 0) - (a.createdAt.getTime() ?? 0));
  }

  myIous(): { counterparty: User; net: number; count: number }[] {
    const groups = new Map<string, { net: number; count: number }>();
    for (const i of this._ious()) {
      const isCreditor = i.creditorId === this.currentUserId;
      const isDebtor   = i.debtorId === this.currentUserId;
      if (!isCreditor && !isDebtor) continue;
      const otherUid = isCreditor ? i.debtorId : i.creditorId;
      const sign = isCreditor ? 1 : -1;
      const entry = groups.get(otherUid) ?? { net: 0, count: 0 };
      entry.net += sign * i.amount;
      entry.count += 1;
      groups.set(otherUid, entry);
    }
    return [...groups.entries()]
      .map(([uid, v]) => ({ counterparty: this.userById(uid)!, ...v }))
      .filter((row) => row.counterparty);
  }

  myRecentResolutions(limit = 5): Bounty[] {
    return this._bounties()
      .filter((b) => b.claimantId === this.currentUserId && (b.state === 'successful' || b.state === 'failed'))
      .sort((a, b) => (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  /* ── New Observable-returning queries (per the request) ──────────── */

  getMyGroups(): Observable<Group[]> {
    return this.auth.currentUser$.pipe(
      switchMap((u) => {
        if (!u) return of<Group[]>([]);
        const userDocRef = doc(this.firestore, 'users', u.uid);
        return (docData(userDocRef) as Observable<{ groupIds?: string[] }>).pipe(
          switchMap((meDoc) => {
            const ids = meDoc?.groupIds ?? [];
            if (ids.length === 0) return of<Group[]>([]);
            const streams = ids.map((gid) => {
              const ref = doc(this.firestore, 'groups', gid);
              return (docData(ref) as Observable<GroupDoc>).pipe(
                map((d) => (d ? mapGroup(gid, d, []) : null)),
              );
            });
            return combineLatest(streams).pipe(map((arr) => arr.filter((g): g is Group => g !== null)));
          }),
        );
      }),
    );
  }

  getGroupBounties(groupId: string, state?: BountyState): Observable<Bounty[]> {
    const ref = collection(this.firestore, 'groups', groupId, 'bounties');
    const q = state
      ? query(ref, where('state', '==', state), orderBy('createdAt', 'desc'))
      : query(ref, orderBy('createdAt', 'desc'));
    return (collectionData(q, { idField: 'id' }) as Observable<Array<BountyDoc & { id: string }>>)
      .pipe(map((arr) => arr.map((d) => mapBounty(d.id, groupId, d))));
  }

  getBounty(groupId: string, bountyId: string): Observable<Bounty | undefined> {
    const ref = doc(this.firestore, 'groups', groupId, 'bounties', bountyId);
    return (docData(ref) as Observable<BountyDoc>).pipe(
      map((d) => (d ? mapBounty(bountyId, groupId, d) : undefined)),
    );
  }

  getLeaderboard(groupId: string): Observable<LeaderboardEntry[]> {
    const ref = doc(this.firestore, 'groups', groupId, 'leaderboard', 'summary');
    return (docData(ref) as Observable<{
      entries?: Array<{ userId: string; name: string; photoURL?: string;
                        points: number; wins: number; losses: number }>;
    }>).pipe(
      map((d) => {
        const list = d?.entries ?? [];
        return list.map((e, i): LeaderboardEntry => ({
          userId: e.userId,
          rank: i + 1,
          user: {
            uid: e.userId,
            displayName: e.name,
            handle: e.name.toLowerCase().replace(/\s+/g, ''),
            initials: initialsOf(e.name),
            avatarVariant: pickVariant(e.userId),
            totalPoints: e.points,
          },
          points: e.points,
          wins: e.wins,
          losses: e.losses,
          netIou: 0,
        }));
      }),
    );
  }

  /* ── Mutations ───────────────────────────────────────────────────── */

  /** Direct write — spec allows clients to create bounties in `available` state. */
  async postBounty(input: {
    groupId: string; title: string; description: string; price: number;
    expiresAt: Date; currency?: string;
  }): Promise<Bounty> {
    const uid = this.currentUserId;
    if (!uid) throw new Error('Not signed in');
    if (!input.title.trim()) throw new Error('Title required');
    if (input.title.length > 80) throw new Error('Title must be 80 characters or fewer');
    if (input.description.length > 1000) throw new Error('Description must be 1000 characters or fewer');
    if (!Number.isInteger(input.price) || input.price < 1) throw new Error('Price must be a positive integer');
    const ref = collection(this.firestore, 'groups', input.groupId, 'bounties');
    const docRef = await addDoc(ref, {
      title: input.title,
      description: input.description,
      price: input.price,
      currency: input.currency ?? 'USD',
      state: 'available' as BountyState,
      posterId: uid,
      claimantId: null,
      expiresAt: Timestamp.fromDate(input.expiresAt),
      createdAt: serverTimestamp(),
    });
    return {
      id: docRef.id,
      groupId: input.groupId,
      title: input.title,
      description: input.description,
      price: input.price,
      state: 'available',
      posterId: uid,
      claimantId: null,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
    };
  }

  /** State transitions are server-side per the spec — all go through callables. */
  claim(bountyId: string): Promise<void> {
    const b = this.bountyById(bountyId);
    if (!b) return Promise.resolve();
    return this.callable('claimBounty', { groupId: b.groupId, bountyId });
  }

  /**
   * Upload one proof file to groups/{gid}/bounties/{bid}/proof/{uid}/{file}.
   * Reports 0–100 progress via the callback and resolves with the download URL.
   */
  uploadProofFile(
    groupId: string,
    bountyId: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<string> {
    const uid = this.currentUserId;
    if (!uid) return Promise.reject(new Error('Not signed in'));
    const safeName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const path = `groups/${groupId}/bounties/${bountyId}/proof/${uid}/${safeName}`;
    const task = uploadBytesResumable(ref(this.storage, path), file, {
      contentType: file.type,
    });
    return new Promise<string>((resolve, reject) => {
      task.on('state_changed',
        (snap) => onProgress?.(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
        (err) => reject(err),
        async () => {
          try {
            resolve(await getDownloadURL(task.snapshot.ref));
          } catch (err) {
            reject(err);
          }
        },
      );
    });
  }

  submitProof(bountyId: string, note: string, urls: string[] = []): Promise<void> {
    const b = this.bountyById(bountyId);
    if (!b) return Promise.resolve();
    return this.callable('submitProof', {
      groupId: b.groupId, bountyId,
      proof: { urls, note },
    });
  }

  approve(bountyId: string): Promise<void> {
    const b = this.bountyById(bountyId);
    if (!b) return Promise.resolve();
    return this.callable('approveBounty', { groupId: b.groupId, bountyId });
  }

  reject(bountyId: string, reason?: string): Promise<void> {
    const b = this.bountyById(bountyId);
    if (!b) return Promise.resolve();
    return this.callable('rejectBounty', { groupId: b.groupId, bountyId, reason });
  }

  createGroup(input: { name: string; emoji?: string }): Promise<{ groupId: string; inviteCode: string }> {
    return this.callableRaw<{ name: string; emoji?: string }, { groupId: string; inviteCode: string }>(
      'createGroup',
      input,
    );
  }

  joinGroup(inviteCode: string): Promise<{ groupId: string; alreadyMember?: boolean }> {
    return this.callableRaw<{ inviteCode: string }, { groupId: string; alreadyMember?: boolean }>(
      'joinGroup',
      { inviteCode },
    );
  }

  markIouPaid(iouId: string): Promise<{ settled: boolean }> {
    return this.callableRaw<{ iouId: string }, { settled: boolean }>('markIouPaid', { iouId });
  }

  /** Mark a single notification read (rules allow self-update of `read`). */
  async markNotificationRead(nid: string): Promise<void> {
    const uid = this.currentUserId;
    if (!uid) return;
    await updateDoc(doc(this.firestore, 'notifications', uid, 'inbox', nid), { read: true });
  }

  /** Mark every currently-loaded unread notification read in one batch. */
  async markAllRead(): Promise<void> {
    const uid = this.currentUserId;
    if (!uid) return;
    const unread = this._notifications().filter((n) => !n.read);
    if (unread.length === 0) return;
    const batch = writeBatch(this.firestore);
    for (const n of unread) {
      batch.update(doc(this.firestore, 'notifications', uid, 'inbox', n.id), { read: true });
    }
    await batch.commit();
  }

  regenerateInviteCode(groupId: string): Promise<{ inviteCode: string }> {
    return this.callableRaw<{ groupId: string }, { inviteCode: string }>(
      'regenerateInviteCode', { groupId },
    );
  }

  /** Owner/admin only — direct write, allowed by rules. */
  async updateGroup(groupId: string, patch: Partial<{
    name: string; emoji: string; defaultExpiryDays: number;
  }>): Promise<void> {
    await updateDoc(doc(this.firestore, 'groups', groupId), patch);
  }

  /** Owner can promote/demote any member. */
  async setMemberRole(groupId: string, uid: string, role: 'owner' | 'admin' | 'member'): Promise<void> {
    await updateDoc(doc(this.firestore, 'groups', groupId, 'members', uid), { role });
  }

  /** Members in a given group (cached from the live listener). */
  membersOf(groupId: string): Member[] {
    return this.membersByGroup.get(groupId) ?? [];
  }

  /** Live activity timeline for a bounty (chronological). */
  getActivity(groupId: string, bountyId: string): Observable<ActivityEvent[]> {
    const ref = collection(
      this.firestore,
      'groups', groupId, 'bounties', bountyId, 'activity',
    );
    const q = query(ref, orderBy('at', 'asc'));
    return (collectionData(q, { idField: 'id' }) as Observable<Array<{
      id: string; kind: ActivityEvent['kind']; actorId: string;
      at: Timestamp; note?: string;
    }>>).pipe(
      map((arr) => arr.map((d) => ({
        id: d.id,
        bountyId,
        kind: d.kind,
        actorId: d.actorId,
        at: toDate(d.at),
        note: d.note,
      }))),
    );
  }

  private async callable(name: string, payload: unknown): Promise<void> {
    const fn = httpsCallable<unknown, unknown>(this.functions, name);
    await fn(payload);
  }

  private async callableRaw<I, O>(name: string, payload: I): Promise<O> {
    const fn = httpsCallable<I, O>(this.functions, name);
    const res = await fn(payload);
    return res.data;
  }
}
