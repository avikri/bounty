import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs';
import { NavigationEnd } from '@angular/router';
import { DataService } from '../core/data.service';
import { IconComponent } from '../shared/icon.component';
import { ToastHostComponent } from '../shared/toast.service';

@Component({
  selector: 'app-shell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent, ToastHostComponent],
  template: `
    <div class="shell">
      <!-- Desktop sidebar -->
      <aside class="sidebar">
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
            <span class="badge">{{ pendingCount() }}</span>
          }
        </a>
        <a class="nav-item" routerLink="/u/me" routerLinkActive="active">
          <app-icon name="me" [size]="16" />
          Profile
        </a>
      </aside>

      <main class="main">
        <router-outlet />
      </main>

      <!-- Mobile bottom tab bar -->
      <nav class="tabbar">
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
        <a class="tab post" [routerLink]="postRoute()">
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
    .main {
      padding: 0 0 80px;
      max-width: 100vw;
    }
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
    }
  `],
})
export class AppShellComponent {
  private readonly data = inject(DataService);
  private readonly router = inject(Router);

  protected readonly groups = this.data.groups;
  protected readonly pendingCount = computed(() => this.data.pendingReviewsForMe().length);

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
