import { Injectable } from '@angular/core';
import { loadStripe, Stripe } from '@stripe/stripe-js';
import { environment } from '../../environments/environment';

/**
 * Thin wrapper around Stripe.js for the client. Loads the SDK lazily from
 * js.stripe.com (never bundled — that's required for Stripe's PCI scope) and
 * only ever holds the *publishable* key. The secret key and webhook signing
 * secret live in Cloud Functions' Secret Manager and never reach the browser;
 * everything sensitive (creating the PaymentIntent, settling the IOU) happens
 * server-side. The client just collects card details and confirms the intent
 * with the per-payment `client_secret` handed back by createIouPaymentIntent.
 */
@Injectable({ providedIn: 'root' })
export class StripeService {
  private readonly publishableKey =
    (environment as { stripePublishableKey?: string }).stripePublishableKey ?? '';

  private stripePromise: Promise<Stripe | null> | null = null;

  /**
   * True when a publishable key is configured. The UI hides card-payment
   * affordances when this is false (e.g. the emulator/E2E build), falling back
   * to the cash settlement path.
   */
  isConfigured(): boolean {
    return this.publishableKey.length > 0;
  }

  /**
   * Resolve a singleton Stripe instance, loading the SDK on first use. Returns
   * null if no key is configured or the script fails to load — callers should
   * surface a friendly error and leave the cash path available.
   */
  async getStripe(): Promise<Stripe | null> {
    if (!this.isConfigured()) return null;
    if (!this.stripePromise) {
      this.stripePromise = loadStripe(this.publishableKey);
    }
    return this.stripePromise;
  }
}
