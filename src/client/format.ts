const DAY = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Short time for lists: 09:42, Yesterday, Sat, 14 Oct, 14 Oct 2025. */
export function shortTime(ms: number, now: number = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
  const d = new Date(ms);
  if (days <= 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  if (d.getFullYear() === new Date(now).getFullYear()) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

export function longTime(ms: number, now: number = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (days <= 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' })}, ${time}`;
}

export function dayGroup(ms: number, now: number = Date.now()): 'Today' | 'Yesterday' | 'Earlier' {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : 'Earlier';
}

export function ago(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function initials(name: string, email: string): string {
  const source = name.trim() || email.split('@')[0] || '?';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : source.slice(0, 2);
  return letters.toUpperCase();
}

/** A stable colour slot (1–6) for a person, so the same sender always looks the same. */
export function tone(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return (h % 6) + 1;
}

export function fileKind(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()! : '';
  return (ext || 'FILE').slice(0, 4).toUpperCase();
}

/** Next Monday at 08:00 local time. */
export function nextMonday(now: number = Date.now()): number {
  const d = new Date(now);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

/** Tomorrow at 08:00 local time. */
export function tomorrowMorning(now: number = Date.now()): number {
  const d = new Date(now + DAY);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}
