import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs';
import { NavigationEnd } from '@angular/router';
import { DataService } from '../core/data.service';
import { IconComponent } from '../shared/icon.component';
import { AvatarComponent } from '../shared/avatar.component';
import { RelativePipe } from '../shared/countdown.pipe';
import { ToastHostComponent } from '../shared/toast.service';

@Component({
  selector: 'app-shell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent, AvatarComponent, RelativePipe, ToastHostComponent],
  template: `
    <div class="shell">
      <!-- Desktop sidebar -->
      <aside class="sidebar" data-testid="sidebar">
        <a class="brand" routerLink="/groups">Bounty<span>.</span></a>

        <div class="sec-label">Groups</div>
        @for (g of groups(); track g.id) {
          <a class="nav-item" [routerLink]="['/g', g.id]" routerLinkActive="active">
            <span class="emoji">{{ g.emoji }}</span>
            {{ g.name }}
          </a>
        }

        <div class="sec-label" style="margin-top: 18px;">Personal</div>
        <a class="nav-item" routerLink="/reviews" routerLinkActive="active">
          <app-icon name="reviews" [size]="16" />
          Reviews
          @if (pendingCount() > 0) {
            <span class="badge" data-testid="reviews-badge">{{ pendingCount() }}</span>
          }
        </a>
        <a class="nav-item" routerLink="/inbox" routerLinkActive="active">
          <app-icon name="inbox" [size]="16" />
          Inbox
          @if (unreadCount() > 0) {
            <span class="badge">{{ unreadCount() }}</span>
          }
        </a>
        <a class="nav-item" routerLink="/u/me" routerLinkActive="active">
          <app-icon name="me" [size]="16" />
          Profile
        </a>
      </aside>

      <!-- Mobile floating notification bell -->
      <a class="bell" routerLink="/inbox" aria-label="Notifications" data-testid="bell">
        <app-icon name="bell" [size]="20" />
        @if (unreadCount() > 0) {
          <span class="bell-badge" data-testid="bell-badge">{{ unreadCount() > 99 ? '99+' : unreadCount() }}</span>
        }
      </a>

      <main class="main">
        <router-outlet />
      </main>

      <!-- Desktop right rail (contextual cards) -->
      <aside class="rail" data-testid="rail">
        @if (railLeaderboard().length) {
          <div class="rail-card">
            <h4>Top in {{ currentGroup()?.name ?? 'group' }}</h4>
            @for (e of railLeaderboard(); track e.userId) {
              <div class="rail-row">
                <span class="rank" [class.gold]="e.rank === 1" [class.silver]="e.rank === 2" [class.bronze]="e.rank === 3">{{ e.rank }}</span>
                <app-avatar [initials]="e.user.initials" [variant]="e.user.avatarVariant" size="sm" />
                <span class="rail-name">{{ e.userId === me().uid ? 'you' : e.user.handle }}</span>
                <span class="rail-num">{{ e.points }}</span>
              </div>
            }
            <a class="rail-link" [routerLink]="ranksRoute()">View full leaderboard →</a>
          </div>
        }

        <div class="rail-card">
          <h4>Inbox @if (unreadCount() > 0) { <span class="rail-badge">{{ unreadCount() }}</span> }</h4>
          @for (n of railNotifs(); track n.id) {
            <a class="rail-notif" [class.unread]="!n.read" routerLink="/inbox">
              <div class="rail-notif-title">{{ n.title }}</div>
              <div class="rail-notif-body">{{ n.body }}</div>
              <div class="rail-notif-when">{{ n.createdAt | relative }} ago</div>
            </a>
          } @empty {
            <div class="rail-empty">No notifications.</div>
          }
          <a class="rail-link" routerLink="/inbox">Open inbox →</a>
        </div>

        @if (iouSummary().length) {
          <div class="rail-card">
            <h4>Your IOUs</h4>
            @for (row of iouSummary(); track row.counterparty.uid) {
              <div class="rail-row">
                <app-avatar [initials]="row.counterparty.initials" [variant]="row.counterparty.avatarVariant" size="sm" />
                <span class="rail-name">{{ row.net >= 0 ? row.counterparty.handle + ' owes you' : 'you owe ' + row.counterparty.handle }}</span>
                <span class="rail-num" [class.pos]="row.net > 0" [class.neg]="row.net < 0">
                  {{ row.net >= 0 ? '+$' + row.net : '−$' + (-row.net) }}
                </span>
              </div>
            }
            <a class="rail-link" routerLink="/u/me">Manage IOUs →</a>
          </div>
        }
      </aside>

      <!-- Mobile bottom tab bar -->
      <nav class="tabbar" data-testid="tabbar">
        <a class="tab" routerLink="/groups" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: false }">
          <app-icon name="groups" [size]="22" />
          <span>Groups</span>
        </a>
        <a class="tab" routerLink="/reviews" routerLinkActive="active">
          <app-icon name="reviews" [size]="22" />
          <span>Reviews</span>
          @if (pendingCount() > 0) {
            <span class="tab-badge">{{ pendingCount() }}</span>
          }
        </a>
        <a class="tab post" [routerLink]="postRoute()" data-testid="tab-post">
          <app-icon name="post" [size]="22" />
          <span>Post</span>
        </a>
        <a class="tab" [routerLink]="ranksRoute()" routerLinkActive="active">
          <app-icon name="ranks" [size]="22" />
          <span>Ranks</span>
        </a>
        <a class="tab" routerLink="/u/me" routerLinkActive="active">
          <app-icon name="me" [size]="22" />
          <span>Me</span>
        </a>
      </nav>

      <app-toast-host />
    </div>
  `,
  styles: [`
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 1fr;
    }
    .sidebar { display: none; }
    .rail { display: none; }
    .main {
      padding: 0 0 80px;
      max-width: 100vw;
    }

    /* Right-rail cards (only rendered at the wide breakpoint) */
    .rail-card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--r-lg);
      padding: 16px;
    }
    .rail-card h4 {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px; color: var(--muted);
      text-transform: uppercase; letter-spacing: 0.08em;
      margin: 0 0 10px; font-weight: 500;
      display: flex; align-items: center; gap: 8px;
    }
    .rail-badge {
      background: var(--primary); color: white;
      font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 999px;
      letter-spacing: 0;
    }
    .rail-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; }
    .rail-row .rank {
      width: 24px; height: 24px; border-radius: 999px;
      background: var(--bg-3); display: grid; place-items: center;
      font-weight: 800; font-size: 11px; color: var(--ink-2); flex-shrink: 0;
    }
    .rail-row .rank.gold   { background: oklch(0.88 0.13 90); color: oklch(0.32 0.12 70); }
    .rail-row .rank.silver { background: oklch(0.88 0.01 80); color: oklch(0.35 0.01 75); }
    .rail-row .rank.bronze { background: oklch(0.82 0.10 50); color: oklch(0.32 0.13 45); }
    .rail-name { flex: 1; font-weight: 600; font-size: 13px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rail-num { font-family: 'Bricolage Grotesque'; font-weight: 700; font-size: 14px; }
    .rail-num.pos { color: var(--success); }
    .rail-num.neg { color: var(--danger); }
    .rail-link { display: block; margin-top: 8px; color: var(--primary-deep); font-size: 12px; font-weight: 700; }

    .rail-notif {
      display: block; padding: 8px 0; border-bottom: 1px solid var(--line);
      text-decoration: none;
    }
    .rail-notif:last-of-type { border-bottom: 0; }
    .rail-notif-title { font-size: 12px; font-weight: 700; color: var(--ink); }
    .rail-notif.unread .rail-notif-title { color: var(--primary-deep); }
    .rail-notif-body { font-size: 12px; color: var(--ink-2); line-height: 1.4; margin: 1px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rail-notif-when { font-size: 10px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
    .rail-empty { font-size: 12px; color: var(--muted); font-family: 'JetBrains Mono', monospace; padding: 6px 0; }
    .tabbar {
      position: fixed;
      bottom: 12px;
      left: 12px;
      right: 12px;
      height: 62px;
      background: var(--card);
      border-radius: 22px;
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      box-shadow: 0 -2px 12px rgba(40,30,15,.04), 0 8px 24px rgba(40,30,15,.08);
      border: 1px solid var(--line);
      z-index: 50;
    }
    .tab {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      color: var(--muted); font-size: 10px; font-weight: 600; gap: 3px;
      position: relative;
      text-decoration: none;
    }
    .tab.active, .tab.active app-icon { color: var(--primary-deep); }
    .tab.active app-icon { color: var(--primary); }
    .tab.post app-icon { color: var(--primary); }
    .tab-badge {
      position: absolute; top: 8px; right: calc(50% - 22px);
      background: var(--danger); color: white;
      font-size: 9px; font-weight: 700;
      padding: 1px 5px; border-radius: 999px;
    }
    .bell {
      position: fixed; top: 12px; right: 12px;
      width: 40px; height: 40px; border-radius: 999px;
      background: var(--card); border: 1px solid var(--line);
      box-shadow: var(--shadow-1);
      display: grid; place-items: center;
      color: var(--ink); z-index: 55;
    }
    .bell-badge {
      position: absolute; top: -4px; right: -4px;
      background: var(--danger); color: white;
      font-size: 9px; font-weight: 700; line-height: 1;
      padding: 2px 5px; border-radius: 999px;
      border: 1.5px solid var(--bg);
    }
    @media (min-width: 960px) {
      .shell {
        grid-template-columns: 240px 1fr;
      }
      .sidebar {
        display: block;
        position: sticky; top: 0;
        height: 100vh;
        padding: 22px 18px;
        border-right: 1px solid var(--line);
        background: var(--card);
      }
      .brand {
        font-family: 'Bricolage Grotesque'; font-weight: 800; font-size: 24px;
        display: block; margin-bottom: 22px;
      }
      .brand span { color: var(--primary); }
      .sec-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; color: var(--muted);
        text-transform: uppercase; letter-spacing: 0.08em;
        margin: 14px 0 8px;
        font-weight: 500;
      }
      .nav-item {
        display: flex; align-items: center; gap: 10px;
        padding: 9px 11px; border-radius: 10px;
        font-size: 13px; font-weight: 600; color: var(--ink-2);
        margin-bottom: 2px; cursor: pointer;
      }
      .nav-item.active { background: var(--primary-soft); color: var(--primary-deep); }
      .nav-item .emoji { font-size: 14px; }
      .nav-item .badge {
        margin-left: auto; background: var(--primary); color: white;
        font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 999px;
      }
      .main { padding: 0; }
      .tabbar { display: none; }
      .bell { display: none; }
    }
    /* Third pane appears once there's room for it. */
    @media (min-width: 1200px) {
      .shell { grid-template-columns: 240px minmax(0, 1fr) 320px; }
      .rail {
        display: flex; flex-direction: column; gap: 16px;
        padding: 22px 18px;
        height: 100vh; position: sticky; top: 0;
        overflow-y: auto;
        border-left: 1px solid var(--line);
        background: var(--bg);
      }
    }
  `],
})
export class AppShellComponent {
  private readonly data = inject(DataService);
  private readonly router = inject(Router);

  protected readonly groups = this.data.groups;
  protected readonly me = this.data.me;
  protected readonly pendingCount = computed(() => this.data.pendingReviewsForMe().length);
  protected readonly unreadCount = this.data.unreadCount;

  protected readonly currentGroup = computed(() => this.data.groupById(this.currentGroupId()));
  protected readonly railLeaderboard = computed(() => this.data.leaderboard(this.currentGroupId()).slice(0, 4));
  protected readonly railNotifs = computed(() => this.data.notifications().slice(0, 4));
  protected readonly iouSummary = computed(() =>
    this.data.myIous().filter((r) => r.net !== 0).slice(0, 4),
  );

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: '/' },
  );

  /** Find the most relevant group context based on current url, falling back to first group */
  private currentGroupId = computed(() => {
    const m = /\/g\/([^/]+)/.exec(this.url());
    if (m && m[1]) return m[1];
    return this.data.groups()[0]?.id ?? 'g-office';
  });

  protected postRoute = computed(() => ['/g', this.currentGroupId(), 'new']);
  protected ranksRoute = computed(() => ['/g', this.currentGroupId(), 'leaderboard']);
}
