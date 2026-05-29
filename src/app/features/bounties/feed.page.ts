import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { DataService } from '../../core/data.service';
import { AvatarComponent } from '../../shared/avatar.component';
import { BountyCardComponent } from '../../shared/bounty-card.component';
import { IconComponent } from '../../shared/icon.component';
import { BountyState } from '../../core/models';

type FilterKey = 'all' | 'available' | 'claimed' | 'pending_review' | 'mine';

@Component({
  selector: 'app-bounty-feed',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AvatarComponent, BountyCardComponent, IconComponent],
  template: `
    @if (group(); as g) {
      <div class="wrap">
        <!-- mobile-only header (desktop uses sidebar) -->
        <div class="mobile-head">
          <div class="topbar">
            <div>
              <h2>
                <span class="emoji">{{ g.emoji }}</span>
                {{ shortName(g.name) }}
              </h2>
              <div class="sub">{{ g.memberIds.length }} members · {{ activeCount() }} active</div>
            </div>
            <app-avatar [initials]="me().initials" [variant]="me().avatarVariant" />
          </div>
        </div>

        <!-- desktop header -->
        <div class="dt-head">
          <div>
            <div class="row">
              <span class="emoji-big">{{ g.emoji }}</span>
              <h1>{{ g.name }}</h1>
            </div>
            <div class="sub">{{ g.memberIds.length }} members · {{ activeCount() }} active bounties · {{ rankBlurb() }}</div>
          </div>
          <div style="display:flex;gap:8px;">
            <a class="btn ghost" [routerLink]="['/g', g.id, 'settings']">Settings</a>
            <button class="btn" (click)="goCreate()">
              <app-icon name="plus" [size]="14" />
              Post bounty
            </button>
          </div>
        </div>

        <div class="filters">
          @for (f of filters(); track f.key) {
            <button
              class="pill"
              [class.active]="filter() === f.key"
              (click)="filter.set(f.key)"
            >
              {{ f.label }}@if (f.count !== undefined) { · {{ f.count }} }
            </button>
          }
        </div>

        <div class="cards">
          @for (b of visibleBounties(); track b.id) {
            <app-bounty-card [bounty]="b" />
          } @empty {
            <div class="empty">
              @if (filter() === 'all') {
                No bounties yet — post the first one.
              } @else {
                No bounties match this filter.
              }
            </div>
          }
        </div>

        <!-- mobile FAB -->
        <button class="fab" (click)="goCreate()" aria-label="Post bounty">
          <app-icon name="plus" [size]="22" />
        </button>
      </div>
    } @else {
      <div class="wrap"><p>Group not found.</p></div>
    }
  `,
  styles: [`
    .wrap { padding: 18px 20px 100px; max-width: 1180px; margin: 0 auto; position: relative; }

    .mobile-head { display: block; }
    .dt-head { display: none; }

    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 12px; }
    .topbar h2 { font-size: 22px; display: flex; align-items: center; gap: 8px; }
    .topbar .emoji { font-size: 22px; }
    .sub { font-size: 12px; color: var(--muted); font-family: 'JetBrains Mono', monospace; margin-top: 2px; }

    .filters {
      display: flex; gap: 6px; margin-bottom: 14px;
      overflow-x: auto; padding-bottom: 4px;
      scrollbar-width: none;
    }
    .filters::-webkit-scrollbar { display: none; }

    .empty {
      padding: 36px 18px; text-align: center; color: var(--muted);
      font-family: 'JetBrains Mono', monospace; font-size: 13px;
      border: 1px dashed var(--line-2); border-radius: var(--r-lg);
    }

    .fab {
      position: fixed; right: 22px; bottom: 90px;
      width: 56px; height: 56px; border-radius: 18px;
      background: var(--primary); color: white;
      border: 0; cursor: pointer;
      display: grid; place-items: center;
      box-shadow: 0 1px 0 oklch(0.50 0.180 45), 0 8px 24px rgba(249,115,22,.30);
      z-index: 40;
    }

    @media (min-width: 960px) {
      .wrap { padding: 28px 32px 60px; }
      .mobile-head { display: none; }
      .dt-head {
        display: flex; align-items: end; justify-content: space-between;
        gap: 16px; margin-bottom: 18px;
      }
      .dt-head .row { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
      .dt-head .emoji-big { font-size: 26px; }
      .dt-head h1 { font-size: 28px; }
      .dt-head .sub { font-size: 13px; color: var(--muted); margin-top: 4px; }

      .cards {
        display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
      }
      .cards app-bounty-card ::ng-deep .bounty-card { margin: 0; }
      .fab { display: none; }
    }
  `],
})
export class BountyFeedPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly data = inject(DataService);

  protected readonly me = this.data.me;
  protected readonly filter = signal<FilterKey>('all');

  /**
   * Filter pills with live counts. A computed so the counts recompute as
   * bounties stream in from Firestore — touching `bountiesInGroup` (which reads
   * the bounties signal) registers the dependency.
   */
  protected readonly filters = computed<{ key: FilterKey; label: string; count?: number }[]>(() => {
    const id = this.group()?.id ?? '';
    return [
      { key: 'all',            label: 'All',         count: this.data.bountiesInGroup(id).length },
      { key: 'available',      label: 'Available',   count: this.data.bountiesInGroup(id, 'available').length },
      { key: 'claimed',        label: 'In progress', count: this.data.bountiesInGroup(id, 'claimed').length },
      { key: 'pending_review', label: 'Pending',     count: this.data.bountiesInGroup(id, 'pending_review').length },
      { key: 'mine',           label: 'Mine' },
    ];
  });

  private readonly groupId = toSignal(
    this.route.paramMap, { initialValue: this.route.snapshot.paramMap },
  );

  protected group = computed(() => {
    const id = this.groupId().get('groupId') ?? '';
    return this.data.groupById(id);
  });

  protected activeCount = computed(() =>
    this.data.bountiesInGroup(this.group()?.id ?? '').filter(
      (b) => b.state !== 'successful' && b.state !== 'failed' && b.state !== 'expired',
    ).length,
  );

  protected readonly visibleBounties = computed(() => {
    const id = this.group()?.id ?? '';
    const f = this.filter();
    if (f === 'all') return this.data.bountiesInGroup(id);
    if (f === 'mine') return this.data.bountiesInGroup(id, 'mine');
    return this.data.bountiesInGroup(id, f as BountyState);
  });

  protected goCreate(): void {
    const id = this.group()?.id;
    if (id) this.router.navigate(['/g', id, 'new']);
  }

  protected shortName(name: string): string {
    return name.split(' ')[0] ?? name;
  }

  protected rankBlurb(): string {
    const g = this.group();
    if (!g) return '';
    const board = this.data.leaderboard(g.id);
    const mine = board.find((b) => b.userId === this.data.currentUserId);
    if (!mine) return 'unranked';
    return `you're #${mine.rank}${mine.rank === 1 ? ' 🥇' : ''}`;
  }
}
