import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  Output,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import type {
  Stripe,
  StripeElements,
  StripePaymentElement,
} from '@stripe/stripe-js';
import { StripeService } from '../../core/stripe.service';

/**
 * Modal that collects card details with a Stripe Payment Element and confirms a
 * PaymentIntent created server-side. Driven entirely by the per-payment
 * `clientSecret`; the publishable key is the only Stripe key in the client.
 *
 * The IOU is NOT marked settled here — settlement is the webhook's job. On a
 * successful (or `processing`) confirmation we just emit `paid` and close; the
 * profile page's real-time listener flips the IOU to "Settled by card" once
 * `payment_intent.succeeded` lands. 3D Secure is handled inline via
 * `redirect: 'if_required'`, so the SPA never navigates away.
 */
@Component({
  selector: 'app-card-payment-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop" (click)="onBackdrop()">
      <div class="sheet" (click)="$event.stopPropagation()" role="dialog" aria-modal="true"
           data-testid="card-payment-dialog">
        <div class="head">
          <div class="title">Pay by card</div>
          <div class="amt">{{ amountLabel }}</div>
        </div>

        @if (loadError()) {
          <div class="banner error" data-testid="card-load-error">{{ loadError() }}</div>
        }

        <!-- Stripe mounts the Payment Element into this host. -->
        <div #paymentElement class="pe-host" [class.hidden]="!ready()"></div>

        @if (!ready() && !loadError()) {
          <div class="loading" data-testid="card-loading">Loading secure card form…</div>
        }

        @if (payError()) {
          <div class="banner error" data-testid="card-pay-error">{{ payError() }}</div>
        }

        <div class="actions">
          <button class="btn ghost" (click)="cancel.emit()" [disabled]="processing()">
            Cancel
          </button>
          <button class="btn primary" (click)="pay()"
                  [disabled]="!ready() || processing()"
                  data-testid="card-pay-submit">
            {{ processing() ? 'Processing…' : 'Pay ' + amountLabel }}
          </button>
        </div>
        <div class="fine">Payments are processed securely by Stripe. Test mode.</div>
      </div>
    </div>
  `,
  styles: [`
    .backdrop {
      position: fixed; inset: 0; z-index: 200;
      background: rgba(20, 14, 6, 0.5);
      display: grid; place-items: center; padding: 16px;
    }
    .sheet {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--r-lg);
      box-shadow: 0 20px 60px rgba(40, 30, 15, 0.25);
      width: min(440px, 100%);
      padding: 18px;
    }
    .head {
      display: flex; align-items: baseline; justify-content: space-between;
      margin-bottom: 14px;
    }
    .title {
      font-family: 'Bricolage Grotesque'; font-weight: 800; font-size: 18px;
      letter-spacing: -0.02em;
    }
    .amt {
      font-family: 'Bricolage Grotesque'; font-weight: 700; font-size: 18px;
      color: var(--primary-deep);
    }
    .pe-host { min-height: 40px; margin-bottom: 12px; }
    .pe-host.hidden { display: none; }
    .loading {
      padding: 18px; text-align: center; color: var(--muted);
      font-family: 'JetBrains Mono', monospace; font-size: 13px;
    }
    .banner {
      border-radius: 12px; padding: 10px 12px; font-size: 13px; margin-bottom: 12px;
    }
    .banner.error { background: var(--danger-soft); color: var(--danger); border: 1px solid var(--danger); }
    .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
    .fine {
      margin-top: 10px; text-align: center; color: var(--muted);
      font-size: 11px; font-family: 'JetBrains Mono', monospace;
    }
    .btn.primary {
      background: var(--primary); color: #fff; border: 0;
      padding: 9px 16px; border-radius: 12px; font-weight: 700; cursor: pointer;
    }
    .btn.ghost {
      background: var(--bg-3); color: var(--ink); border: 1px solid var(--line);
      padding: 9px 16px; border-radius: 12px; font-weight: 600; cursor: pointer;
    }
    .btn:disabled { opacity: 0.6; cursor: default; }
  `],
})
export class CardPaymentDialogComponent implements AfterViewInit, OnDestroy {
  private readonly stripeSvc = inject(StripeService);

  /** Per-payment client secret returned by createIouPaymentIntent. */
  @Input({ required: true }) clientSecret!: string;
  /** Pre-formatted amount label (e.g. "$10.00 NZD"). */
  @Input({ required: true }) amountLabel = '';

  /** Emitted once the payment is confirmed (succeeded or processing). */
  @Output() paid = new EventEmitter<void>();
  /** Emitted when the user dismisses the dialog without paying. */
  @Output() cancel = new EventEmitter<void>();

  @ViewChild('paymentElement') private hostRef!: ElementRef<HTMLDivElement>;

  protected readonly ready = signal(false);
  protected readonly processing = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly payError = signal<string | null>(null);

  private stripe: Stripe | null = null;
  private elements: StripeElements | null = null;
  private paymentElement: StripePaymentElement | null = null;

  async ngAfterViewInit(): Promise<void> {
    try {
      this.stripe = await this.stripeSvc.getStripe();
      if (!this.stripe) {
        this.loadError.set('Card payments are unavailable right now.');
        return;
      }
      this.elements = this.stripe.elements({ clientSecret: this.clientSecret });
      this.paymentElement = this.elements.create('payment');
      this.paymentElement.mount(this.hostRef.nativeElement);
      this.paymentElement.on('ready', () => this.ready.set(true));
    } catch {
      this.loadError.set('Could not load the secure card form. Try again.');
    }
  }

  ngOnDestroy(): void {
    this.paymentElement?.destroy();
  }

  async pay(): Promise<void> {
    if (!this.stripe || !this.elements || this.processing()) return;
    this.processing.set(true);
    this.payError.set(null);
    try {
      // redirect:'if_required' keeps 3DS inline — the auth step pops in a modal
      // and we only navigate away if the payment method truly demands it.
      const { error, paymentIntent } = await this.stripe.confirmPayment({
        elements: this.elements,
        confirmParams: { return_url: window.location.href },
        redirect: 'if_required',
      });

      if (error) {
        // Card declined, auth failed, or validation — let them retry.
        this.payError.set(error.message ?? 'Your payment could not be completed.');
        this.processing.set(false);
        return;
      }

      const status = paymentIntent?.status;
      if (status === 'succeeded' || status === 'processing') {
        // Settlement happens via the webhook; the listener will update the pill.
        this.paid.emit();
        return;
      }

      this.payError.set('Payment was not completed. Please try again.');
      this.processing.set(false);
    } catch {
      this.payError.set('Something went wrong confirming your payment.');
      this.processing.set(false);
    }
  }

  onBackdrop(): void {
    if (!this.processing()) this.cancel.emit();
  }
}
