import { useEffect, useRef, useState, type ReactNode } from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Button(props: { children: ReactNode; onClick?: () => void; kind?: 'primary' | 'ghost' | 'danger' | 'subtle'; size?: 'sm' | 'md'; disabled?: boolean; title?: string; type?: 'button' | 'submit'; className?: string }) {
  return (
    <button type={props.type ?? 'button'} className={cx('btn', `btn-${props.kind ?? 'subtle'}`, props.size === 'sm' && 'btn-sm', props.className)} onClick={props.onClick} disabled={props.disabled} title={props.title}>
      {props.children}
    </button>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: string; disabled?: boolean }) {
  return (
    <label className={cx('toggle', props.disabled && 'disabled')} title={props.hint}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{props.label}</span>
    </label>
  );
}

export function Slider(props: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: ReactNode; format?: (v: number) => string }) {
  return (
    <label className="field slider">
      <span className="field-label">
        {props.label} <b>{props.format ? props.format(props.value) : props.value}</b>
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  );
}

export function Field(props: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

export function Select<T extends string>(props: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }> }) {
  return (
    <select className="input" value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function scoreColor(score: number): string {
  if (score >= 85) return '#22c55e';
  if (score >= 70) return '#facc15';
  if (score >= 55) return '#fb923c';
  return '#ef4444';
}

export function ScoreRing({ score, size = 54, label }: { score: number; size?: number; label?: string }) {
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  return (
    <div className="score-ring" style={{ width: size, height: size }} title={label ?? `Virality score ${score}/99`}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.12)" strokeWidth="5" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={scoreColor(score)} strokeWidth="5" fill="none" strokeDasharray={`${(c * score) / 100} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span style={{ fontSize: size * 0.32 }}>{score}</span>
    </div>
  );
}

export function SubScore({ label, value }: { label: string; value: number }) {
  return (
    <div className="subscore">
      <span>{label}</span>
      <div className="subscore-bar">
        <div style={{ width: `${value}%`, background: scoreColor(value) }} />
      </div>
      <b>{value}</b>
    </div>
  );
}

export function Progress({ pct, label, detail }: { pct: number; label?: string; detail?: string }) {
  return (
    <div className="progress">
      {(label || detail) && (
        <div className="progress-text">
          <span>{label}</span>
          <span className="muted">{detail}</span>
        </div>
      )}
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      </div>
    </div>
  );
}

export function Badge({ children, tone = 'default', title }: { children: ReactNode; tone?: 'default' | 'good' | 'bad' | 'warn' | 'accent'; title?: string }) {
  return (
    <span className={cx('badge', `badge-${tone}`)} title={title}>
      {children}
    </span>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: ReactNode }> }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.value} className={cx('tab', value === t.value && 'active')} onClick={() => onChange(t.value)} type="button">
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'modal-wide')} role="dialog">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function DropZone({ onFiles, accept, children }: { onFiles: (files: File[]) => void; accept?: string; children: ReactNode }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={cx('dropzone', over && 'over')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) onFiles(files);
      }}
      onClick={() => input.current?.click()}
      role="button"
      tabIndex={0}
    >
      <input
        ref={input}
        type="file"
        hidden
        accept={accept}
        multiple
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length) onFiles(files);
          e.target.value = '';
        }}
      />
      {children}
    </div>
  );
}

export function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export function formatMoney(n: number | undefined): string {
  if (n === undefined) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n < 10 ? 2 : 0 });
}

export function formatBytes(n: number | undefined): string {
  if (!n) return '—';
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}
