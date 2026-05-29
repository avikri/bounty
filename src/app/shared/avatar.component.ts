import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

@Component({
  selector: 'app-avatar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="avatar" [class]="sizeClass + ' v' + variant">{{ initials }}</div>`,
  styles: [`
    .avatar {
      width: 36px; height: 36px; border-radius: 999px;
      background: linear-gradient(135deg, oklch(0.72 0.175 50), oklch(0.78 0.13 30));
      color: white; display: grid; place-items: center;
      font-weight: 700; font-size: 14px;
      flex-shrink: 0;
    }
    .avatar.sm { width: 28px; height: 28px; font-size: 12px; }
    .avatar.lg { width: 56px; height: 56px; font-size: 20px; }
    .avatar.xl { width: 64px; height: 64px; font-size: 22px; }
    .avatar.xxl { width: 80px; height: 80px; font-size: 26px; }
    .avatar.v2 { background: linear-gradient(135deg, oklch(0.65 0.140 240), oklch(0.78 0.13 280)); }
    .avatar.v3 { background: linear-gradient(135deg, oklch(0.68 0.155 150), oklch(0.78 0.13 120)); }
    .avatar.v4 { background: linear-gradient(135deg, oklch(0.62 0.170 300), oklch(0.78 0.13 320)); }
    .avatar.v5 { background: linear-gradient(135deg, oklch(0.78 0.165 88), oklch(0.78 0.13 60)); }
  `],
})
export class AvatarComponent {
  @Input({ required: true }) initials = '';
  @Input() variant: 1 | 2 | 3 | 4 | 5 = 1;
  @Input() size: 'sm' | 'md' | 'lg' | 'xl' | 'xxl' = 'md';

  get sizeClass(): string {
    return this.size === 'md' ? '' : this.size;
  }
}
