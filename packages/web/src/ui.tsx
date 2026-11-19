import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { NetworkEntry } from './rpc';

export type Tone = 'accent' | 'good' | 'warn' | 'bad' | 'muted' | 'text';

export const TONE_CLASS: Record<Tone, string> = {
  accent: 'text-accent',
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
  muted: 'text-muted',
  text: 'text-inktext',
};

const ICONS: Record<string, ReactNode> = {
  devices: <><rect x="3" y="4" width="13" height="11" rx="2" /><path d="M8 19h4M10 15v4M19 8v9a2 2 0 0 1-2 2" /></>,
  logs: <><path d="M4 5h16M4 10h11M4 15h16M4 20h9" /></>,
  metro: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><circle cx="12" cy="12" r="4" /></>,
  environment: <><path d="M12 3 4 7v6c0 4 3.4 6.8 8 8 4.6-1.2 8-4 8-8V7l-8-4Z" /><path d="m9 12 2 2 4-4" /></>,
  broadcast: <><circle cx="12" cy="12" r="2" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 19.1a10 10 0 0 0 0-14.2" /></>,
  storage: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  perf: <><path d="M3 17l5-6 4 3 5-8 4 4" /><path d="M3 21h18" /></>,
  tweaks: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
  e2e: <><path d="M9 3h6M10 3v6l-5 10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1l-5-10V3" /><path d="M7.5 15h9" /></>,
};

export function Icon({ name, size = 17 }: { name: string; size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {ICONS[name] ?? ICONS.logs}
    </svg>
  );
}

export function Panel({ title, subtitle, right, children, className = '' }: {
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section className={`flex min-h-full flex-col ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-6 py-4">
        <div className="flex items-baseline gap-3">
          <h2 className="font-display text-lg font-semibold tracking-tight text-inktext">{title}</h2>
          {subtitle !== undefined && <span className="font-mono text-xs text-muted">{subtitle}</span>}
        </div>
        {right}
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-6 py-5">{children}</div>
    </section>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: Tone;
  solid?: boolean;
};

export function Btn({ tone = 'text', solid = false, className = '', children, ...rest }: BtnProps): ReactNode {
  const color = solid
    ? tone === 'good' ? 'bg-good/15 text-good hover:bg-good/25'
      : tone === 'bad' ? 'bg-bad/15 text-bad hover:bg-bad/25'
        : tone === 'warn' ? 'bg-warn/15 text-warn hover:bg-warn/25'
          : 'bg-accent/15 text-accent hover:bg-accent/25'
    : 'bg-raised text-inktext hover:bg-line';
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded px-3 py-1.5 font-mono text-xs transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${color} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactNode {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="font-mono text-[11px] uppercase tracking-wider text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded border border-line bg-surface px-3 py-2 font-mono text-sm text-inktext outline-none transition-colors placeholder:text-muted/70 focus:border-accent/70';

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-1 items-center justify-center rounded border border-dashed border-line px-6 py-12 text-center text-sm text-muted">
      {children}
    </div>
  );
}

export function Pill({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }): ReactNode {
  return (
    <span className={`rounded bg-raised px-2 py-0.5 font-mono text-[11px] ${TONE_CLASS[tone]}`}>{children}</span>
  );
}

export function KV({ label, value, tone = 'text' }: { label: string; value: ReactNode; tone?: Tone }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-1.5 last:border-0">
      <span className="font-mono text-xs text-muted">{label}</span>
      <span className={`min-w-0 truncate text-right text-sm ${TONE_CLASS[tone]}`}>{value}</span>
    </div>
  );
}

export function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-GB', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function cut(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Headers are redacted again in the browser in case the daemon sends them verbatim. */
const SECRET_HEADERS = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;

export function redactHeaders(headers: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(headers ?? {}).map(([key, value]) => [key, SECRET_HEADERS.test(key.trim()) ? '[redacted]' : value]);
}

export function redactEntry(entry: NetworkEntry): NetworkEntry {
  return {
    ...entry,
    requestHeaders: Object.fromEntries(redactHeaders(entry.requestHeaders)),
    responseHeaders: Object.fromEntries(redactHeaders(entry.responseHeaders)),
  };
}
