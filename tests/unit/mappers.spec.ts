import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_USER,
  hashCode,
  initialsOf,
  mapBounty,
  mapGroup,
  mapIou,
  mapMember,
  mapNotification,
  pickVariant,
  toDate,
  type BountyDoc,
  type GroupDoc,
  type IouDoc,
  type MemberDoc,
  type NotificationDoc,
} from '../../src/app/core/mappers';

/** A stand-in for a Firestore Timestamp — only `toDate()` is exercised. */
function ts(date: Date): { toDate(): Date } {
  return { toDate: () => date };
}

describe('toDate', () => {
  it('passes a Date through unchanged', () => {
    const d = new Date('2024-01-02T03:04:05Z');
    expect(toDate(d)).toBe(d);
  });

  it('unwraps a Timestamp-like value via toDate()', () => {
    const d = new Date('2025-05-29T00:00:00Z');
    expect(toDate(ts(d))).toBe(d);
  });

  it('returns "now" for null/undefined rather than an invalid date', () => {
    const before = Date.now();
    const result = toDate(undefined).getTime();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(Date.now());
    expect(Number.isNaN(toDate(null).getTime())).toBe(false);
  });

  it('treats a non-zero number as epoch millis', () => {
    const millis = Date.UTC(2025, 0, 1);
    expect(toDate(millis as unknown as Date).getTime()).toBe(millis);
    // Note: 0 is falsy, so it hits the null guard and returns "now" instead.
  });
});

describe('initialsOf', () => {
  it('uses first letters of the first two words', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
  });

  it('yields a single initial for a mononym', () => {
    // Only one word, so the second initial is empty.
    expect(initialsOf('Madonna')).toBe('M');
  });

  it('collapses extra whitespace', () => {
    expect(initialsOf('  grace   hopper  ')).toBe('GH');
  });

  it('yields an empty string for an empty name', () => {
    expect(initialsOf('')).toBe('');
  });
});

describe('pickVariant', () => {
  it('returns a value in 1..5', () => {
    for (const uid of ['', 'a', 'abc', 'a-very-long-uid-1234567890']) {
      const v = pickVariant(uid);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(5);
    }
  });

  it('is deterministic for the same uid', () => {
    expect(pickVariant('user-42')).toBe(pickVariant('user-42'));
  });
});

describe('hashCode', () => {
  it('is deterministic and 0 for empty', () => {
    expect(hashCode('')).toBe(0);
    expect(hashCode('abc')).toBe(hashCode('abc'));
  });
});

describe('mapGroup', () => {
  const base: GroupDoc = {
    name: 'Roomies',
    ownerId: 'owner1',
    inviteCode: 'ABC123',
  };

  it('maps fields and passes memberIds through', () => {
    const g = mapGroup('g1', base, ['owner1', 'u2']);
    expect(g.id).toBe('g1');
    expect(g.name).toBe('Roomies');
    expect(g.ownerId).toBe('owner1');
    expect(g.inviteCode).toBe('ABC123');
    expect(g.memberIds).toEqual(['owner1', 'u2']);
    expect(g.unreadCount).toBe(0);
  });

  it('defaults emoji and defaultExpiryDays when absent', () => {
    const g = mapGroup('g1', base, []);
    expect(g.emoji).toBe('👥');
    expect(g.defaultExpiryDays).toBe(7);
  });

  it('respects provided emoji and expiry', () => {
    const g = mapGroup('g1', { ...base, emoji: '🏠', defaultExpiryDays: 14 }, []);
    expect(g.emoji).toBe('🏠');
    expect(g.defaultExpiryDays).toBe(14);
  });

  it('derives a stable surfaceTone from the id', () => {
    const tones = ['primary', 'info', 'success', 'purple', 'warn'];
    const g = mapGroup('g1', base, []);
    expect(tones).toContain(g.surfaceTone);
    expect(mapGroup('g1', base, []).surfaceTone).toBe(g.surfaceTone);
  });
});

describe('mapMember', () => {
  const base: MemberDoc = {
    role: 'member',
    points: 30,
    wins: 3,
    losses: 1,
    displayName: 'Grace Hopper',
  };

  it('maps role/points/wins/losses and derives handle + initials', () => {
    const m = mapMember('u1', base);
    expect(m.uid).toBe('u1');
    expect(m.role).toBe('member');
    expect(m.points).toBe(30);
    expect(m.wins).toBe(3);
    expect(m.losses).toBe(1);
    expect(m.totalPoints).toBe(30);
    expect(m.handle).toBe('gracehopper');
    expect(m.initials).toBe('GH');
  });

  it('coerces missing numeric fields to 0', () => {
    const m = mapMember('u1', {
      role: 'owner',
      displayName: 'Solo',
    } as unknown as MemberDoc);
    expect(m.points).toBe(0);
    expect(m.wins).toBe(0);
    expect(m.losses).toBe(0);
    expect(m.totalPoints).toBe(0);
  });
});

