import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page" data-testid="login-page">
      <div class="frame">
        <div class="spacer"></div>
        <h1 class="wordmark">Bounty<span>.</span></h1>
        <p class="lede">Dares with a price tag. Your group, your rules, your shame.</p>
        <div style="flex: 1;"></div>
        <button class="btn full dark" [disabled]="busy()" (click)="signInGoogle()" data-testid="login-google">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="white"><path d="M19.5 13.5h-7v-3h4a4 4 0 1 0-1.2-2.8l-2-2A6.99 6.99 0 1 1 19.5 13.5z"/></svg>
          Continue with Google
        </button>
        <div style="height: 10px;"></div>
        @if (error()) {
          <div class="err">{{ error() }}</div>
        }
        <div style="height: 24px;"></div>
        <p class="terms">By continuing you agree to the <u>Terms</u> &amp; <u>Privacy</u>.</p>
        <div style="height: 12px;"></div>
      </div>
    </div>
  `,
  styles: [`
    .page {
      min-height: 100vh;
      background: var(--bg);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .frame {
      display: flex; flex-direction: column;
      width: 100%;
      max-width: 360px;
      min-height: 540px;
    }
    .spacer { height: 60px; }
    .wordmark {
      font-family: 'Bricolage Grotesque';
      font-size: clamp(48px, 12vw, 64px);
      font-weight: 800;
      line-height: 0.9;
      letter-spacing: -0.03em;
      margin: 0;
    }
    .wordmark span { color: var(--primary); }
    .lede {
      margin-top: 16px;
      font-size: 16px;
      color: var(--ink-2);
      text-wrap: pretty;
    }
    .terms {
      text-align: center;
      font-size: 11px;
      color: var(--muted);
      margin: 0;
    }
    .err {
      margin-top: 14px;
      padding: 10px 12px;
      border-radius: 10px;
      background: var(--danger-soft);
      color: var(--danger);
      font-size: 12px;
      text-align: center;
    }
  `],
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  async signInGoogle(): Promise<void> {
    await this.runSignIn(() => this.auth.signInWithGoogle());
  }

  async signInApple(): Promise<void> {
    await this.runSignIn(() => this.auth.signInWithApple());
  }

  private async runSignIn(fn: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await fn();
      const redirect = this.route.snapshot.queryParamMap.get('redirect');
      this.router.navigateByUrl(redirect && redirect.startsWith('/') ? redirect : '/groups');
    } catch (e) {
      const msg = (e as { code?: string; message?: string }).code
        ?? (e as Error).message
        ?? 'Sign-in failed.';
      this.error.set(msg);
    } finally {
      this.busy.set(false);
    }
  }
}
