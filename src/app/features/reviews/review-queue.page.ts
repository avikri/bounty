import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { DataService } from '../../core/data.service';
import { AvatarComponent } from '../../shared/avatar.component';
import { StateBadgeComponent } from '../../shared/state-badge.component';
import { RelativePipe } from '../../shared/countdown.pipe';
import { IconComponent } from '../../shared/icon.component';
import { ProofGalleryComponent } from '../../shared/proof-gallery.component';
import { ToastService } from '../../shared/toast.service';
import { Bounty, Group } from '../../core/models';

@Component({
  selector: 'app-review-queue',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, StateBadgeComponent, RelativePipe, IconComponent, FormsModule, ProofGalleryComponent],
  template: `
    <div class="wrap">
      <div class="topbar">
        <div>
          <h2>Your reviews</h2>
          <div class="sub">{{ pending().length }} pending · across {{ groupBuckets().length }} groups</div>
        </div>
        <app-avatar [initials]="me().initials" [variant]="me().avatarVariant" />
      </div>

      <div class="dt-grid">
        <div class="list">
          @if (pending().length === 0) {
            <div class="empty">All caught up. No reviews waiting on you.</div>
          }
          @for (bucket of groupBuckets(); track bucket.group.id) {
            <div class="bucket-label">{{ bucket.group.emoji }} {{ shortName(bucket.group.name) }}</div>
            @for (b of bucket.bounties; track b.id) {
              <button
                class="review-row"
                [class.selected]="selectedId() === b.id"
                (click)="select(b.id)"
              >
                @if (firstImage(b); as src) {
                  <img class="thumb img" [src]="src" alt="proof" />
                } @else if (b.proof?.urls?.length) {
                  <div class="img-ph thumb">video</div>
                } @else {
                  <div class="img-ph thumb">proof</div>
                }
                <div class="meat">
                  <div class="title-row">
                    <div class="title">{{ b.title }}</div>
                    <div class="price">\${{ b.price }}</div>
                  </div>
                  @if (claimantOf(b); as c) {
                    <div class="who">
                      <app-avatar [initials]="c.initials" [variant]="c.avatarVariant" size="sm" />
                      <span>{{ c.handle }} · {{ b.createdAt | relative }} ago</span>
                    </div>
                  }
                </div>
              </button>
            }
          }
        </div>

        @if (selected(); as b) {
          <aside class="detail-panel">
            <app-state-badge [bountyState]="b.state" />
            <h3 class="d-title">{{ b.title }}</h3>
            @if (b.proof?.urls?.length) {
              <app-proof-gallery [urls]="b.proof!.urls" />
              <div style="height: 12px;"></div>
            } @else {
              <div class="img-ph big">no media submitted</div>
            }
            @if (b.proof?.note) {
              <div class="note-box">
                <div class="kicker">{{ claimantOf(b)?.handle }}'s note</div>
                <div class="note">{{ b.proof?.note }}</div>
              </div>
            }
            <div class="payout-hint">
              Approve → {{ claimantOf(b)?.handle }} <strong>+{{ b.price }} pts</strong>, you owe {{ claimantOf(b)?.handle }} <strong>\${{ b.price }}</strong>.<br />
              Reject → {{ claimantOf(b)?.handle }} <strong>−{{ b.price }} pts</strong>.
            </div>
            <div class="action-row">
              <button class="btn danger" (click)="openReject(b.id)" [disabled]="busy()">Reject</button>
              <button class="btn success" (click)="approve(b.id)" [disabled]="busy()">Approve</button>
            </div>
          </aside>
        }
      </div>
    </div>

    @if (rejectingId(); as rid) {
      <div class="modal-bg" (click)="cancelReject()">
        <div class="modal" (click)="$event.stopPropagation()">
          <h3>Reject submission</h3>
          <p class="hint">Optional: tell the claimant why this didn't pass.</p>
          <textarea class="input" rows="4" [(ngModel)]="rejectReason" maxlength="500"
                    placeholder="e.g. visible hand contact at 0:14"></textarea>
          <div class="row-end">
            <button class="btn ghost" (click)="cancelReject()" [disabled]="busy()">Cancel</button>
            <button class="btn danger" (click)="confirmReject(rid)" [disabled]="busy()">
              {{ busy() ? 'Rejecting…' : 'Reject' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .wrap { padding: 18px 20px 100px; max-width: 1180px; margin: 0 auto; }
    .topbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 4px 16px;
    }
    .topbar h2 { font-size: 22px; }
    .sub { font-size: 12px; color: var(--muted); font-family: 'JetBrains Mono', monospace; margin-top: 2px; }

    .dt-grid { display: grid; grid-template-columns: 1fr; gap: 18px; align-items: start; }

    .bucket-label {
      font-size: 11px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
      margin: 12px 0 8px;
    }

    .review-row {
      width: 100%;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--r-lg);
      padding: 14px;
      box-shadow: var(--shadow-1);
      margin-bottom: 10px;
      cursor: pointer;
      text-align: left;
      transition: transform .08s ease, box-shadow .15s ease, border-color .15s ease;
      display: flex; gap: 12px;
      font-family: inherit;
    }
    .review-row:hover { transform: translateY(-1px); box-shadow: var(--shadow-2); }
    .review-row.selected {
      border: 2px solid var(--primary);
      padding: 13px;
      box-shadow: 0 6px 20px rgba(249,115,22,.12);
    }

    .thumb { width: 56px; height: 56px; flex-shrink: 0; }
    .thumb.img { border-radius: var(--r-md); object-fit: cover; border: 1px solid var(--line); }
    .meat { flex: 1; min-width: 0; }
    .title-row {
      display: flex; justify-content: space-between; gap: 8px;
      margin-bottom: 6px;
    }
    .title { font-weight: 700; font-size: 14px; line-height: 1.3; }
    .price { font-family: 'Bricolage Grotesque'; font-weight: 700; font-size: 16px; flex-shrink: 0; }
    .who {
      display: flex; align-items: center; gap: 8px;
      font-size: 12px; color: var(--muted);
    }

    .empty {
      padding: 36px 18px; text-align: center; color: var(--muted);
      font-family: 'JetBrains Mono', monospace; font-size: 13px;
      border: 1px dashed var(--line-2); border-radius: var(--r-lg);
    }

    .detail-panel {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--r-lg);
      padding: 18px;
      box-shadow: var(--shadow-1);
    }
    .detail-panel app-state-badge { display: inline-block; margin-bottom: 10px; }
    .d-title {
      font-size: 19px; line-height: 1.2; margin: 0 0 12px;
    }
    .img-ph.big { aspect-ratio: 16/10; margin-bottom: 12px; font-size: 13px; }
    .note-box {
      background: var(--bg-2);
      border-radius: 12px;
      padding: 12px 14px;
      margin-bottom: 14px;
    }
    .kicker {
      font-size: 11px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
      margin-bottom: 6px;
    }
    .note { font-size: 13px; line-height: 1.5; }
    .payout-hint {
      background: var(--primary-soft);
      border-radius: 12px;
      padding: 10px 14px;
      margin-bottom: 16px;
      font-size: 12px; color: var(--primary-deep); line-height: 1.5;
    }
    .action-row {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
    }

    @media (min-width: 960px) {
      .wrap { padding: 28px 32px 60px; }
      .dt-grid { grid-template-columns: 1.4fr 1fr; gap: 24px; }
    }

    .modal-bg {
      position: fixed; inset: 0;
      background: rgba(20,15,5,.45);
      display: grid; place-items: center;
      z-index: 60; padding: 18px;
    }
    .modal {
      background: var(--card);
      border-radius: 18px;
      padding: 20px;
      width: min(440px, 100%);
      box-shadow: 0 10px 40px rgba(0,0,0,.2);
    }
    .modal h3 { margin: 0 0 6px; font-size: 18px; }
    .modal .hint { font-size: 12px; color: var(--muted); margin: 0 0 12px; }
    .row-end { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
  `],
})
export class ReviewQueuePage {
  private readonly data = inject(DataService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  protected readonly me = this.data.me;
  protected readonly pending = computed(() => this.data.pendingReviewsForMe());
  protected readonly busy = signal(false);
  protected readonly rejectingId = signal<string | null>(null);
  protected rejectReason = signal('');

  protected readonly groupBuckets = computed(() => {
    const groups = new Map<string, { group: Group; bounties: Bounty[] }>();
    for (const b of this.pending()) {
      const g = this.data.groupById(b.groupId);
      if (!g) continue;
      const entry = groups.get(g.id) ?? { group: g, bounties: [] };
      entry.bounties.push(b);
      groups.set(g.id, entry);
    }
    return [...groups.values()];
  });

  private readonly qp = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  protected readonly selectedId = signal<string | null>(null);
  protected readonly selected = computed(() => {
    const id = this.selectedId();
    return id ? this.data.bountyById(id) : undefined;
  });

  constructor() {
    effect(() => {
      const fromUrl = this.qp().get('id');
      const list = this.pending();
      if (fromUrl && list.some((b) => b.id === fromUrl)) {
        this.selectedId.set(fromUrl);
      } else if (!this.selectedId() && list[0]) {
        this.selectedId.set(list[0].id);
      } else if (this.selectedId() && !list.some((b) => b.id === this.selectedId())) {
        this.selectedId.set(list[0]?.id ?? null);
      }
    });
  }

  select(id: string): void {
    this.selectedId.set(id);
    this.router.navigate([], { queryParams: { id }, queryParamsHandling: 'merge' });
  }

  claimantOf(b: Bounty) {
    return b.claimantId ? this.data.userById(b.claimantId) : undefined;
  }

  /** First image URL in the proof, if any — used for the row thumbnail. */
  firstImage(b: Bounty): string | undefined {
    return b.proof?.urls?.find((u) => /\.(png|jpe?g|gif|webp|avif|heic)(\?|#|$)/i.test(u));
  }

  shortName(name: string): string { return name.split(' ')[0] ?? name; }

  async approve(id: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.data.approve(id);
      this.toast.success('Approved.');
      this.selectedId.set(null);
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }

  openReject(id: string): void {
    this.rejectReason.set('');
    this.rejectingId.set(id);
  }

  cancelReject(): void {
    if (this.busy()) return;
    this.rejectingId.set(null);
  }

  async confirmReject(id: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.data.reject(id, this.rejectReason().trim() || undefined);
      this.toast.success('Rejected.');
      this.rejectingId.set(null);
      this.selectedId.set(null);
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
