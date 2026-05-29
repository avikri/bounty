import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { DataService } from '../../core/data.service';
import { RelativePipe } from '../../shared/countdown.pipe';
import { ToastService } from '../../shared/toast.service';
import { AppNotification } from '../../core/models';

interface DayGroup {
  label: string;
  items: AppNotification[];
}

@Component({
  selector: 'app-inbox',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RelativePipe],
  template: `
    <div class="wrap">
      <div class="topbar">
        <div>
          <h2>Inbox</h2>
          <div class="sub">
            {{ unread() }} unread · {{ notifications().length }} total
          </div>
        </div>
        @if (unread() > 0) {
          <button class="btn ghost sm" (click)="markAll()">Mark all read</button>
        }
      </div>

      @for (group of grouped(); track group.label) {
        <div class="day-label">{{ group.label }}</div>
        @for (n of group.items; track n.id) {
          <button
            class="notif"
            [class.unread]="!n.read"
            (click)="open(n)"
          >
            <span class="dot" [class]="'k-' + n.kind"></span>
            <div class="meat">
              <div class="row1">
                <span class="title">{{ n.title }}</span>
                <span class="when">{{ n.createdAt | relative }} ago</span>
              </div>
              <div class="body">{{ n.body }}</div>
            </div>
            @if (!n.read) { <span class="unread-pip" aria-label="unread"></span> }
          </button>
        }
      } @empty {
        <div class="empty">No notifications yet.</div>
      }
    </div>
  `,
  styles: [`
    .wrap { padding: 18px 20px 100px; max-width: 720px; margin: 0 auto; }
    .topbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 4px 16px;
    }
    .topbar h2 { font-size: 22px; }
    .sub { font-size: 12px; color: var(--muted); font-family: 'JetBrains Mono', monospace; margin-top: 2px; }
    .btn.sm { padding: 8px 12px; font-size: 12px; }

    .day-label {
      font-size: 11px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
      margin: 14px 0 8px;
    }

    .notif {
      width: 100%;
      display: flex; align-items: flex-start; gap: 12px;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--r-lg);
      padding: 14px;
      margin-bottom: 8px;
      box-shadow: var(--shadow-1);
      cursor: pointer;
      text-align: left;
      font-family: inherit;
      position: relative;
      transition: transform .08s ease, box-shadow .15s ease;
    }
    .notif:hover { transform: translateY(-1px); box-shadow: var(--shadow-2); }
    .notif.unread { background: var(--primary-soft); border-color: var(--primary-soft); }

    .dot {
      width: 10px; height: 10px; border-radius: 999px;
      background: var(--muted); flex-shrink: 0; margin-top: 5px;
    }
    .dot.k-bounty_claimed  { background: var(--info); }
    .dot.k-proof_submitted { background: var(--purple); }
    .dot.k-bounty_approved { background: var(--success); }
    .dot.k-bounty_resolved { background: var(--success); }
    .dot.k-bounty_rejected { background: var(--danger); }
    .dot.k-iou_marked      { background: var(--warn); }
    .dot.k-iou_settled     { background: var(--success); }

    .meat { flex: 1; min-width: 0; }
    .row1 { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
    .title { font-weight: 700; font-size: 14px; }
    .notif.unread .title { color: var(--primary-deep); }
    .when { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; flex-shrink: 0; }
    .body { font-size: 13px; color: var(--ink-2); line-height: 1.45; margin-top: 2px; }

    .unread-pip {
      position: absolute; top: 14px; right: 14px;
      width: 8px; height: 8px; border-radius: 999px; background: var(--primary);
    }

    .empty {
      padding: 36px 18px; text-align: center; color: var(--muted);
      font-family: 'JetBrains Mono', monospace; font-size: 13px;
      border: 1px dashed var(--line-2); border-radius: var(--r-lg);
    }
  `],
})
export class InboxPage {
  private readonly data = inject(DataService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  protected readonly notifications = this.data.notifications;
  protected readonly unread = this.data.unreadCount;

  protected readonly grouped = computed<DayGroup[]>(() => {
    const groups: DayGroup[] = [];
    let current: DayGroup | null = null;
    for (const n of this.notifications()) {
      const label = this.dayLabel(n.createdAt);
      if (!current || current.label !== label) {
        current = { label, items: [] };
        groups.push(current);
      }
      current.items.push(n);
    }
    return groups;
  });

  private dayLabel(d: Date): string {
    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const dayMs = 86_400_000;
    const t = d.getTime();
    if (t >= startOfToday) return 'Today';
    if (t >= startOfToday - dayMs) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  protected async open(n: AppNotification): Promise<void> {
    if (!n.read) {
      this.markNotificationRead(n.id);
    }
    if (n.groupId && n.bountyId) {
      this.router.navigate(['/g', n.groupId, 'b', n.bountyId]);
    } else if (n.groupId) {
      this.router.navigate(['/g', n.groupId]);
    } else if (n.iouId) {
      this.router.navigate(['/u', 'me']);
    }
  }

  private markNotificationRead(nid: string): void {
    this.data.markNotificationRead(nid).catch((e) => this.toast.error(this.toast.formatError(e)));
  }

  protected async markAll(): Promise<void> {
    try {
      await this.data.markAllRead();
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    }
  }
}
