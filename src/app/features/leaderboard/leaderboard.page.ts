import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { DataService } from '../../core/data.service';
import { AvatarComponent } from '../../shared/avatar.component';
import { LeaderboardEntry } from '../../core/models';

type Range = 'all' | 'month' | 'week';

@Component({
  selector: 'app-leaderboard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent],
  template: `
    @if (group(); as g) {
      <div class="wrap">
        <div class="topbar">
          <div>
            <h2>Leaderboard</h2>
            <div class="sub">{{ shortName(g.name) }} · {{ rangeLabel() }}</div>
          </div>
          <app-avatar [initials]="me().initials" [variant]="me().avatarVariant" />
        </div>

        <div class="range-tabs">
          @for (r of ranges; track r.key) {
            <button class="pill" [class.active]="range() === r.key" (click)="range.set(r.key)"
                    [attr.data-testid]="'range-' + r.key" [attr.data-active]="range() === r.key">{{ r.label }}</button>
          }
        </div>

        @if (top3(); as t) {
          <div class="podium" data-testid="podium">
            @if (t[1]) {
              <div class="podium-cell silver" data-testid="podium-2" [attr.data-uid]="t[1].user.uid">
                <app-avatar [initials]="t[1].user.initials" [variant]="t[1].user.avatarVariant" size="lg" />
                <div class="name">{{ t[1].user.handle }}</div>
                <div class="pts mid">{{ t[1].points }}</div>
                <div class="medal silver-medal">2nd</div>
              </div>
            }
            @if (t[0]) {
              <div class="podium-cell gold" data-testid="podium-1" [attr.data-uid]="t[0].user.uid">
                <app-avatar [initials]="t[0].user.initials" [variant]="t[0].user.avatarVariant" size="xl" />
                <div class="name big">{{ t[0].user.uid === me().uid ? 'you (' + t[0].user.handle + ')' : t[0].user.handle }}</div>
                <div class="pts big">{{ t[0].points }}</div>
                <div class="medal gold-medal">🥇 1st</div>
              </div>
            }
            @if (t[2]) {
              <div class="podium-cell bronze" data-testid="podium-3" [attr.data-uid]="t[2].user.uid">
                <app-avatar [initials]="t[2].user.initials" [variant]="t[2].user.avatarVariant" size="lg" />
                <div class="name">{{ t[2].user.handle }}</div>
                <div class="pts mid">{{ t[2].points }}</div>
                <div class="medal bronze-medal">3rd</div>
              </div>
            }
          </div>
        }

        <div class="table-wrap">
          <div class="table-header">
            <div>Rank</div>
            <div>Member</div>
            <div class="num">Wins</div>
            <div class="num">Losses</div>
            <div class="num">Net IOU</div>
            <div class="num">Points</div>
          </div>
          @for (e of rest(); track e.userId) {
            <div class="table-row" data-testid="lb-row" [attr.data-uid]="e.userId">
              <div><div class="rank">{{ e.rank }}</div></div>
              <div class="member">
                <app-avatar [initials]="e.user.initials" [variant]="e.user.avatarVariant" size="sm" />
                {{ e.user.handle }}
              </div>
              <div class="num win">{{ e.wins }}</div>
              <div class="num loss">{{ e.losses }}</div>
              <div class="num iou">{{ formatIou(e.netIou) }}</div>
              <div class="num pts" [class.neg]="e.points < 0">{{ e.points }}</div>
            </div>
          }
          @if (rest().length === 0 && !top3()[0]) {
            <div class="empty">No one on the board yet — be the first to win a bounty.</div>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    .wrap { padding: 18px 0 100px; max-width: 1180px; margin: 0 auto; }
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 4px 20px 16px; }
    .topbar h2 { font-size: 22px; }
    .sub { font-size: 12px; color: var(--muted); font-family: 'JetBrains Mono', monospace; margin-top: 2px; }

    .range-tabs {
      display: flex; gap: 6px;
      padding: 0 20px 14px;
    }

    .podium {
      background: linear-gradient(180deg, var(--primary-soft) 0%, var(--bg) 100%);
      padding: 22px 16px 24px;
      margin-bottom: 14px;
      display: grid;
      grid-template-columns: 1fr 1.15fr 1fr;
      gap: 12px;
      align-items: end;
    }
    .podium-cell { text-align: center; }
    .podium-cell.gold { padding-bottom: 8px; }
    .podium-cell app-avatar { margin: 0 auto 8px; display: block; }
    .name { font-weight: 700; font-size: 13px; }
    .name.big { font-size: 15px; }
    .pts {
      font-family: 'Bricolage Grotesque';
      font-weight: 700; letter-spacing: -0.02em;
      color: var(--ink-2);
    }
    .pts.mid { font-size: 20px; }
    .pts.big { font-size: 28px; color: var(--ink); }
    .medal {
      display: inline-block; margin-top: 6px;
      font-size: 10px; font-weight: 800;
      padding: 2px 10px; border-radius: 999px;
    }
    .gold-medal   { background: oklch(0.88 0.13 90); color: oklch(0.32 0.12 70); }
    .silver-medal { background: oklch(0.88 0.01 80); color: oklch(0.35 0.01 75); }
    .bronze-medal { background: oklch(0.82 0.10 50); color: oklch(0.32 0.13 45); }

    .table-wrap {
      margin: 0 20px;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--r-lg);
      overflow: hidden;
    }
    .table-header {
      display: grid; grid-template-columns: 60px 1fr 64px 64px 80px 80px;
      padding: 12px 16px;
      background: var(--bg-2);
      font-size: 10px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase; letter-spacing: 0.06em; font-weight: 500;
      border-bottom: 1px solid var(--line);
    }
    .table-header .num { text-align: right; }
    .table-row {
      display: grid; grid-template-columns: 60px 1fr 64px 64px 80px 80px;
      padding: 12px 16px;
      align-items: center;
      border-bottom: 1px solid var(--line);
      font-size: 13px;
    }
    .table-row:last-child { border-bottom: 0; }
    .table-row .num { text-align: right; font-family: 'Bricolage Grotesque'; font-weight: 600; }
    .table-row .win { color: var(--success); }
    .table-row .loss { color: var(--danger); }
    .table-row .pts { font-size: 16px; font-weight: 700; }
    .table-row .pts.neg { color: var(--danger); }
    .member { display: flex; align-items: center; gap: 8px; font-weight: 600; }

    .empty {
      padding: 28px 18px;
      text-align: center;
      color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
    }

    @media (min-width: 720px) {
      .table-header {
        grid-template-columns: 60px 1fr 80px 80px 100px 100px;
        padding: 14px 20px;
        font-size: 11px;
      }
      .table-row {
        grid-template-columns: 60px 1fr 80px 80px 100px 100px;
        padding: 14px 20px;
        font-size: 14px;
      }
    }

    @media (min-width: 960px) {
      .wrap { padding: 28px 0 60px; }
      .podium { padding: 28px 24px; border-radius: var(--r-lg); margin: 0 32px 22px; max-width: 540px; }
      .podium { grid-template-columns: 1fr 1.15fr 1fr; }
      .table-wrap { margin: 0 32px; }
    }
  `],
})
export class LeaderboardPage {
  private readonly route = inject(ActivatedRoute);
  private readonly data = inject(DataService);

  protected readonly me = this.data.me;
  protected readonly range = signal<Range>('all');
  protected readonly ranges: { key: Range; label: string }[] = [
    { key: 'all', label: 'All time' }, { key: 'month', label: 'Month' }, { key: 'week', label: 'Week' },
  ];

  private readonly params = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });
  protected group = computed(() => this.data.groupById(this.params().get('groupId') ?? ''));

  private board = computed<LeaderboardEntry[]>(() => {
    const g = this.group();
    return g ? this.data.leaderboard(g.id) : [];
  });

  protected top3 = computed(() => {
    const b = this.board();
    return [b[0], b[1], b[2]] as const;
  });

  protected rest = computed(() => this.board().slice(3));

  protected rangeLabel(): string {
    return this.range() === 'all' ? 'all time' : this.range() === 'month' ? 'this month' : 'this week';
  }

  shortName(name: string): string { return name.split(' ')[0] ?? name; }

  formatIou(n: number): string {
    if (n === 0) return '$0';
    return (n > 0 ? '+$' : '−$') + Math.abs(n);
  }
}
