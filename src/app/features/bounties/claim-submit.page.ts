import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { DataService } from '../../core/data.service';
import { IconComponent } from '../../shared/icon.component';
import { ToastService } from '../../shared/toast.service';

interface ProofFile {
  id: number;
  file: File;
  kind: 'image' | 'video';
  previewUrl: string;
  progress: number;
  url: string | null;
  error: string | null;
}

const MAX_FILES = 3;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB

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

        <label class="label">Proof (up to {{ maxFiles }})</label>
        <div class="proof-grid">
          @for (f of files(); track f.id) {
            <div class="proof-tile" data-testid="proof-tile">
              @if (f.kind === 'image') {
                <img [src]="f.previewUrl" alt="proof preview" />
              } @else {
                <video [src]="f.previewUrl" muted playsinline></video>
                <span class="vbadge">video</span>
              }
              @if (f.progress > 0 && f.progress < 100 && !f.url) {
                <div class="progress"><div class="bar" [style.width.%]="f.progress"></div></div>
              }
              @if (f.url) { <span class="done"><app-icon name="check" [size]="14" /></span> }
              <button class="remove" (click)="remove(f.id)" [disabled]="busy()" aria-label="Remove">
                <app-icon name="close" [size]="12" />
              </button>
            </div>
          }
          @if (files().length < maxFiles) {
            <button class="add-tile" (click)="picker.click()" [disabled]="busy()" data-testid="proof-add">
              <app-icon name="plus" [size]="22" />
            </button>
          }
        </div>
        <input #picker type="file" accept="image/*,video/*" multiple hidden
               (change)="onPick($event)" data-testid="proof-input" />
        <div class="caps">Images up to 10&nbsp;MB · video up to 100&nbsp;MB</div>

        <label class="label">Note to OP <span class="muted">(optional)</span></label>
        <textarea class="input" rows="3" style="resize: none;" [(ngModel)]="note"
                  placeholder="Context, timestamps, witnesses..." data-testid="proof-note"></textarea>

        <div class="gap"></div>
        <div class="hint">
          <app-icon name="reviews" [size]="16" />
          <div>{{ poster()?.handle }} has <strong>48 hours</strong> to approve or reject. If they ghost, it auto-resolves.</div>
        </div>

        <div class="gap"></div>
        <button class="btn full" (click)="submit()" [disabled]="busy()" data-testid="submit-proof">
          {{ busy() ? 'Uploading…' : 'Submit for review' }}
        </button>
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
      margin-bottom: 6px;
    }
    .proof-tile {
      position: relative;
      aspect-ratio: 1;
      border-radius: 14px;
      overflow: hidden;
      background: var(--bg-2);
      border: 1px solid var(--line);
    }
    .proof-tile img, .proof-tile video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .proof-tile .vbadge {
      position: absolute; bottom: 4px; left: 4px;
      background: rgba(20,15,5,.6); color: white;
      font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 999px;
      font-family: 'JetBrains Mono', monospace;
    }
    .proof-tile .progress {
      position: absolute; left: 0; right: 0; bottom: 0; height: 4px;
      background: rgba(255,255,255,.4);
    }
    .proof-tile .progress .bar { height: 100%; background: var(--primary); transition: width .15s ease; }
    .proof-tile .done {
      position: absolute; top: 4px; left: 4px;
      width: 20px; height: 20px; border-radius: 999px;
      background: var(--success); color: white;
      display: grid; place-items: center;
    }
    .proof-tile .remove {
      position: absolute; top: 4px; right: 4px;
      width: 20px; height: 20px; border-radius: 999px;
      background: rgba(20,15,5,.6); color: white; border: 0;
      display: grid; place-items: center; cursor: pointer;
    }
    .add-tile {
      aspect-ratio: 1;
      border: 1.5px dashed var(--line-2);
      border-radius: 14px;
      display: grid; place-items: center;
      color: var(--muted);
      cursor: pointer;
      background: transparent;
    }
    .caps {
      font-size: 11px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      margin-bottom: 14px;
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

  protected readonly maxFiles = MAX_FILES;

  private readonly params = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });
  protected bounty = computed(() => this.data.bountyById(this.params().get('bountyId') ?? ''));
  protected poster = computed(() => {
    const b = this.bounty();
    return b ? this.data.userById(b.posterId) : undefined;
  });
  protected note = signal('');
  protected busy = signal(false);
  protected files = signal<ProofFile[]>([]);
  private nextId = 1;

  onPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    input.value = ''; // allow re-picking the same file later
    for (const file of picked) {
      if (this.files().length >= MAX_FILES) {
        this.toast.error(`You can attach at most ${MAX_FILES} files.`);
        break;
      }
      const isImage = file.type.startsWith('image/');
      const isVideo = file.type.startsWith('video/');
      if (!isImage && !isVideo) {
        this.toast.error(`${file.name}: only images or video are allowed.`);
        continue;
      }
      const cap = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (file.size > cap) {
        this.toast.error(`${file.name} is too large (max ${isVideo ? '100' : '10'} MB).`);
        continue;
      }
      this.files.update((list) => [...list, {
        id: this.nextId++,
        file,
        kind: isImage ? 'image' : 'video',
        previewUrl: URL.createObjectURL(file),
        progress: 0,
        url: null,
        error: null,
      }]);
    }
  }

  remove(id: number): void {
    this.files.update((list) => {
      const target = list.find((f) => f.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return list.filter((f) => f.id !== id);
    });
  }

  async submit(): Promise<void> {
    const b = this.bounty();
    if (!b || this.busy()) return;
    this.busy.set(true);
    try {
      const urls: string[] = [];
      for (const f of this.files()) {
        if (f.url) { urls.push(f.url); continue; }
        const url = await this.data.uploadProofFile(b.groupId, b.id, f.file, (pct) => {
          this.files.update((list) => list.map((x) => x.id === f.id ? { ...x, progress: pct } : x));
        });
        this.files.update((list) => list.map((x) => x.id === f.id ? { ...x, url, progress: 100 } : x));
        urls.push(url);
      }
      await this.data.submitProof(b.id, this.note().trim(), urls);
      this.toast.success('Proof submitted — waiting on OP.');
      this.router.navigate(['/g', b.groupId, 'b', b.id]);
    } catch (e) {
      this.toast.error(this.toast.formatError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
