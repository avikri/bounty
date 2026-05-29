import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { DatePipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { DataService } from '../../core/data.service';
import { AvatarComponent } from '../../shared/avatar.component';
import { StateBadgeComponent } from '../../shared/state-badge.component';
import { IconComponent } from '../../shared/icon.component';
import { ToastService } from '../../shared/toast.service';
import { IOU, User } from '../../core/models';

interface DisplayIou {
  iou: IOU;
  counterparty: User | undefined;
  iOweThem: boolean;
  myMark: boolean;
  awaitingOther: boolean;
}

@Component({
  selector: 'app-user-profile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, StateBadgeComponent, IconComponent, DatePipe],
  template: `
    @if (user(); as u) {
      <div class="wrap">
        <div class="ident">
          <app-avatar [initials]="u.initials" [variant]="u.avatarVariant" size="xl" />
          <div class="who">
            <h1>{{ u.displayName }}</h1>
            <div class="handle">{{ '@' + u.handle }} · in {{ groupCount() }} groups</div>
          </div>
          <button class="menu-btn"><app-icon name="menu" [size]="16" /></button>
        </div>

        <div class="stats">
          <div class="stat primary">
            <div class="stat-label">Points</div>
            <div class="stat-value">{{ u.totalPoints }}</div>
          </div>
          <div class="stat success">
            <div class="stat-label">Wins</div>
            <div class="stat-value">{{ winsCount() }}</div>
          </div>
          <div class="stat danger">
            <div class="stat-label">Losses</div>
            <div class="stat-value">{{ lossesCount() }}</div>
          </div>
        </div>

        <div class="kicker">Open IOUs</div>
        <div class="iou-card">
          @for (row of openIous(); track row.iou.id; let last = $last) {
            <div class="iou-row" [class.last]="last">
              @if (row.counterparty; as c) {
                <app-avatar [initials]="c.initials" [variant]="c.avatarVariant" size="sm" />
              }
              <div class="meat">
                <div class="line">
                  {{ row.iOweThem ? 'You owe ' + label(row.counterparty) : label(row.counterparty) + ' owes you' }}
                </div>
                <div class="sub">
                  @if (row.awaitingOther) {
                    waiting on {{ row.iOweThem ? label(row.counterparty) : 'them' }} to confirm
                  } @else if (row.myMark) {
                    you marked it paid — waiting on them
                  } @else {
                    not marked yet
                  }
                </div>
              </div>
              <div class="amount" [class.pos]="!row.iOweThem" [class.neg]="row.iOweThem">
                {{ row.iOweThem ? '−$' + row.iou.amount : '+$' + row.iou.amount }}
              </div>
              @if (isMe()) {
                <button class="btn ghost sm"
                        (click)="markPaid(row.iou.id)"
                        [disabled]="row.myMark || busyId() === row.iou.id">
                  {{ row.myMark ? 'Marked' : (busyId() === row.iou.id ? '…' : 'Mark paid') }}
                </button>
              }
            </div>
          } @empty {
            <div class="empty">No open IOUs.</div>
          }
        </div>

        @if (settledIous().length > 0) {
          <div class="kicker">Settled</div>
          <div class="iou-card">
            @for (row of settledIous(); track row.iou.id; let last = $last) {
              <div class="iou-row settled" [class.last]="last">
                @if (row.counterparty; as c) {
                  <app-avatar [initials]="c.initials" [variant]="c.avatarVariant" size="sm" />
                }
                <div class="meat">
                  <div class="line">
                    Settled with {{ label(row.counterparty) }}
                  </div>
                  <div class="sub">{{ row.iou.settledAt ? (row.iou.settledAt | date) : '' }}</div>
                </div>
                <div class="amount muted">\${{ row.iou.amount }}</div>
              </div>
            }
          </div>
        }

        <div class="kicker">Recent</div>
        @for (b of recent(); track b.id) {
          <div class="recent-card">
            <div class="title">{{ b.title }}</div>
            <app-state-badge
              [bountyState]="b.state"
              [overrideLabel]="b.state === 'successful' ? '+' + b.price : '−' + b.price"
            />
          </div>
        } @empty {
          <div class="empty">No recent results.</div>
        }
      </div>
    } @else {
      <div class="wrap"><p>User not found.</p></div>
    }
  `,
  styles: [`
    .wrap { padding: 18px 20px 100px; max-width: 720px; margin: 0 auto; }
    .ident {
      display: flex; align-items: center; gap: 12px;
      padding: 6px 0 18px;
    }
    .who { flex: 1; }
    .ident h1 { font-size: 22px; line-height: 1; }
    .handle { font-size: 13px; color: var(--muted); margin-top: 4px; }
    .menu-btn {
      background: var(--bg-3); border: 0; border-radius: 999px;
      width: 32px; height: 32px; cursor: pointer; color: var(--ink);
      display: grid; place-items: center;
    }

    .stats {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
      margin-bottom: 18px;
    }
    .stat { border-radius: 14px; padding: 12px; }
    .stat-label {
      font-size: 10px;
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .stat-value {
      font-family: 'Bricolage Grotesque';
      font-weight: 800; font-size: 22px;
      letter-spacing: -0.02em;
    }
    .stat.primary { background: var(--primary-soft); }
    .stat.primary .stat-label, .stat.primary .stat-value { color: var(--primary-deep); }
    .stat.success { background: var(--success-soft); }
    .stat.success .stat-label, .stat.success .stat-value { color: var(--success); }
    .stat.danger { background: var(--danger-soft); }
    .stat.danger .stat-label, .stat.danger .stat-value { color: var(--danger); }

    .kicker {
      font-size: 11px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
      margin: 12px 0 8px;
    }

    .iou-card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--r-lg);
      overflow: hidden;
      margin-bottom: 18px;
      box-shadow: var(--shadow-1);
    }
    .iou-row {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }
    .iou-row.last { border-bottom: 0; }
    .iou-row .meat { flex: 1; }
    .iou-row .line { font-size: 13px; font-weight: 600; }
    .iou-row .sub { font-size: 11px; color: var(--muted); }
    .amount { font-family: 'Bricolage Grotesque'; font-weight: 700; font-size: 16px; }
    .amount.pos { color: var(--success); }
    .amount.neg { color: var(--danger); }
    .amount.muted { color: var(--muted); }
    .iou-row.settled .meat .line { color: var(--muted); font-weight: 500; }

    .btn.sm { padding: 6px 10px; font-size: 11px; }

    .recent-card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--r-lg);
      padding: 12px 14px;
      margin-bottom: 8px;
      display: flex; justify-content: space-between; align-items: center; gap: 8px;
      box-shadow: var(--shadow-1);
    }
    .recent-card .title { font-weight: 600; font-size: 13px; line-height: 1.3; }

    .empty {
      padding: 18px;
      text-align: center;
      color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
    }
  `],
})
export class UserProfilePage {
  private readonly route = inject(ActivatedRoute);
  private readonly data = inject(DataService);
  private readonly toast = inject(ToastService);

  private readonly params = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });

  protected user = computed(() => {
    const id = this.params().get('userId') ?? '';
    if (id === 'me') return this.data.me();
    return this.data.userById(id) ?? this.data.me();
  });

  protected isMe = computed(() => this.user().uid === this.data.currentUserId);

  protected groupCount = computed(() =>
    this.data.groups().filter((g) => g.memberIds.includes(this.user().uid)).length,
  );
  protected winsCount = computed(() =>
    this.data.bounties().filter((b) => b.state === 'successful' && b.claimantId === this.user().uid).length,
  );
  protected lossesCount = computed(() =>
    this.data.bounties().filter((b) => b.state === 'failed' && b.claimantId === this.user().uid).length,
  );

  protected busyId = signal<string | null>(null);

  private allIous = computed<DisplayIou[]>(() => {
    if (!this.isMe()) return [];
    const me = this.data.currentUserId;
    return this.data.myIousList().map((iou) => {
      const iOweThem = iou.debtorId === me;
      const otherUid = iOweThem ? iou.creditorId : iou.debtorId;
      const myMark = iOweThem
        ? iou.status === 'debtor_marked'
        : iou.status === 'creditor_marked';
      const awaitingOther = iou.status === 'open' && !myMark;
      return {
        iou,
        counterparty: this.data.userById(otherUid),
        iOweThem,
        myMark,
        awaitingOther,
      };
    });
  });

  protected openIous = computed(() =>
    this.allIous().filter((r) => r.iou.status !== 'settled'),
  );
  protected settledIous = computed(() =>
    this.allIous().filter((r) => r.iou.status === 'settled'),
  );

  protected recent = computed(() => this.data.myRecentResolutions());

  label(u: User | undefined): string {
    if (!u) return 'someone';
    return u.displayName.split(' ')[0] ?? u.handle;
  }

  async markPaid(iouId: string): Promise<void> {
    this.busyId.set(iouId);
    try {
      const res = await this.data.markIouPaid(iouId);
      this.toast.success(res.settled ? 'IOU settled.' : 'Marked — waiting on the other party.');
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    } finally {
      this.busyId.set(null);
    }
  }
}
