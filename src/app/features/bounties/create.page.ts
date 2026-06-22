import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { DataService } from '../../core/data.service';
import { ToastService } from '../../shared/toast.service';

const MAX_TITLE = 80;
const MAX_DESCRIPTION = 1000;
const MAX_REWARD = 10;
const MAX_POINTS = 1000;

@Component({
  selector: 'app-create-bounty',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (group(); as g) {
      <div class="wrap">
        <div class="head">
          <button class="link" (click)="cancel()">Cancel</button>
          <h2>New bounty</h2>
          <span class="link mute">Draft</span>
        </div>

        <label class="label">Title <span class="cap">{{ title().length }}/{{ MAX_TITLE }}</span></label>
        <input class="input" [(ngModel)]="title" placeholder="What's the dare?" [maxlength]="MAX_TITLE" data-testid="bounty-title" />
        <div class="gap"></div>

        <label class="label">The fine print <span class="cap">{{ description().length }}/{{ MAX_DESCRIPTION }}</span></label>
        <textarea class="input" rows="3" style="resize: none;" [(ngModel)]="description"
                  [maxlength]="MAX_DESCRIPTION"
                  placeholder="Rules, proof requirements, witness clauses..." data-testid="bounty-description"></textarea>
        <div class="gap"></div>

        <label class="label">Reward type</label>
        <div class="seg" role="tablist">
          <button type="button" class="seg-btn" [class.on]="rewardType() === 'cash'"
                  (click)="rewardType.set('cash')" data-testid="reward-type-cash">Cash</button>
          <button type="button" class="seg-btn" [class.on]="rewardType() === 'custom'"
                  (click)="rewardType.set('custom')" data-testid="reward-type-custom">Custom</button>
        </div>
        <div class="gap"></div>

        @if (rewardType() === 'cash') {
          <div class="row2">
            <div>
              <label class="label">Price</label>
              <div class="price-input">
                <span class="prefix">$</span>
                <input class="input" type="number" [(ngModel)]="price" min="1" step="1" data-testid="bounty-price" />
              </div>
            </div>
            <div>
              <label class="label">Expires</label>
              <input class="input" type="date" [(ngModel)]="expires" data-testid="bounty-expires" />
            </div>
          </div>
        } @else {
          <label class="label">Reward <span class="cap">{{ rewardText().length }}/{{ MAX_REWARD }}</span></label>
          <input class="input" [(ngModel)]="rewardText" placeholder="e.g. 3 beers"
                 [maxlength]="MAX_REWARD" data-testid="bounty-reward-text" />
          <div class="gap"></div>
          <div class="row2">
            <div>
              <label class="label">Points</label>
              <input class="input" type="number" [(ngModel)]="points" min="1" max="1000" step="1" data-testid="bounty-points" />
            </div>
            <div>
              <label class="label">Expires</label>
              <input class="input" type="date" [(ngModel)]="expires" data-testid="bounty-expires" />
            </div>
          </div>
        }

        <div class="gap"></div>

        <label class="toggle-row">
          <span class="toggle-label">Require photo / video proof</span>
          <input type="checkbox" [(ngModel)]="proofRequired" />
          <span class="toggle-pill"></span>
        </label>

        <div class="gap"></div>

        <div class="payout-hint">
          @if (rewardType() === 'cash') {
            If approved, you'll owe the claimant <strong>\${{ price() || 0 }}</strong> (settled offline) and they'll earn <strong>{{ price() || 0 }} points</strong>.
          } @else {
            If approved, you'll owe the claimant <strong>{{ rewardText() || 'the reward' }}</strong> (settled offline, no card payment) and they'll earn <strong>{{ points() || 0 }} points</strong>.
          }
        </div>

        <div class="gap"></div>
        <button class="btn full" (click)="submit()" [disabled]="!canSubmit()" data-testid="submit-bounty">Post to {{ shortName(g.name) }}</button>
      </div>
    } @else {
      <div class="wrap"><p>Group not found.</p></div>
    }
  `,
  styles: [`
    .wrap { padding: 16px 20px 32px; max-width: 520px; margin: 0 auto; }
    .head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 0 18px;
    }
    .head h2 { font-size: 18px; }
    .link {
      background: transparent; border: 0; cursor: pointer;
      font-size: 14px; font-weight: 600; color: var(--ink);
      font-family: inherit;
    }
    .link.mute { color: var(--muted); }

    .gap { height: 14px; }

    .seg {
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
      background: var(--bg-2); border-radius: 12px; padding: 4px;
    }
    .seg-btn {
      border: 0; background: transparent; cursor: pointer;
      font-family: inherit; font-size: 13px; font-weight: 600;
      color: var(--muted); padding: 8px 0; border-radius: 9px;
      transition: background .15s ease, color .15s ease;
    }
    .seg-btn.on { background: var(--card); color: var(--ink); box-shadow: var(--shadow-1); }

    .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .price-input { position: relative; }
    .price-input .prefix {
      position: absolute; left: 14px; top: 12px;
      font-weight: 700; color: var(--muted);
    }
    .price-input .input {
      padding-left: 26px;
      font-family: 'Bricolage Grotesque';
      font-weight: 700; font-size: 18px;
    }

    .toggle-row {
      background: var(--bg-2);
      border-radius: 14px;
      padding: 14px;
      display: flex; align-items: center; gap: 12px;
      cursor: pointer;
    }
    .toggle-label { font-size: 13px; font-weight: 600; flex: 1; }
    .toggle-row input { position: absolute; opacity: 0; pointer-events: none; }
    .toggle-pill {
      width: 38px; height: 22px; background: var(--line-2); border-radius: 999px;
      position: relative; transition: background .2s ease;
    }
    .toggle-pill::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 18px; height: 18px; background: white; border-radius: 999px;
      transition: transform .2s ease;
    }
    .toggle-row input:checked + .toggle-pill { background: var(--primary); }
    .toggle-row input:checked + .toggle-pill::after { transform: translateX(16px); }

    .payout-hint {
      background: var(--primary-soft);
      border-radius: 14px;
      padding: 12px 14px;
      font-size: 12px; color: var(--primary-deep); line-height: 1.5;
    }

    .label .cap {
      float: right; opacity: .6; font-weight: 500;
      text-transform: none; letter-spacing: 0;
    }
  `],
})
export class CreateBountyPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly data = inject(DataService);
  private readonly toast = inject(ToastService);

  protected readonly MAX_TITLE = MAX_TITLE;
  protected readonly MAX_DESCRIPTION = MAX_DESCRIPTION;
  protected readonly MAX_REWARD = MAX_REWARD;

  private readonly params = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });
  protected group = computed(() => this.data.groupById(this.params().get('groupId') ?? ''));

  protected title = signal('');
  protected description = signal('');
  protected rewardType = signal<'cash' | 'custom'>('cash');
  protected price = signal<number>(25);
  protected rewardText = signal('');
  protected points = signal<number>(25);
  protected expires = signal<string>('');
  protected proofRequired = signal(true);
  protected busy = signal(false);

  protected canSubmit = computed(() => {
    const t = this.title().trim();
    if (this.busy() || t.length === 0 || t.length > MAX_TITLE
      || this.description().length > MAX_DESCRIPTION || !this.expires()) {
      return false;
    }
    if (this.rewardType() === 'custom') {
      const r = this.rewardText().trim();
      const pts = Number(this.points());
      return r.length >= 1 && r.length <= MAX_REWARD
        && Number.isInteger(pts) && pts >= 1 && pts <= MAX_POINTS;
    }
    const p = Number(this.price());
    return Number.isInteger(p) && p >= 1;
  });

  constructor() {
    // Seed expiry from group.defaultExpiryDays once the group is loaded.
    effect(() => {
      if (this.expires()) return;
      const g = this.group();
      if (g) this.expires.set(this.dateNDaysFromNow(g.defaultExpiryDays));
    }, { allowSignalWrites: true });
  }

  shortName(name: string): string { return name.split(' ')[0] ?? name; }

  cancel(): void {
    const g = this.group();
    if (g) this.router.navigate(['/g', g.id]);
    else this.router.navigate(['/groups']);
  }

  async submit(): Promise<void> {
    const g = this.group();
    if (!g || !this.canSubmit()) return;
    const expiresAt = new Date(this.expires() + 'T18:00:00');
    this.busy.set(true);
    try {
      const isCustom = this.rewardType() === 'custom';
      const created = await this.data.postBounty({
        groupId: g.id,
        title: this.title().trim().slice(0, MAX_TITLE),
        description: this.description().trim().slice(0, MAX_DESCRIPTION),
        rewardType: this.rewardType(),
        ...(isCustom
          ? {
            rewardText: this.rewardText().trim().slice(0, MAX_REWARD),
            points: Math.floor(Number(this.points())),
          }
          : {
            price: Math.floor(Number(this.price())),
            points: Math.floor(Number(this.price())),
          }),
        expiresAt,
      });
      this.router.navigate(['/g', g.id, 'b', created.id]);
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }

  private dateNDaysFromNow(n: number): string {
    const d = new Date(Date.now() + n * 86400000);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }
}