describe('mapBounty', () => {
  const created = new Date('2025-01-01T00:00:00Z');
  const expires = new Date('2025-01-08T00:00:00Z');
  const base: BountyDoc = {
    title: 'Take out the bins',
    description: 'Tuesday night',
    price: 5,
    state: 'available',
    posterId: 'p1',
    expiresAt: ts(expires) as never,
    createdAt: ts(created) as never,
  };

  it('maps core fields and converts timestamps to dates', () => {
    const b = mapBounty('b1', 'g1', base);
    expect(b.id).toBe('b1');
    expect(b.groupId).toBe('g1');
    expect(b.state).toBe('available');
    expect(b.posterId).toBe('p1');
    expect(b.createdAt).toEqual(created);
    expect(b.expiresAt).toEqual(expires);
  });

  it('defaults claimantId to null and leaves resolvedAt undefined when absent', () => {
    const b = mapBounty('b1', 'g1', base);
    expect(b.claimantId).toBeNull();
    expect(b.resolvedAt).toBeUndefined();
  });

  it('maps claimant, proof, resolvedAt and rejectionReason when present', () => {
    const resolved = new Date('2025-01-05T00:00:00Z');
    const b = mapBounty('b1', 'g1', {
      ...base,
      state: 'failed',
      claimantId: 'c1',
      proof: { urls: ['http://x/y.png'], note: 'done' },
      resolvedAt: ts(resolved) as never,
      rejectionReason: 'blurry photo',
    });
    expect(b.claimantId).toBe('c1');
    expect(b.proof).toEqual({ urls: ['http://x/y.png'], note: 'done' });
    expect(b.resolvedAt).toEqual(resolved);
    expect(b.rejectionReason).toBe('blurry photo');
  });
});

describe('mapIou', () => {
  it('maps fields and converts createdAt/settledAt to dates', () => {
    const created = new Date('2025-02-01T00:00:00Z');
    const settled = new Date('2025-02-03T00:00:00Z');
    const d: IouDoc = {
      groupId: 'g1',
      debtorId: 'p1',
      creditorId: 'c1',
      amount: 10,
      bountyId: 'b1',
      status: 'settled',
      createdAt: ts(created) as never,
      settledAt: ts(settled) as never,
    };
    const iou = mapIou('i1', d);
    expect(iou.id).toBe('i1');
    expect(iou.debtorId).toBe('p1');
    expect(iou.creditorId).toBe('c1');
    expect(iou.amount).toBe(10);
    expect(iou.status).toBe('settled');
    expect(iou.createdAt).toEqual(created);
    expect(iou.settledAt).toEqual(settled);
  });

  it('leaves settledAt undefined for an open IOU', () => {
    const iou = mapIou('i1', {
      groupId: 'g1',
      debtorId: 'p1',
      creditorId: 'c1',
      amount: 10,
      bountyId: 'b1',
      status: 'open',
      createdAt: ts(new Date()) as never,
    });
    expect(iou.settledAt).toBeUndefined();
  });
});

describe('mapNotification', () => {
  const createdAt = ts(new Date('2025-03-01T00:00:00Z')) as never;

  it('maps fields and defaults read to false', () => {
    const n = mapNotification('n1', {
      kind: 'bounty_claimed',
      title: 'Bounty claimed',
      body: 'Someone claimed it',
      groupId: 'g1',
      bountyId: 'b1',
      actorId: 'u2',
      amount: 5,
      createdAt,
    });
    expect(n.id).toBe('n1');
    expect(n.kind).toBe('bounty_claimed');
    expect(n.title).toBe('Bounty claimed');
    expect(n.body).toBe('Someone claimed it');
    expect(n.read).toBe(false);
    expect(n.amount).toBe(5);
  });

  it('falls back to the legacy `text` field for the body', () => {
    const n = mapNotification('n1', {
      kind: 'iou_settled',
      text: 'legacy body',
      createdAt,
    } as NotificationDoc);
    expect(n.body).toBe('legacy body');
    expect(n.title).toBe('Notification');
  });

  it('preserves an explicit read flag', () => {
    const n = mapNotification('n1', {
      kind: 'iou_settled',
      read: true,
      createdAt,
    } as NotificationDoc);
    expect(n.read).toBe(true);
  });
});

describe('PLACEHOLDER_USER', () => {
  it('represents a signed-out user', () => {
    expect(PLACEHOLDER_USER.uid).toBe('');
    expect(PLACEHOLDER_USER.totalPoints).toBe(0);
  });
});
