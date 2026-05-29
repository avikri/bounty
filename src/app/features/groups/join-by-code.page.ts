import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { AuthService } from '../../core/auth.service';
import { DataService } from '../../core/data.service';
import { ToastService } from '../../shared/toast.service';

/**
 * /join/:code — auth-aware deep link. If signed in, calls joinGroup with the
 * code immediately. If not, redirects through login and resumes after sign-in.
 */
@Component({
  selector: 'app-join-by-code',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap" data-testid="join-page">
      <h2>Join via invite</h2>
      <p class="code">Code: <strong>{{ code() }}</strong></p>
      @if (status() === 'auth') {
        <p>Sign in to accept this invite.</p>
        <button class="btn" (click)="goLogin()">Sign in</button>
      } @else if (status() === 'joining') {
        <p>Joining…</p>
      } @else if (status() === 'error') {
        <p class="err">{{ error() }}</p>
        <button class="btn ghost" (click)="goGroups()">Go to groups</button>
      }
    </div>
  `,
  styles: [`
    .wrap { padding: 36px 20px; max-width: 420px; margin: 0 auto; text-align: center; }
    h2 { font-size: 22px; margin-bottom: 8px; }
    .code {
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 0.2em;
      color: var(--muted);
      margin-bottom: 18px;
    }
    .err {
      background: var(--danger-soft);
      color: var(--danger);
      padding: 12px;
      border-radius: 12px;
      font-size: 13px;
      margin-bottom: 14px;
    }
  `],
})
export class JoinByCodePage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly data = inject(DataService);
  private readonly toast = inject(ToastService);

  private readonly params = toSignal(
    this.route.paramMap,
    { initialValue: this.route.snapshot.paramMap },
  );
  protected readonly code = computed(() => (this.params().get('code') ?? '').toUpperCase());

  protected readonly status = signal<'idle' | 'auth' | 'joining' | 'error'>('idle');
  protected readonly error = signal('');
  private attempted = false;

  constructor() {
    effect(() => {
      const code = this.code();
      const signedIn = this.auth.fbUser() !== null;
      if (!code) return;
      if (!signedIn) { this.status.set('auth'); return; }
      if (this.attempted) return;
      this.attempted = true;
      void this.tryJoin(code);
    }, { allowSignalWrites: true });
  }

  private async tryJoin(code: string): Promise<void> {
    this.status.set('joining');
    try {
      const res = await this.data.joinGroup(code);
      this.toast.success(res.alreadyMember ? 'You were already a member.' : 'Joined!');
      this.router.navigate(['/g', res.groupId]);
    } catch (e) {
      this.error.set(this.toast.formatError(e));
      this.status.set('error');
    }
  }

  goLogin(): void {
    this.router.navigate(['/login'], { queryParams: { redirect: `/join/${this.code()}` } });
  }

  goGroups(): void { this.router.navigate(['/groups']); }
}
