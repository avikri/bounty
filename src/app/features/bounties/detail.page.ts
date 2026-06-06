import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { of, switchMap } from 'rxjs';
import { DataService } from '../../core/data.service';
import { Comment, Contribution } from '../../core/models';
import { initialsOf, pickVariant } from '../../core/mappers';
import { AvatarComponent } from '../../shared/avatar.component';
import { StateBadgeComponent } from '../../shared/state-badge.component';
import { CountdownPipe, RelativePipe } from '../../shared/countdown.pipe';
import { IconComponent } from '../../shared/icon.component';
import { ProofGalleryComponent } from '../../shared/proof-gallery.component';
import { ToastService } from '../../shared/toast.service';

@Component({
  selector: 'app-bounty-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FormsModule, AvatarComponent, StateBadgeComponent, CountdownPipe, RelativePipe, IconComponent, ProofGalleryComponent],
  template: `
    @if (bounty(); as b) {
      <div class="wrap">
        <div class="navrow">
          <a class="back" [routerLink]="['/g', b.groupId]"><app-icon name="back" [size]="16" /></a>
        </div>

        <app-state-badge [bountyState]="b.state" />

        <h1 class="title">{{ b.title }}</h1>
        <p class="desc">{{ b.description }}</p>

        <div class="kv-grid">
          <div class="kv">
            <div class="kv-label">{{ b.rewardType === 'custom' ? 'Reward' : 'Price' }}</div>
            <div class="kv-value">{{ reward(b) }}<small class="kv-pts"> · {{ b.points }} pts</small></div>
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
                <div class="name">{{ c.uid === me().uid ? 'you' : c.displayName }}</div>
                <div class="meta">{{ c.totalPoints }} pts</div>
              </div>
            }
          </div>
        }

        @if (contributions().length > 0) {
          <div class="kicker" style="margin-top: 18px;">Pooled by</div>
          <ul class="contrib-list" data-testid="contributor-list">
            @for (c of contributions(); track c.uid) {
              <li>
                <span class="cname">{{ contributorLabel(c) }}</span>
                <span class="camount">\${{ c.amount }}</span>
              </li>
            }
          </ul>
        }

        @if (canContribute()) {
          <div class="kicker" style="margin-top: 18px;">Add to this bounty</div>
          <div class="contribute">
            <div class="price-input">
              <span class="prefix">$</span>
              <input class="input" type="number" min="1" step="1"
                     [(ngModel)]="addAmount" data-testid="contribute-amount" />
            </div>
            <button class="btn" (click)="addToBounty()"
                    [disabled]="!canAddAmount() || addBusy()" data-testid="contribute-submit">
              {{ addBusy() ? '…' : 'Add to pot' }}
            </button>
          </div>
        }

        @if (b.proof) {
          <div class="kicker" style="margin-top: 18px;">Proof submitted</div>
          @if (b.proof.urls.length) {
            <app-proof-gallery [urls]="b.proof.urls" />
            <div style="height: 8px;"></div>
          }
          @if (b.proof.note) {
            <div class="proof-note">{{ b.proof.note }}</div>
          }
        }

        @if (b.rejectionReason) {
          <div class="kicker" style="margin-top: 18px;">Rejection reason</div>
          <div class="reason" data-testid="rejection-reason">{{ b.rejectionReason }}</div>
        }

        <div class="kicker" style="margin-top: 22px;">Activity</div>
        <ul class="timeline">
          @for (e of activity(); track e.id) {
            <li>
              <div class="dot" [class]="'k-' + e.kind"></div>
              <div class="event">
                <div class="line">
                  <strong>{{ actorLabel(e.actorId) }}</strong> {{ verb(e.kind) }}
                  @if (e.kind === 'contributed' && e.amount) { <span class="note">— +\${{ e.amount }}</span> }
                  @if (e.note) { <span class="note">— {{ e.note }}</span> }
                </div>
                <div class="when">{{ e.at | relative }} ago</div>
              </div>
            </li>
          } @empty {
            <li class="event-empty">No activity yet.</li>
          }
        </ul>

        <div class="kicker" style="margin-top: 22px;">Comments</div>
        <ul class="comments" data-testid="comment-list">
          @for (c of comments(); track c.id) {
            <li>
              <app-avatar [initials]="cInitials(c)" [variant]="cVariant(c.authorUid)" size="sm" />
              <div class="cbody">
                <div class="chead">
                  <span class="cauthor">{{ c.authorUid === me().uid ? 'you' : c.authorDisplayName }}</span>
                  <span class="cwhen">{{ c.createdAt | relative }} ago@if (c.editedAt) { · edited }</span>
                </div>
                @if (editingId() === c.id) {
                  <textarea class="input cedit" rows="2" maxlength="500"
                            [(ngModel)]="editText" data-testid="comment-edit-input"></textarea>
                  <div class="cactions">
                    <button class="link" (click)="saveEdit(c)" data-testid="comment-edit-save">Save</button>
                    <button class="link muted" (click)="cancelEdit()">Cancel</button>
                  </div>
                } @else {
                  <div class="ctext">{{ c.text }}</div>
                  @if (c.authorUid === me().uid || canModerate()) {
                    <div class="cactions">
                      @if (c.authorUid === me().uid) {
                        <button class="link" (click)="startEdit(c)" data-testid="comment-edit">Edit</button>
                      }
                      <button class="link danger" (click)="removeComment(c)" data-testid="comment-delete">Delete</button>
                    </div>
                  }
                }
              </div>
            </li>
          } @empty {
            <li class="comment-empty" data-testid="comment-empty">No comments yet. Say something.</li>
          }
        </ul>

        <div class="comment-compose">
          <textarea class="input" rows="2" maxlength="500" placeholder="Add a comment…"
                    [(ngModel)]="newComment" data-testid="comment-input"></textarea>
          <button class="btn" (click)="post()" [disabled]="!canPost() || commentBusy()"
                  data-testid="comment-submit">{{ commentBusy() ? '…' : 'Post' }}</button>
        </div>

        <div class="action-bar">
          @switch (cta()) {
            @case ('claim') {
              <button class="btn full" (click)="claim()" data-testid="cta-claim">Claim this bounty</button>
            }
            @case ('submit') {
              <button class="btn full" (click)="goSubmit()" data-testid="cta-submit">Submit proof</button>
            }
            @case ('review') {
              <button class="btn full" (click)="goReview()" data-testid="cta-review">Review submission</button>
            }
            @case ('view') {
              <button class="btn full ghost" disabled data-testid="cta-view">{{ stateLabel() }}</button>
            }
          }
          <div style="height: 8px;"></div>
          <button class="btn full ghost" (click)="share()" data-testid="cta-share">Share</button>
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
    .kv-value .kv-pts {
      font-size: 12px; color: var(--muted); font-weight: 500;
      font-family: 'Plus Jakarta Sans';
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
    .timeline .k-contributed { background: var(--primary); }
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

    .contrib-list { list-style: none; padding: 0; margin: 0; }
    .contrib-list li {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; background: var(--bg-2); border-radius: 10px;
      margin-bottom: 6px; font-size: 13px;
    }
    .contrib-list .cname { font-weight: 600; }
    .contrib-list .camount {
      font-family: 'Bricolage Grotesque'; font-weight: 700;
    }

    .contribute { display: flex; align-items: stretch; gap: 8px; }
    .contribute .price-input { position: relative; flex: 1; }
    .contribute .price-input .prefix {
      position: absolute; left: 14px; top: 12px;
      font-weight: 700; color: var(--muted);
    }
    .contribute .price-input .input {
      width: 100%; padding-left: 26px;
      font-family: 'Bricolage Grotesque'; font-weight: 700; font-size: 18px;
    }
    .contribute .btn { white-space: nowrap; }

    .comments { list-style: none; padding: 0; margin: 0 0 12px; }
    .comments li { display: flex; gap: 10px; padding: 10px 0; }
    .comments .cbody { flex: 1; min-width: 0; }
    .comments .chead { display: flex; align-items: baseline; gap: 8px; }
    .comments .cauthor { font-weight: 700; font-size: 13px; }
    .comments .cwhen {
      font-size: 11px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
    }
    .comments .ctext {
      font-size: 14px; line-height: 1.5; color: var(--ink-2);
      margin-top: 2px; white-space: pre-wrap; word-break: break-word;
    }
    .comments .cedit { width: 100%; margin-top: 4px; }
    .comments .cactions { display: flex; gap: 12px; margin-top: 4px; }
    .comments .link {
      background: none; border: none; padding: 0; cursor: pointer;
      font-size: 12px; color: var(--primary); font-weight: 600;
    }
    .comments .link.danger { color: var(--danger); }
    .comments .link.muted { color: var(--muted); }
    .comment-empty {
      list-style: none;
      font-size: 12px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      padding: 8px 0;
    }
    .comment-compose { display: flex; align-items: flex-start; gap: 8px; }
    .comment-compose .input { flex: 1; resize: vertical; }
    .comment-compose .btn { white-space: nowrap; }
  `],
})
export class BountyDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly data = inject(DataService);
  private readonly toast = inject(ToastService);
  // The signal, not a one-time snapshot: on a deep-link the app-user profile
  // resolves asynchronously, so reading it eagerly could freeze `me` as the
  // signed-out placeholder (uid === '') for the component's lifetime.
  protected readonly me = this.data.me;

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

  protected readonly contributions = toSignal(
    this.route.paramMap.pipe(
      switchMap((p) => {
        const gid = p.get('groupId');
        const bid = p.get('bountyId');
        return gid && bid ? this.data.getContributions(gid, bid) : of([]);
      }),
    ),
    { initialValue: [] },
  );

  /** Money can be pooled only onto an available cash bounty. */
  protected canContribute = computed(() => {
    const b = this.bounty();
    return !!b && b.state === 'available' && b.rewardType === 'cash';
  });

  protected addAmount = signal<number>(5);
  protected addBusy = signal(false);
  protected canAddAmount = computed(() => {
    const n = Number(this.addAmount());
    return Number.isInteger(n) && n >= 1 && n <= 100000;
  });

  protected poster = computed(() => {
    const b = this.bounty();
    return b ? this.data.userById(b.posterId) : undefined;
  });
  protected claimant = computed(() => {
    const b = this.bounty();
    return b?.claimantId ? this.data.userById(b.claimantId) : undefined;
  });

  protected cta = computed<'claim' | 'submit' | 'review' | 'view'>(() => {
    const b = this.bounty();
    if (!b) return 'view';
    const meId = this.me().uid;
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
    if (b.state === 'claimed' && b.claimantId !== this.me().uid)        return 'Claimed by someone else';
    if (b.state === 'pending_review' && b.posterId !== this.me().uid)   return 'Awaiting OP decision';
    if (b.state === 'available' && b.posterId === this.me().uid)        return 'You posted this — wait for a claim';
    return 'View only';
  });

  protected kvRight(): string {
    const b = this.bounty()!;
    if (b.state === 'successful') return 'Won';
    if (b.state === 'failed')     return 'Lost';
    return new CountdownPipe().transform(b.expiresAt);
  }

  /** Reward label: `$amount` for cash, the freeform text for custom. */
  protected reward(b: { rewardType: string; price: number; rewardText?: string }): string {
    return b.rewardType === 'custom' ? b.rewardText ?? '—' : `$${b.price}`;
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

  protected async addToBounty(): Promise<void> {
    const b = this.bounty();
    if (!b || !this.canAddAmount()) return;
    this.addBusy.set(true);
    try {
      const { total } = await this.data.contributeToBounty(b.id, Math.floor(Number(this.addAmount())));
      this.toast.success(`Added to the pot — now $${total}.`);
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    } finally {
      this.addBusy.set(false);
    }
  }

  /** Contributor row label: "you" for self, else the cached/display name. */
  protected contributorLabel(c: Contribution): string {
    if (c.uid === this.me().uid) return 'you';
    return this.data.userById(c.uid)?.displayName ?? c.displayName ?? 'someone';
  }

  /* ── Comments ─────────────────────────────────────────────────────── */

  protected readonly comments = toSignal(
    this.route.paramMap.pipe(
      switchMap((p) => {
        const gid = p.get('groupId');
        const bid = p.get('bountyId');
        return gid && bid ? this.data.getComments(gid, bid) : of<Comment[]>([]);
      }),
    ),
    { initialValue: [] as Comment[] },
  );

  protected newComment = signal('');
  protected commentBusy = signal(false);
  protected editingId = signal<string | null>(null);
  protected editText = signal('');

  protected canPost = computed(() => {
    const t = this.newComment().trim();
    return t.length >= 1 && t.length <= 500;
  });

  /** Poster or group owner — shown a delete affordance on every comment. */
  protected canModerate = computed(() => {
    const b = this.bounty();
    if (!b) return false;
    const meId = this.me().uid;
    return b.posterId === meId || this.data.groupById(b.groupId)?.ownerId === meId;
  });

  protected async post(): Promise<void> {
    const b = this.bounty();
    if (!b || !this.canPost()) return;
    this.commentBusy.set(true);
    try {
      await this.data.postComment(b.groupId, b.id, this.newComment());
      this.newComment.set('');
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    } finally {
      this.commentBusy.set(false);
    }
  }

  protected startEdit(c: Comment): void {
    this.editingId.set(c.id);
    this.editText.set(c.text);
  }
  protected cancelEdit(): void {
    this.editingId.set(null);
    this.editText.set('');
  }
  protected async saveEdit(c: Comment): Promise<void> {
    const b = this.bounty();
    const t = this.editText().trim();
    if (!b || t.length < 1 || t.length > 500) return;
    try {
      await this.data.editComment(b.groupId, b.id, c.id, t);
      this.editingId.set(null);
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    }
  }
  protected async removeComment(c: Comment): Promise<void> {
    const b = this.bounty();
    if (!b) return;
    try {
      await this.data.deleteComment(b.groupId, b.id, c.id);
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    }
  }

  /** Avatar initials/variant for a comment author — prefer the live member doc. */
  protected cInitials(c: Comment): string {
    return this.data.userById(c.authorUid)?.initials ?? initialsOf(c.authorDisplayName);
  }
  protected cVariant(uid: string): 1 | 2 | 3 | 4 | 5 {
    return this.data.userById(uid)?.avatarVariant ?? pickVariant(uid);
  }

  protected goSubmit(): void {
    const b = this.bounty();
    if (b) this.router.navigate(['/g', b.groupId, 'b', b.id, 'submit']);
  }

  protected goReview(): void {
    this.router.navigate(['/reviews'], { queryParams: { id: this.bounty()?.id } });
  }

  protected async share(): Promise<void> {
    const b = this.bounty();
    if (!b) return;
    const url = window.location.href;
    const title = b.title;
    const text = `${b.title} — ${this.reward(b)} bounty`;
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title, text, url });
        return;
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      this.toast.success('Link copied to clipboard.');
    } catch {
      this.toast.error('Could not share or copy link.');
    }
  }

  protected actorLabel(uid: string): string {
    if (uid === 'system') return 'System';
    if (uid === this.me().uid) return 'you';
    return this.data.userById(uid)?.handle ?? 'someone';
  }

  protected verb(kind: string): string {
    return {
      created: 'created this bounty',
      claimed: 'claimed it',
      contributed: 'added to the pot',
      submitted: 'submitted proof',
      approved: 'approved it',
      rejected: 'rejected it',
      expired: 'auto-expired',
    }[kind] ?? kind;
  }

}
