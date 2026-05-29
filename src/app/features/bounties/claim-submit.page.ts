import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { DataService } from '../../core/data.service';
import { IconComponent } from '../../shared/icon.component';
import { ToastService } from '../../shared/toast.service';

@Component({
  selector: 'app-claim-submit',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FormsModule, IconComponent],
  template: `
    @if (bounty(); as b) {
      <div class="wrap">
        <div class="head">
          <a class="back" [routerLink]="['/g', b.groupId, 'b', b.id]"><app-icon name="back" [size]="16" /></a>
          <h2>Submit proof</h2>
          <span style="width: 32px;"></span>
        </div>

        <div class="bounty-summary">
          <div class="kicker">Bounty</div>
          <div class="title">{{ b.title }}</div>
          <div class="meta">\${{ b.price }} · posted by {{ poster()?.handle }}</div>
        </div>

        <label class="label">Proof (up to 3)</label>
        <div class="proof-grid">
          <div class="img-ph">photo</div>
          <div class="img-ph">photo</div>
          <div class="add-tile">
            <app-icon name="plus" [size]="22" />
          </div>
        </div>

        <label class="label">Note to OP <span class="muted">(optional)</span></label>
        <textarea class="input" rows="3" style="resize: none;" [(ngModel)]="note"
                  placeholder="Context, timestamps, witnesses..."></textarea>

        <div class="gap"></div>
        <div class="hint">
          <app-icon name="reviews" [size]="16" />
          <div>{{ poster()?.handle }} has <strong>48 hours</strong> to approve or reject. If they ghost, it auto-resolves.</div>
        </div>

        <div class="gap"></div>
        <button class="btn full" (click)="submit()">Submit for review</button>
      </div>
    } @else {
      <div class="wrap"><p>Bounty not found.</p></div>
    }
  `,
  styles: [`
    .wrap { padding: 16px 20px 32px; max-width: 520px; margin: 0 auto; }
    .head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 0 16px;
    }
    .head h2 { font-size: 17px; }
    .back {
      width: 32px; height: 32px; border-radius: 10px;
      background: var(--bg-3);
      display: grid; place-items: center;
      color: var(--ink);
    }

    .bounty-summary {
      background: var(--bg-2);
      border-radius: 14px;
      padding: 12px 14px;
      margin-bottom: 18px;
    }
    .bounty-summary .kicker {
      font-size: 11px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
      margin-bottom: 4px;
    }
    .bounty-summary .title { font-weight: 700; font-size: 14px; margin-bottom: 4px; }
    .bounty-summary .meta { font-size: 12px; color: var(--muted); }

    .proof-grid {
      display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;
      margin-bottom: 14px;
    }
    .proof-grid .img-ph { aspect-ratio: 1; }
    .add-tile {
      aspect-ratio: 1;
      border: 1.5px dashed var(--line-2);
      border-radius: 14px;
      display: grid; place-items: center;
      color: var(--muted);
      cursor: pointer;
    }

    .muted { color: var(--muted); font-weight: 500; }
    .gap { height: 14px; }

    .hint {
      background: var(--purple-soft);
      color: var(--purple);
      border-radius: 14px;
      padding: 12px 14px;
      font-size: 12px; line-height: 1.5;
      display: flex; align-items: flex-start; gap: 10px;
    }
    .hint app-icon { margin-top: 1px; flex-shrink: 0; }
  `],
})
export class ClaimSubmitPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly data = inject(DataService);
  private readonly toast = inject(ToastService);

  private readonly params = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });
  protected bounty = computed(() => this.data.bountyById(this.params().get('bountyId') ?? ''));
  protected poster = computed(() => {
    const b = this.bounty();
    return b ? this.data.userById(b.posterId) : undefined;
  });
  protected note = signal('');
  protected busy = signal(false);

  async submit(): Promise<void> {
    const b = this.bounty();
    if (!b || this.busy()) return;
    this.busy.set(true);
    try {
      await this.data.submitProof(b.id, this.note().trim());
      this.toast.success('Proof submitted — waiting on OP.');
      this.router.navigate(['/g', b.groupId, 'b', b.id]);
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
