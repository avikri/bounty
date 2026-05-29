import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { of, switchMap } from 'rxjs';
import { DataService } from '../../core/data.service';
import { AvatarComponent } from '../../shared/avatar.component';
import { StateBadgeComponent } from '../../shared/state-badge.component';
import { CountdownPipe, RelativePipe } from '../../shared/countdown.pipe';
import { IconComponent } from '../../shared/icon.component';
import { ToastService } from '../../shared/toast.service';

@Component({
  selector: 'app-bounty-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AvatarComponent, StateBadgeComponent, CountdownPipe, RelativePipe, IconComponent],
  template: `
    @if (bounty(); as b) {
      <div class="wrap">
        <div class="navrow">
          <a class="back" [routerLink]="['/g', b.groupId]"><app-icon name="back" [size]="16" /></a>
          <div class="path">/{{ shortGroup() }}/b/{{ b.id }}</div>
        </div>

        <app-state-badge [bountyState]="b.state" />

        <h1 class="title">{{ b.title }}</h1>
        <p class="desc">{{ b.description }}</p>

        <div class="kv-grid">
          <div class="kv">
            <div class="kv-label">Price</div>
            <div class="kv-value">\${{ b.price }}</div>
          </div>
          <div class="kv">
            <div class="kv-label">{{ b.state === 'successful' || b.state === 'failed' ? 'Resolved' : 'Expires' }}</div>
            <div class="kv-value">{{ kvRight() }}</div>
          </div>
        </div>

        <div class="kicker">Posted by</div>
        <div class="poster">
          @if (poster(); as p) {
            <app-avatar [initials]="p.initials" [variant]="p.avatarVariant" />
            <div>
              <div class="name">{{ p.displayName }}</div>
              <div class="meta">{{ p.totalPoints }} pts</div>
            </div>
          }
        </div>

        @if (b.claimantId) {
          <div class="kicker" style="margin-top: 14px;">Claimed by</div>
          <div class="poster">
            @if (claimant(); as c) {
              <app-avatar [initials]="c.initials" [variant]="c.avatarVariant" />
              <div>
                <div class="name">{{ c.uid === me.uid ? 'you' : c.displayName }}</div>
                <div class="meta">{{ c.totalPoints }} pts</div>
              </div>
            }
          </div>
        }

        @if (b.proof) {
          <div class="kicker" style="margin-top: 18px;">Proof submitted</div>
          @if (b.proof.urls.length) {
            <div class="proof-grid">
              @for (u of b.proof.urls; track u) {
                <a class="proof-tile" [href]="u" target="_blank" rel="noopener">
                  @if (isImage(u)) {
                    <img [src]="u" alt="proof" />
                  } @else {
                    <span class="ext">{{ shortUrl(u) }}</span>
                  }
                </a>
              }
            </div>
          }
          @if (b.proof.note) {
            <div class="proof-note">{{ b.proof.note }}</div>
          }
        }

        @if (b.rejectionReason) {
          <div class="kicker" style="margin-top: 18px;">Rejection reason</div>
          <div class="reason">{{ b.rejectionReason }}</div>
        }

        <div class="kicker" style="margin-top: 22px;">Activity</div>
        <ul class="timeline">
          @for (e of activity(); track e.id) {
            <li>
              <div class="dot" [class]="'k-' + e.kind"></div>
              <div class="event">
                <div class="line">
                  <strong>{{ actorLabel(e.actorId) }}</strong> {{ verb(e.kind) }}
                  @if (e.note) { <span class="note">— {{ e.note }}</span> }
                </div>
                <div class="when">{{ e.at | relative }} ago</div>
              </div>
            </li>
          } @empty {
            <li class="event-empty">No activity yet.</li>
          }
        </ul>

        <div class="action-bar">
          @switch (cta()) {
            @case ('claim') {
              <button class="btn full" (click)="claim()">Claim this bounty</button>
            }
            @case ('submit') {
              <button class="btn full" (click)="goSubmit()">Submit proof</button>
            }
            @case ('review') {
              <button class="btn full" (click)="goReview()">Review submission</button>
            }
            @case ('view') {
              <button class="btn full ghost" disabled>{{ stateLabel() }}</button>
            }
          }
          <div style="height: 8px;"></div>
          <button class="btn full ghost">Share</button>
        </div>
      </div>
    } @else {
      <div class="wrap"><p>Bounty not found.</p></div>
    }
  `,
  styles: [`
    .wrap { padding: 16px 20px 32px; max-width: 720px; margin: 0 auto; }
    .navrow { display: flex; align-items: center; gap: 8px; padding: 4px 0 14px; }
    .back {
      width: 32px; height: 32px; border-radius: 10px;
      background: var(--bg-3);
      display: grid; place-items: center;
      color: var(--ink);
    }
    .path { font-size: 13px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }

    app-state-badge { display: inline-block; margin-bottom: 12px; }

    .title {
      font-size: clamp(22px, 4vw, 28px);
      line-height: 1.15;
      margin: 0 0 8px;
    }
    .desc { font-size: 14px; color: var(--ink-2); margin-bottom: 16px; }

    .kv-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 18px;
    }
    .kv {
      background: var(--bg-2);
      border-radius: 14px;
      padding: 12px;
    }
    .kv-label {
      font-size: 11px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .kv-value {
      font-family: 'Bricolage Grotesque';
      font-weight: 700; font-size: 22px;
      letter-spacing: -0.02em;
      margin-top: 2px;
    }

    .kicker {
      font-size: 11px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
      margin-bottom: 8px;
    }
    .poster { display: flex; align-items: center; gap: 10px; }
    .poster .name { font-weight: 700; font-size: 14px; }
    .poster .meta { font-size: 12px; color: var(--muted); }

    .proof-note, .reason {
      background: var(--bg-2);
      border-radius: 14px;
      padding: 12px 14px;
      font-size: 13px; line-height: 1.5;
    }

    .proof-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
      margin-bottom: 8px;
    }
    .proof-tile {
      aspect-ratio: 1;
      background: var(--bg-2);
      border-radius: 14px;
      overflow: hidden;
      display: grid; place-items: center;
      color: var(--muted);
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      text-decoration: none;
    }
    .proof-tile img { width: 100%; height: 100%; object-fit: cover; }
    .proof-tile .ext { padding: 6px; text-align: center; word-break: break-all; }

    .timeline {
      list-style: none; padding: 0; margin: 0;
      border-left: 1px solid var(--line);
    }
    .timeline li {
      display: flex; gap: 12px;
      padding: 10px 0 10px 14px;
      position: relative;
    }
    .timeline .dot {
      width: 10px; height: 10px; border-radius: 999px;
      background: var(--muted);
      position: absolute; left: -5px; top: 14px;
    }
    .timeline .k-claimed   { background: var(--info); }
    .timeline .k-submitted { background: var(--purple); }
    .timeline .k-approved  { background: var(--success); }
    .timeline .k-rejected  { background: var(--danger); }
    .timeline .k-expired   { background: var(--muted); }
    .timeline .event { flex: 1; }
    .timeline .line { font-size: 13px; }
    .timeline .when { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
    .timeline .note { color: var(--ink-2); }
    .timeline .event-empty {
      list-style: none;
      padding: 10px 0 10px 14px;
      font-size: 12px;
      color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
    }

    .action-bar { margin-top: 22px; }
  `],
})
export class BountyDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly data = inject(DataService);
  private readonly toast = inject(ToastService);
  protected readonly me = this.data.me();

  private readonly params = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });

  protected bounty = computed(() => {
    const id = this.params().get('bountyId') ?? '';
    return this.data.bountyById(id);
  });

  protected readonly activity = toSignal(
    this.route.paramMap.pipe(
      switchMap((p) => {
        const gid = p.get('groupId');
        const bid = p.get('bountyId');
        return gid && bid ? this.data.getActivity(gid, bid) : of([]);
      }),
    ),
    { initialValue: [] },
  );

  protected poster = computed(() => {
    const b = this.bounty();
    return b ? this.data.userById(b.posterId) : undefined;
  });
  protected claimant = computed(() => {
    const b = this.bounty();
    return b?.claimantId ? this.data.userById(b.claimantId) : undefined;
  });

  protected shortGroup = computed(() => this.bounty()?.groupId.replace(/^g-/, '') ?? '');

  protected cta = computed<'claim' | 'submit' | 'review' | 'view'>(() => {
    const b = this.bounty();
    if (!b) return 'view';
    const meId = this.me.uid;
    if (b.state === 'available' && b.posterId !== meId) return 'claim';
    if (b.state === 'claimed' && b.claimantId === meId) return 'submit';
    if (b.state === 'pending_review' && b.posterId === meId) return 'review';
    return 'view';
  });

  protected stateLabel = computed(() => {
    const b = this.bounty();
    if (!b) return '';
    if (b.state === 'successful') return 'Bounty completed';
    if (b.state === 'failed')     return 'Bounty failed';
    if (b.state === 'expired')    return 'Bounty expired';
    if (b.state === 'claimed' && b.claimantId !== this.me.uid)        return 'Claimed by someone else';
    if (b.state === 'pending_review' && b.posterId !== this.me.uid)   return 'Awaiting OP decision';
    if (b.state === 'available' && b.posterId === this.me.uid)        return 'You posted this — wait for a claim';
    return 'View only';
  });

  protected kvRight(): string {
    const b = this.bounty()!;
    if (b.state === 'successful') return 'Won';
    if (b.state === 'failed')     return 'Lost';
    return new CountdownPipe().transform(b.expiresAt);
  }

  protected async claim(): Promise<void> {
    const b = this.bounty();
    if (!b) return;
    try {
      await this.data.claim(b.id);
      this.toast.success('Bounty claimed.');
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    }
  }

  protected goSubmit(): void {
    const b = this.bounty();
    if (b) this.router.navigate(['/g', b.groupId, 'b', b.id, 'submit']);
  }

  protected goReview(): void {
    this.router.navigate(['/reviews'], { queryParams: { id: this.bounty()?.id } });
  }

  protected actorLabel(uid: string): string {
    if (uid === 'system') return 'System';
    if (uid === this.me.uid) return 'you';
    return this.data.userById(uid)?.handle ?? 'someone';
  }

  protected verb(kind: string): string {
    return {
      created: 'created this bounty',
      claimed: 'claimed it',
      submitted: 'submitted proof',
      approved: 'approved it',
      rejected: 'rejected it',
      expired: 'auto-expired',
    }[kind] ?? kind;
  }

  protected isImage(url: string): boolean {
    return /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(url);
  }

  protected shortUrl(url: string): string {
    try { return new URL(url).hostname; } catch { return url.slice(0, 24); }
  }
}
