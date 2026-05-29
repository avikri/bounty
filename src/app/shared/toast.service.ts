import { ChangeDetectionStrategy, Component, Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();
  private nextId = 1;

  show(text: string, kind: Toast['kind'] = 'info', ttlMs = 4500): void {
    const id = this.nextId++;
    this._toasts.update((list) => [...list, { id, text, kind }]);
    setTimeout(() => this.dismiss(id), ttlMs);
  }

  error(text: string): void { this.show(text, 'error', 6000); }
  success(text: string): void { this.show(text, 'success'); }

  dismiss(id: number): void {
    this._toasts.update((list) => list.filter((t) => t.id !== id));
  }

  /** Format a Firebase callable / Firestore error into a user-friendly string. */
  formatError(err: unknown): string {
    const e = err as { code?: string; message?: string; details?: unknown };
    if (e?.code === 'permission-denied') return "You don't have access to that.";
    if (e?.code === 'unauthenticated')  return 'Please sign in again.';
    if (e?.code === 'not-found')        return 'That resource was not found.';
    if (typeof e?.message === 'string' && e.message.length > 0) return e.message;
    return 'Something went wrong.';
  }
}

@Component({
  selector: 'app-toast-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast-host" aria-live="polite">
      @for (t of toasts(); track t.id) {
        <div class="toast" [class.error]="t.kind === 'error'" [class.success]="t.kind === 'success'">
          <span class="text">{{ t.text }}</span>
          <button class="close" (click)="dismiss(t.id)" aria-label="Dismiss">×</button>
        </div>
      }
    </div>
  `,
  styles: [`
    .toast-host {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      bottom: 96px;
      z-index: 100;
      display: flex; flex-direction: column; gap: 8px;
      pointer-events: none;
      width: min(440px, calc(100vw - 32px));
    }
    .toast {
      pointer-events: auto;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 10px 12px;
      box-shadow: 0 10px 30px rgba(40,30,15,.12);
      font-size: 13px;
      display: flex; align-items: center; gap: 10px;
    }
    .toast.error   { border-color: var(--danger); background: var(--danger-soft); color: var(--danger); }
    .toast.success { border-color: var(--success); background: var(--success-soft); color: var(--success); }
    .text { flex: 1; line-height: 1.4; }
    .close {
      background: transparent; border: 0; cursor: pointer;
      font-size: 18px; line-height: 1;
      color: inherit; opacity: .65; padding: 0 4px;
    }
    @media (min-width: 960px) { .toast-host { bottom: 24px; } }
  `],
})
export class ToastHostComponent {
  constructor(private readonly toastSvc: ToastService) {}
  toasts = this.toastSvc.toasts;
  dismiss(id: number): void { this.toastSvc.dismiss(id); }
}
