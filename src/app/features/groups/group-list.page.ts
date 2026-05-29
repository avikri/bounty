import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DataService } from '../../core/data.service';
import { AvatarComponent } from '../../shared/avatar.component';
import { IconComponent } from '../../shared/icon.component';
import { ToastService } from '../../shared/toast.service';

type Dialog = 'none' | 'create' | 'join';

@Component({
  selector: 'app-group-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FormsModule, AvatarComponent, IconComponent],
  template: `
    <div class="wrap">
      <div class="topbar">
        <div>
          <h2>Groups</h2>
          <div class="sub">{{ groups().length }} active · {{ unreadTotal() }} unread</div>
        </div>
        <app-avatar [initials]="me().initials" [variant]="me().avatarVariant" />
      </div>

      @for (g of groups(); track g.id) {
        <a class="group-card" [routerLink]="['/g', g.id]">
          <div class="emoji-tile" [class]="'tone-' + g.surfaceTone">{{ g.emoji }}</div>
          <div class="meat">
            <div class="name">{{ g.name }}</div>
            <div class="meta">{{ g.memberIds.length }} members · {{ rankBlurb(g.id) }}</div>
          </div>
          @if (g.unreadCount > 0) {
            <div class="unread">{{ g.unreadCount }}</div>
          }
        </a>
      } @empty {
        <div class="empty">No groups yet. Create one or join with a code.</div>
      }

      <div class="ctas">
        <button class="btn full" (click)="dialog.set('create')" [disabled]="busy()">
          <app-icon name="plus" [size]="16" />
          Create group
        </button>
        <div style="height: 8px;"></div>
        <button class="btn full ghost" (click)="dialog.set('join')" [disabled]="busy()">
          Join by code
        </button>
      </div>
    </div>

    @if (dialog() === 'create') {
      <div class="modal-bg" (click)="closeDialog()">
        <div class="modal" (click)="$event.stopPropagation()">
          <h3>New group</h3>
          <label class="label">Name</label>
          <input class="input" [(ngModel)]="newName" placeholder="Team WFH" maxlength="60" />
          <div class="gap"></div>
          <label class="label">Emoji</label>
          <input class="input emoji-input" [(ngModel)]="newEmoji" maxlength="4" placeholder="👥" />
          <div class="row-end">
            <button class="btn ghost" (click)="closeDialog()" [disabled]="busy()">Cancel</button>
            <button class="btn" (click)="submitCreate()" [disabled]="busy() || !newName().trim()">
              {{ busy() ? 'Creating…' : 'Create' }}
            </button>
          </div>
        </div>
      </div>
    }

    @if (dialog() === 'join') {
      <div class="modal-bg" (click)="closeDialog()">
        <div class="modal" (click)="$event.stopPropagation()">
          <h3>Join a group</h3>
          <label class="label">Invite code</label>
          <input class="input code-input" [(ngModel)]="joinCode" placeholder="ABC123" maxlength="6" />
          <div class="row-end">
            <button class="btn ghost" (click)="closeDialog()" [disabled]="busy()">Cancel</button>
            <button class="btn" (click)="submitJoin()" [disabled]="busy() || !joinCode().trim()">
              {{ busy() ? 'Joining…' : 'Join' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .wrap { padding: 18px 20px 32px; max-width: 720px; margin: 0 auto; }
    .topbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 4px 14px;
    }
    .topbar h2 { font-size: 26px; }
    .sub {
      font-size: 12px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      margin-top: 2px;
    }

    .group-card {
      display: flex; align-items: center; gap: 12px;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--r-lg);
      padding: 14px;
      margin-bottom: 10px;
      box-shadow: var(--shadow-1);
      transition: transform .08s ease, box-shadow .15s ease;
    }
    .group-card:hover { transform: translateY(-1px); box-shadow: var(--shadow-2); }
    .emoji-tile {
      width: 44px; height: 44px; border-radius: 14px;
      display: grid; place-items: center;
      font-size: 22px;
    }
    .tone-primary { background: var(--primary-soft); }
    .tone-info    { background: var(--info-soft); }
    .tone-success { background: var(--success-soft); }
    .tone-purple  { background: var(--purple-soft); }
    .tone-warn    { background: var(--warn-soft); }
    .meat { flex: 1; }
    .name { font-weight: 700; font-size: 15px; }
    .meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .unread {
      background: var(--primary); color: white;
      font-weight: 700; font-size: 11px;
      padding: 3px 8px; border-radius: 999px;
    }
    .ctas { margin-top: 18px; }

    .empty {
      padding: 28px 18px; text-align: center; color: var(--muted);
      font-family: 'JetBrains Mono', monospace; font-size: 13px;
      border: 1px dashed var(--line-2); border-radius: var(--r-lg);
      margin-bottom: 10px;
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
      width: min(420px, 100%);
      box-shadow: 0 10px 40px rgba(0,0,0,.2);
    }
    .modal h3 { margin: 0 0 14px; font-size: 18px; }
    .gap { height: 12px; }
    .row-end { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
    .code-input { text-transform: uppercase; letter-spacing: 0.18em; font-family: 'JetBrains Mono', monospace; }
    .emoji-input { width: 80px; font-size: 22px; text-align: center; }
  `],
})
export class GroupListPage {
  private readonly data = inject(DataService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  protected readonly groups = this.data.groups;
  protected readonly me = this.data.me;
  protected readonly unreadTotal = computed(() =>
    this.groups().reduce((s, g) => s + g.unreadCount, 0),
  );
  protected readonly dialog = signal<Dialog>('none');
  protected readonly busy = signal(false);

  protected newName = signal('');
  protected newEmoji = signal('👥');
  protected joinCode = signal('');

  rankBlurb(groupId: string): string {
    const board = this.data.leaderboard(groupId);
    const mine = board.find((b) => b.userId === this.data.currentUserId);
    if (!mine) return 'newbie';
    const medal = mine.rank === 1 ? ' 🥇' : '';
    return `you're #${mine.rank}${medal}`;
  }

  closeDialog(): void {
    if (this.busy()) return;
    this.dialog.set('none');
  }

  async submitCreate(): Promise<void> {
    const name = this.newName().trim();
    if (!name) return;
    this.busy.set(true);
    try {
      const res = await this.data.createGroup({ name, emoji: this.newEmoji() });
      this.dialog.set('none');
      this.newName.set(''); this.newEmoji.set('👥');
      this.toast.success(`Group created — invite code ${res.inviteCode}`);
      this.router.navigate(['/g', res.groupId]);
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }

  async submitJoin(): Promise<void> {
    const code = this.joinCode().trim().toUpperCase();
    if (!code) return;
    this.busy.set(true);
    try {
      const res = await this.data.joinGroup(code);
      this.dialog.set('none');
      this.joinCode.set('');
      this.toast.success(res.alreadyMember ? 'You were already a member.' : 'Joined!');
      this.router.navigate(['/g', res.groupId]);
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
