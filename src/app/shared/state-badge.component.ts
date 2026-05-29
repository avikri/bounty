import { ChangeDetectionStrategy, Component, Input, computed, signal } from '@angular/core';
import { BountyState } from '../core/models';

const LABEL: Record<BountyState, string> = {
  available: 'Available',
  claimed: 'In progress',
  pending_review: 'Pending review',
  successful: 'Successful',
  failed: 'Failed',
  expired: 'Expired',
};

const CLS: Record<BountyState, string> = {
  available: 's-available',
  claimed: 's-claimed',
  pending_review: 's-pending',
  successful: 's-success',
  failed: 's-failed',
  expired: 's-failed',
};

@Component({
  selector: 'app-state-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="state-badge" [class]="cls()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        @switch (state()) {
          @case ('available') {
            <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>
          }
          @case ('claimed') {
            <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>
          }
          @case ('pending_review') {
            <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>
          }
          @case ('successful') {
            <path d="M20 7 9 18l-5-5"/>
          }
          @case ('failed') {
            <path d="M18 6 6 18M6 6l12 12"/>
          }
          @default {
            <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
          }
        }
      </svg>
      {{ overrideLabel ?? label() }}
    </span>
  `,
})
export class StateBadgeComponent {
  protected readonly state = signal<BountyState>('available');
  @Input({ required: true }) set bountyState(v: BountyState) { this.state.set(v); }
  @Input() overrideLabel?: string;
  protected readonly label = computed(() => LABEL[this.state()]);
  protected readonly cls = computed(() => CLS[this.state()]);
}
