import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

export type IconName =
  | 'groups' | 'reviews' | 'post' | 'ranks' | 'me' | 'inbox'
  | 'back' | 'close' | 'plus' | 'lock' | 'apple' | 'google'
  | 'menu' | 'check' | 'bell';

@Component({
  selector: 'app-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.width]="size" [attr.height]="size" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      @switch (name) {
        @case ('groups')  { <path d="M3 9 12 2l9 7v12H3z"/> }
        @case ('reviews') { <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/> }
        @case ('post')    { <circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/> }
        @case ('ranks')   { <path d="M4 20V10M12 20V4M20 20v-7"/> }
        @case ('me')      { <circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/> }
        @case ('inbox')   { <rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/> }
        @case ('back')    { <path d="m15 18-6-6 6-6"/> }
        @case ('close')   { <path d="M18 6 6 18M6 6l12 12"/> }
        @case ('plus')    { <path d="M12 5v14M5 12h14"/> }
        @case ('lock')    { <rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/> }
        @case ('menu')    { <circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="19" r="1.5"/> }
        @case ('check')   { <path d="M20 7 9 18l-5-5"/> }
        @case ('bell')    { <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/> }
      }
    </svg>
  `,
})
export class IconComponent {
  @Input({ required: true }) name!: IconName;
  @Input() size: number = 20;
}
