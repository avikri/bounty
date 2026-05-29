import { ChangeDetectionStrategy, Component, Input, signal } from '@angular/core';
import { IconComponent } from './icon.component';

type MediaKind = 'image' | 'video' | 'other';

function kindOf(url: string): MediaKind {
  if (/\.(png|jpe?g|gif|webp|avif|heic)(\?|#|$)/i.test(url)) return 'image';
  if (/\.(mp4|mov|webm|ogg|m4v|avi|mkv)(\?|#|$)/i.test(url)) return 'video';
  return 'other';
}

/**
 * Presentational proof viewer: image thumbnails + inline video, with a
 * tap-to-open lightbox. Reused by the bounty detail and review queue.
 */
@Component({
  selector: 'app-proof-gallery',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (urls.length) {
      <div class="grid">
        @for (u of urls; track u; let i = $index) {
          <button class="tile" (click)="open(i)" type="button">
            @switch (kind(u)) {
              @case ('image') { <img [src]="u" alt="proof" loading="lazy" /> }
              @case ('video') {
                <video [src]="u" muted playsinline preload="metadata"></video>
                <span class="play"><app-icon name="post" [size]="18" /></span>
                <span class="tag">video</span>
              }
              @default { <span class="ext">file</span> }
            }
          </button>
        }
      </div>
    }

    @if (lightbox() !== null) {
      <div class="lb-bg" (click)="close()">
        <button class="lb-close" (click)="close()" aria-label="Close"><app-icon name="close" [size]="18" /></button>
        <div class="lb-stage" (click)="$event.stopPropagation()">
          @if (urls.length > 1) {
            <button class="nav prev" (click)="step(-1)" aria-label="Previous"><app-icon name="back" [size]="20" /></button>
          }
          @switch (kind(current())) {
            @case ('image') { <img [src]="current()" alt="proof" /> }
            @case ('video') { <video [src]="current()" controls autoplay playsinline></video> }
            @default { <a class="ext-link" [href]="current()" target="_blank" rel="noopener">Open file ↗</a> }
          }
          @if (urls.length > 1) {
            <button class="nav next" (click)="step(1)" aria-label="Next"><app-icon name="back" [size]="20" class="flip" /></button>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .tile {
      position: relative; aspect-ratio: 1;
      border-radius: 14px; overflow: hidden;
      background: var(--bg-2); border: 1px solid var(--line);
      padding: 0; cursor: pointer;
    }
    .tile img, .tile video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .tile .play {
      position: absolute; inset: 0; display: grid; place-items: center;
      color: white; background: rgba(20,15,5,.25);
    }
    .tile .tag {
      position: absolute; bottom: 4px; left: 4px;
      background: rgba(20,15,5,.6); color: white;
      font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 999px;
      font-family: 'JetBrains Mono', monospace;
    }
    .tile .ext { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }

    .lb-bg {
      position: fixed; inset: 0; z-index: 80;
      background: rgba(15,10,5,.86);
      display: grid; place-items: center; padding: 24px;
    }
    .lb-close {
      position: fixed; top: 16px; right: 16px;
      width: 40px; height: 40px; border-radius: 999px;
      background: rgba(255,255,255,.12); color: white; border: 0;
      display: grid; place-items: center; cursor: pointer;
    }
    .lb-stage {
      display: flex; align-items: center; gap: 12px;
      max-width: 100%; max-height: 100%;
    }
    .lb-stage img, .lb-stage video {
      max-width: min(900px, 84vw); max-height: 82vh;
      border-radius: 12px; display: block;
    }
    .nav {
      width: 40px; height: 40px; border-radius: 999px; flex-shrink: 0;
      background: rgba(255,255,255,.12); color: white; border: 0;
      display: grid; place-items: center; cursor: pointer;
    }
    .nav .flip { transform: rotate(180deg); }
    .ext-link { color: white; font-weight: 700; }
  `],
})
export class ProofGalleryComponent {
  @Input() urls: string[] = [];

  protected readonly lightbox = signal<number | null>(null);

  protected kind(url: string): MediaKind { return kindOf(url); }
  protected current(): string { return this.urls[this.lightbox() ?? 0] ?? ''; }

  open(i: number): void { this.lightbox.set(i); }
  close(): void { this.lightbox.set(null); }
  step(delta: number): void {
    const n = this.urls.length;
    if (n === 0) return;
    this.lightbox.set((((this.lightbox() ?? 0) + delta) % n + n) % n);
  }
}
