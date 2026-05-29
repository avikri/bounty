import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { DataService } from '../../core/data.service';
import { AvatarComponent } from '../../shared/avatar.component';
import { IconComponent } from '../../shared/icon.component';
import { ToastService } from '../../shared/toast.service';

@Component({
  selector: 'app-group-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FormsModule, AvatarComponent, IconComponent],
  template: `
    @if (group(); as g) {
      <div class="wrap">
        <div class="navrow">
          <a class="back" [routerLink]="['/g', g.id]"><app-icon name="back" [size]="16" /></a>
          <h2>{{ g.emoji }} {{ g.name }} settings</h2>
        </div>

        @if (!canEdit()) {
          <div class="note">You can view, but only owners and admins can change settings.</div>
        }

        <label class="label">Name</label>
        <input class="input" [(ngModel)]="nameDraft" [disabled]="!canEdit()" maxlength="60" />

        <div class="gap"></div>
        <label class="label">Emoji</label>
        <input class="input emoji" [(ngModel)]="emojiDraft" [disabled]="!canEdit()" maxlength="4" />

        <div class="gap"></div>
        <label class="label">Default bounty expiry (days)</label>
        <input class="input" type="number" min="1" max="60"
               [(ngModel)]="expiryDraft" [disabled]="!canEdit()" />

        <div class="gap"></div>
        @if (dirty()) {
          <button class="btn" (click)="save()" [disabled]="busy()">
            {{ busy() ? 'Saving…' : 'Save changes' }}
          </button>
          <button class="btn ghost" (click)="resetDrafts()" [disabled]="busy()">Cancel</button>
        }

        <div class="section">
          <div class="kicker">Invite code</div>
          <div class="code-row">
            <code data-testid="invite-code">{{ g.inviteCode }}</code>
            @if (canEdit()) {
              <button class="btn ghost" (click)="regenCode()" [disabled]="busy()" data-testid="regen-code">Regenerate</button>
            }
          </div>
          <div class="hint">Share this code, or the link below.</div>
          <code class="link">{{ joinLink(g.inviteCode) }}</code>
        </div>

        <div class="section">
          <div class="kicker">Members</div>
          @for (m of members(); track m.uid) {
            <div class="member-row" data-testid="member-row" [attr.data-uid]="m.uid">
              <app-avatar [initials]="m.initials" [variant]="m.avatarVariant" size="sm" />
              <div class="meat">
                <div class="name">{{ m.displayName }} <span class="muted">(&#64;{{ m.handle }})</span></div>
                <div class="sub">{{ m.points }} pts · {{ m.wins }}W / {{ m.losses }}L</div>
              </div>
              <span class="role role-{{ m.role }}" data-testid="member-role">{{ m.role }}</span>
              @if (isOwner() && m.uid !== g.ownerId) {
                @if (m.role === 'admin') {
                  <button class="btn ghost sm" (click)="setRole(m.uid, 'member')" [disabled]="busy()" data-testid="demote">Demote</button>
                } @else if (m.role === 'member') {
                  <button class="btn ghost sm" (click)="setRole(m.uid, 'admin')" [disabled]="busy()" data-testid="promote">Promote</button>
                }
              }
            </div>
          }
        </div>
      </div>
    } @else {
      <div class="wrap"><p>Group not found.</p></div>
    }
  `,
  styles: [`
    .wrap { padding: 16px 20px 60px; max-width: 720px; margin: 0 auto; }
    .navrow { display: flex; align-items: center; gap: 10px; padding: 4px 0 16px; }
    .back {
      width: 32px; height: 32px; border-radius: 10px;
      background: var(--bg-3); display: grid; place-items: center; color: var(--ink);
    }
    .navrow h2 { font-size: 18px; }

    .note {
      background: var(--bg-2);
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 13px;
      color: var(--muted);
      margin-bottom: 14px;
    }
    .label {
      display: block;
      font-size: 11px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
      margin: 0 0 6px;
    }
    .gap { height: 14px; }
    .emoji { width: 80px; font-size: 22px; text-align: center; }

    .section { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--line); }
    .kicker {
      font-size: 11px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
      margin-bottom: 10px;
    }
    .code-row {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 6px;
    }
    .code-row code {
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 0.2em;
      font-size: 18px; font-weight: 700;
    }
    .link { font-size: 12px; color: var(--muted); word-break: break-all; }
    .hint { font-size: 12px; color: var(--muted); margin-bottom: 4px; }

    .member-row {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 0; border-bottom: 1px solid var(--line);
    }
    .member-row:last-child { border-bottom: 0; }
    .meat { flex: 1; min-width: 0; }
    .meat .name { font-weight: 600; font-size: 13px; }
    .meat .muted { color: var(--muted); font-weight: 400; }
    .meat .sub { font-size: 11px; color: var(--muted); }
    .role {
      font-size: 10px; padding: 3px 8px; border-radius: 999px;
      text-transform: uppercase; font-weight: 700; letter-spacing: 0.04em;
    }
    .role-owner  { background: var(--primary-soft); color: var(--primary-deep); }
    .role-admin  { background: var(--info-soft); color: var(--info); }
    .role-member { background: var(--bg-2); color: var(--muted); }
    .btn.sm { padding: 6px 10px; font-size: 11px; }
  `],
})
export class GroupSettingsPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly data = inject(DataService);
  private readonly toast = inject(ToastService);

  private readonly params = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });
  protected group = computed(() => this.data.groupById(this.params().get('groupId') ?? ''));
  protected members = computed(() => {
    const g = this.group();
    return g ? this.data.membersOf(g.id) : [];
  });

  protected readonly nameDraft = signal('');
  protected readonly emojiDraft = signal('');
  protected readonly expiryDraft = signal(7);
  protected readonly busy = signal(false);

  protected readonly canEdit = computed(() => {
    const g = this.group();
    const uid = this.data.currentUserId;
    if (!g || !uid) return false;
    if (g.ownerId === uid) return true;
    const me = this.members().find((m) => m.uid === uid);
    return me?.role === 'admin';
  });

  protected readonly isOwner = computed(() => {
    const g = this.group();
    return !!g && g.ownerId === this.data.currentUserId;
  });

  protected readonly dirty = computed(() => {
    const g = this.group();
    if (!g) return false;
    return this.nameDraft() !== g.name ||
           this.emojiDraft() !== g.emoji ||
           this.expiryDraft() !== g.defaultExpiryDays;
  });

  constructor() {
    effect(() => {
      const g = this.group();
      if (!g) return;
      this.nameDraft.set(g.name);
      this.emojiDraft.set(g.emoji);
      this.expiryDraft.set(g.defaultExpiryDays);
    }, { allowSignalWrites: true });
  }

  resetDrafts(): void {
    const g = this.group();
    if (!g) return;
    this.nameDraft.set(g.name);
    this.emojiDraft.set(g.emoji);
    this.expiryDraft.set(g.defaultExpiryDays);
  }

  async save(): Promise<void> {
    const g = this.group();
    if (!g || !this.canEdit()) return;
    const patch: Partial<{ name: string; emoji: string; defaultExpiryDays: number }> = {};
    const name = this.nameDraft().trim();
    const emoji = this.emojiDraft().trim();
    const expiry = Number(this.expiryDraft());
    if (name && name !== g.name) patch.name = name.slice(0, 60);
    if (emoji && emoji !== g.emoji) patch.emoji = emoji.slice(0, 8);
    if (Number.isFinite(expiry) && expiry > 0 && expiry !== g.defaultExpiryDays) {
      patch.defaultExpiryDays = Math.min(60, Math.max(1, Math.floor(expiry)));
    }
    if (Object.keys(patch).length === 0) return;
    this.busy.set(true);
    try {
      await this.data.updateGroup(g.id, patch);
      this.toast.success('Settings saved');
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }

  async regenCode(): Promise<void> {
    const g = this.group();
    if (!g) return;
    this.busy.set(true);
    try {
      const res = await this.data.regenerateInviteCode(g.id);
      this.toast.success(`New invite code: ${res.inviteCode}`);
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }

  async setRole(uid: string, role: 'admin' | 'member'): Promise<void> {
    const g = this.group();
    if (!g) return;
    this.busy.set(true);
    try {
      await this.data.setMemberRole(g.id, uid, role);
      this.toast.success(`Role updated`);
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }

  joinLink(code: string): string {
    return `${window.location.origin}/join/${code}`;
  }
}
