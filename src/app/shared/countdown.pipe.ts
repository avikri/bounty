import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'countdown', standalone: true, pure: true })
export class CountdownPipe implements PipeTransform {
  transform(value: Date | number | string | null | undefined): string {
    if (value == null) return '';
    const target = value instanceof Date ? value.getTime() : new Date(value).getTime();
    const ms = target - Date.now();
    const abs = Math.abs(ms);
    const days = Math.floor(abs / 86400000);
    const hours = Math.floor((abs % 86400000) / 3600000);
    const mins = Math.floor((abs % 3600000) / 60000);
    const future = ms >= 0;
    let core: string;
    if (days > 0) core = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    else if (hours > 0) core = `${hours}h`;
    else core = `${Math.max(mins, 1)}m`;
    return future ? `${core} left` : `${core} ago`;
  }
}

@Pipe({ name: 'relative', standalone: true, pure: true })
export class RelativePipe implements PipeTransform {
  transform(value: Date | number | string | null | undefined): string {
    if (value == null) return '';
    const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
    const diff = Date.now() - t;
    const min = 60_000, hr = 3_600_000, day = 86_400_000;
    if (diff < hr) return `${Math.max(Math.floor(diff / min), 1)}m`;
    if (diff < day) return `${Math.floor(diff / hr)}h`;
    if (diff < day * 2) return `yesterday`;
    return `${Math.floor(diff / day)}d`;
  }
}
