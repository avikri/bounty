import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { DatePipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { DataService } from '../../core/data.service';
import { StripeService } from '../../core/stripe.service';
import { AvatarComponent } from '../../shared/avatar.component';
import { StateBadgeComponent } from '../../shared/state-badge.component';
import { IconComponent } from '../../shared/icon.component';
import { ToastService } from '../../shared/toast.service';
import { IOU, User } from '../../core/models';
import { CardPaymentDialogComponent } from './card-payment-dialog.component';

interface DisplayIou {
  iou: IOU;
  counterparty: User | undefined;
  iOweThem: boolean;
  /** I have already marked my side. */
  myMark: boolean;
  /** The other party marked their side and it's my turn to confirm. */
  theyMarked: boolean;
  /** A card PaymentIntent exists for this IOU but the webhook hasn't settled it. */
  cardPending: boolean;
  /** Debtor tapped "Pay with card" but the creditor hasn't set up payouts yet. */
  awaitingOnboarding: boolean;
  /** Settled, and the settlement came through a card payment. */
  settledByCard: boolean;
  /** Custom (non-cash) reward IOU — manual-settle only, never card-payable. */
  isCustom: boolean;
}

/** A pending card payment confirmation in flight, hosted by the dialog. */
interface PayDialogState {
  iouId: string;
  clientSecret: string;
  amountLabel: string;
}

@Component({
  selector: 'app-user-profile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent, StateBadgeComponent, IconComponent, DatePipe,
    CardPaymentDialogComponent,
  ],
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
            <div class="stat-value" data-testid="stat-points">{{ u.totalPoints }}</div>
          </div>
          <div class="stat success">
            <div class="stat-label">Wins</div>
            <div class="stat-value" data-testid="stat-wins">{{ winsCount() }}</div>
          </div>
          <div class="stat danger">
            <div class="stat-label">Losses</div>
            <div class="stat-value" data-testid="stat-losses">{{ lossesCount() }}</div>
          </div>
        </div>

        @if (isMe() && creditorAwaitingSetup()) {
          <div class="payout-banner" data-testid="payout-setup-banner">
            <div class="pb-text">
              <div class="pb-title">Set up payouts to get paid by card</div>
              <div class="pb-sub">
                Someone wants to settle an IOU with you by card. Set up card payments
                to receive it — or just collect it in cash.
              </div>
            </div>
            <button class="btn sm" (click)="setupPayouts()"
                    [disabled]="onboarding()" data-testid="setup-payouts">
              {{ onboarding() ? '…' : 'Set up payouts' }}
            </button>
          </div>
        }

        <div class="kicker">Open IOUs</div>
        <div class="iou-card" data-testid="open-ious">
          @for (row of openIous(); track row.iou.id; let last = $last) {
            <div class="iou-row" [class.last]="last" data-testid="iou-open-row" [attr.data-iou-id]="row.iou.id">
              @if (row.counterparty; as c) {
                <app-avatar [initials]="c.initials" [variant]="c.avatarVariant" size="sm" />
              }
              <div class="meat">
                <div class="line">
                  {{ row.iOweThem ? 'You owe ' + label(row.counterparty) : label(row.counterparty) + ' owes you' }}
                </div>
                <div class="sub">
                  @if (row.awaitingOnboarding) {
                    waiting for {{ label(row.counterparty) }} to set up card payments — or settle in cash
                  } @else if (row.cardPending) {
                    card payment processing…
                  } @else if (row.myMark) {
                    waiting for {{ label(row.counterparty) }} to confirm
                  } @else if (row.theyMarked) {
                    {{ label(row.counterparty) }} marked it — your turn to confirm
                  } @else {
                    not settled yet
                  }
                </div>
              </div>
              <div class="amount" [class.pos]="!row.iOweThem" [class.neg]="row.iOweThem">
                {{ iouLabel(row) }}
              </div>
              @if (isMe()) {
                <div class="row-actions">
                  @if (row.cardPending) {
                    <span class="pending-pill info" data-testid="iou-card-pending">Card payment pending</span>
                  }
                  @if (row.awaitingOnboarding) {
                    <span class="pending-pill" data-testid="iou-awaiting-onboarding">Awaiting payout setup</span>
                  }
                  @if (row.myMark) {
                    <span class="pending-pill" data-testid="iou-waiting">Waiting…</span>
                  } @else {
                    <button class="btn ghost sm"
                            (click)="markPaid(row.iou.id)"
                            [disabled]="busyId() === row.iou.id"
                            data-testid="iou-action">
                      {{ busyId() === row.iou.id ? '…' : (row.iOweThem ? (row.isCustom ? 'Mark as paid' : 'Mark as paid (cash)') : 'Confirm received') }}
                    </button>
                    @if (row.iOweThem && canCard() && !row.awaitingOnboarding && !row.isCustom) {
                      <button class="btn sm"
                              (click)="payWithCard(row)"
                              [disabled]="busyId() === row.iou.id"
                              data-testid="iou-pay-card">
                        {{ busyId() === row.iou.id ? '…' : 'Pay with card' }}
                      </button>
                    }
                  }
                </div>
              }
            </div>
          } @empty {
            <div class="empty">No open IOUs.</div>
          }
        </div>

        @if (settledIous().length > 0) {
          <div class="kicker">Settled</div>
          <div class="iou-card" data-testid="settled-ious">
            @for (row of settledIous(); track row.iou.id; let last = $last) {
              <div class="iou-row settled" [class.last]="last">
                @if (row.counterparty; as c) {
                  <app-avatar [initials]="c.initials" [variant]="c.avatarVariant" size="sm" />
                }
                <div class="meat">
                  <div class="line">
                    Settled with {{ label(row.counterparty) }}
                  </div>
                  <div class="sub">
                    @if (row.settledByCard) {
                      <span class="card-tag" data-testid="iou-settled-by-card">Settled by card</span> ·
                    }
                    {{ row.iou.settledAt ? (row.iou.settledAt | date) : '' }}
                  </div>
                </div>
                <div class="amount muted">{{ row.isCustom ? (row.iou.rewardText ?? '—') : '$' + row.iou.amount }}</div>
              </div>
            }
          </div>
        }

        <div class="kicker">Recent</div>
        @for (b of recent(); track b.id) {
          <div class="recent-card" data-testid="recent-card">
            <div class="title">{{ b.title }}</div>
            <app-state-badge
              [bountyState]="b.state"
              [overrideLabel]="(b.state === 'successful' ? '+' : '−') + b.points + ' pts'"
            />
          </div>
        } @empty {
          <div class="empty">No recent results.</div>
        }
      </div>
    } @else {
      <div class="wrap"><p>User not found.</p></div>
    }

    @if (payDialog(); as pd) {
      <app-card-payment-dialog
        [clientSecret]="pd.clientSecret"
        [amountLabel]="pd.amountLabel"
        (paid)="onCardPaid()"
        (cancel)="onCardCancel()" />
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
    .row-actions {
      display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
    }
    .pending-pill {
      font-size: 11px; font-weight: 700;
      color: var(--warn); background: var(--warn-soft);
      padding: 5px 10px; border-radius: 999px;
      font-family: 'JetBrains Mono', monospace;
      white-space: nowrap;
    }
    .pending-pill.info { color: var(--info); background: var(--info-soft); }
    .card-tag {
      font-weight: 700; color: var(--info);
      font-family: 'JetBrains Mono', monospace;
    }

    .payout-banner {
      display: flex; align-items: center; gap: 12px;
      background: var(--primary-soft);
      border: 1px solid var(--primary);
      border-radius: var(--r-lg);
      padding: 12px 14px;
      margin-bottom: 16px;
    }
    .payout-banner .pb-text { flex: 1; }
    .payout-banner .pb-title {
      font-weight: 700; font-size: 13px; color: var(--primary-deep);
    }
    .payout-banner .pb-sub {
      font-size: 11px; color: var(--muted); margin-top: 2px; line-height: 1.4;
    }

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
  private readonly stripe = inject(StripeService);

  private readonly params = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });

  /**
   * Whether the card path is available: the publishable key is configured AND
   * the server-side kill-switch (config/payments) is on. Either being false
   * hides every card affordance and leaves only the cash settlement path.
   */
  protected canCard = (): boolean =>
    this.stripe.isConfigured() && this.data.cardPaymentsEnabled();

  /** In-flight card payment confirmation, hosted by the dialog (null = closed). */
  protected payDialog = signal<PayDialogState | null>(null);
  /** True while creating the Connect onboarding link / redirecting. */
  protected onboarding = signal(false);

  constructor() {
    // When the creditor returns from Stripe-hosted onboarding (…/profile?stripe=
    // return), refresh the cached payable flags so the banner clears promptly —
    // the account.updated webhook is the source of truth, this just avoids a wait.
    if (this.route.snapshot.queryParamMap.get('stripe') === 'return') {
      this.data.getConnectAccountStatus()
        .then((s) => {
          if (s.payable) this.toast.success('Payouts are set up — you can now be paid by card.');
          else this.toast.show('Almost there — Stripe is still verifying your details.');
        })
        .catch(() => { /* non-fatal; webhook will reconcile */ });
    }
  }

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
      const theyMarked = iOweThem
        ? iou.status === 'creditor_marked'
        : iou.status === 'debtor_marked';
      const settled = iou.status === 'settled';
      const cardPending =
        !settled && iou.paymentMethod === 'stripe' && !!iou.stripePaymentIntentId;
      const awaitingOnboarding = !settled && iou.awaitingCreditorOnboarding === true;
      return {
        iou,
        counterparty: this.data.userById(otherUid),
        iOweThem,
        myMark,
        theyMarked,
        cardPending,
        awaitingOnboarding,
        settledByCard: settled && iou.paymentMethod === 'stripe',
        isCustom: iou.rewardType === 'custom',
      };
    });
  });

  /** Signed reward label for an IOU row: `±$amount` for cash, the text for custom. */
  protected iouLabel(row: DisplayIou): string {
    const sign = row.iOweThem ? '−' : '+';
    return row.isCustom ? `${sign}${row.iou.rewardText ?? '—'}` : `${sign}$${row.iou.amount}`;
  }

  /**
   * True when someone is waiting to pay me by card but I haven't set up payouts.
   * Drives the creditor's "Set up payouts" prompt — shown ONLY when a card
   * payment is actually pending, never proactively.
   */
  protected creditorAwaitingSetup = computed(() =>
    this.allIous().some((r) => !r.iOweThem && r.awaitingOnboarding),
  );

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

  /** Format an IOU point amount as NZD (1 point = NZ$1). */
  private nzd(amount: number): string {
    return new Intl.NumberFormat('en-NZ', {
      style: 'currency', currency: 'NZD',
    }).format(amount);
  }

  /**
   * Debtor taps "Pay with card". Create the PaymentIntent server-side; if the
   * creditor isn't onboarded the backend returns a distinct status (and has
   * already notified them) — we leave the cash path and the waiting state. On
   * `ok` we open the card dialog with the per-payment client secret.
   */
  async payWithCard(row: DisplayIou): Promise<void> {
    const iouId = row.iou.id;
    this.busyId.set(iouId);
    try {
      const res = await this.data.createIouPaymentIntent(iouId);
      if (res.status === 'creditor_not_onboarded') {
        this.toast.show(
          `${this.label(row.counterparty)} hasn't set up card payments yet — ` +
          'we let them know. You can settle in cash instead.',
        );
        return;
      }
      this.payDialog.set({
        iouId,
        clientSecret: res.clientSecret,
        amountLabel: `${this.nzd(row.iou.amount)} NZD`,
      });
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    } finally {
      this.busyId.set(null);
    }
  }

  /** Card confirmed — settlement lands via the webhook; the listener updates the row. */
  onCardPaid(): void {
    this.payDialog.set(null);
    this.toast.success('Payment submitted — the IOU will settle once it clears.');
  }

  onCardCancel(): void {
    this.payDialog.set(null);
  }

  /**
   * Creditor taps "Set up payouts". Lazily create their Express account and
   * redirect to the Stripe-hosted onboarding flow; they return to /profile.
   */
  async setupPayouts(): Promise<void> {
    if (this.onboarding()) return;
    this.onboarding.set(true);
    try {
      const { url } = await this.data.createConnectAccountAndOnboardingLink();
      window.location.assign(url);
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
      this.onboarding.set(false);
    }
  }
}
