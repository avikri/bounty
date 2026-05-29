import { ChangeDetectionStrategy, Component, Input, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Bounty } from '../core/models';
import { DataService } from '../core/data.service';
import { AvatarComponent } from './avatar.component';
import { StateBadgeComponent } from './state-badge.component';
import { CountdownPipe, RelativePipe } from './countdown.pipe';
import { IconComponent } from './icon.component';

@Component({
  selector: 'app-bounty-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AvatarComponent, StateBadgeComponent, CountdownPipe, RelativePipe, IconComponent],
  template: `
    <a class="bounty-card" [class.muted]="isResolved()" [routerLink]="['/g', bounty.groupId, 'b', bounty.id]">
      <div class="row1">
        <app-state-badge [bountyState]="bounty.state" />
        @if (bounty.state === 'successful') {
          <div class="price success">+\${{ bounty.price }}</div>
        } @else if (bounty.state === 'failed') {
          <div class="price danger">−{{ bounty.price }} pts</div>
        } @else if (bounty.state === 'expired') {
          <div class="price expired">
            <app-icon name="lock" [size]="14" />
            \${{ bounty.price }}
          </div>
        } @else {
          <div class="price">\${{ bounty.price }}<small> · {{ bounty.price }} pts</small></div>
        }
      </div>
      <div class="title-line">{{ bounty.title }}</div>
      <div class="row2">
        @if (poster(); as p) {
          <app-avatar [initials]="p.initials" [variant]="p.avatarVariant" size="sm" />
          <span>{{ posterLabel() }} · {{ bounty.createdAt | relative }}</span>
        }
        @if (rightCaption(); as c) {
          <span class="dot"></span>
          <span>{{ c }}</span>
        }
      </div>
    </a>
  `,
  styles: [`
    .bounty-card {
      display: block;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--r-lg);
      padding: 14px;
      box-shadow: var(--shadow-1);
      margin-bottom: 12px;
      color: inherit;
      transition: transform .08s ease, box-shadow .15s ease;
    }
    .bounty-card:hover { transform: translateY(-1px); box-shadow: var(--shadow-2); }
    .bounty-card.muted {
      opacity: 0.7;
      background: var(--bg-2);
      box-shadow: none;
    }
    .bounty-card.muted:hover { transform: none; box-shadow: none; opacity: 0.85; }
    .row1 {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px; margin-bottom: 8px;
    }
    .price {
      font-family: 'Bricolage Grotesque';
      font-weight: 700; font-size: 22px;
      color: var(--ink); letter-spacing: -0.02em;
    }
    .price.success { color: var(--success); }
    .price.danger  { color: var(--danger); }
    .price.expired { color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
    .price small { font-size: 12px; color: var(--muted); font-weight: 500; font-family: 'Plus Jakarta Sans'; }
    .title-line {
      font-size: 14px; font-weight: 600; color: var(--ink); line-height: 1.35;
      margin-bottom: 8px;
    }
    .row2 {
      display: flex; align-items: center; gap: 8px;
      font-size: 11px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
    }
    .row2 .dot { width: 3px; height: 3px; border-radius: 999px; background: var(--muted); }
  `],
})
export class BountyCardComponent {
  private readonly data = inject(DataService);
  @Input({ required: true }) bounty!: Bounty;

  isResolved(): boolean {
    return this.bounty.state === 'expired'
      || this.bounty.state === 'failed'
      || this.bounty.state === 'successful';
  }

  poster() {
    return this.data.userById(this.bounty.posterId);
  }

  posterLabel(): string {
    return this.bounty.posterId === this.data.currentUserId ? 'you' : this.poster()?.handle ?? 'unknown';
  }

  rightCaption(): string | null {
    const b = this.bounty;
    if (b.state === 'available') return new Date(b.expiresAt).getTime() > Date.now()
      ? this.daysLeft(b.expiresAt) : 'expired';
    if (b.state === 'claimed')   return b.claimantId === this.data.currentUserId ? 'claimed by you' : 'claimed';
    if (b.state === 'pending_review') return 'awaiting OP';
    return null;
  }

  private daysLeft(d: Date): string {
    const ms = new Date(d).getTime() - Date.now();
    const days = Math.floor(ms / 86400000);
    if (days >= 1) return `${days}d left`;
    const hours = Math.max(1, Math.floor(ms / 3600000));
    return `${hours}h left`;
  }
}
