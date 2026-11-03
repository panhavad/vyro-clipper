import { useMemo, useState } from 'react';
import { computeCuts, mergeRanges } from '../../core/timeline';
import { wordsInRange } from '../../core/transcript';
import { formatTime } from '../../core/text';
import type { Clip, Project, TimeRange } from '../../core/types';
import { Button, cx } from './ui';

export function TranscriptEditor({ project, clip, srcTime, onSeek, onChange }: { project: Project; clip: Clip; srcTime: number; onSeek: (t: number) => void; onChange: (patch: Partial<Clip>) => void }) {
  const words = project.transcript?.words ?? [];
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const context = 10;
  const visible = useMemo(() => wordsInRange(words, Math.max(0, clip.start - context), clip.end + context), [words, clip.start, clip.end]);
  const autoCuts = useMemo(
    () => computeCuts({ start: clip.start, end: clip.end }, words, [], { jumpCuts: false, silenceThreshold: clip.edit.silenceThreshold, removeFillers: clip.edit.removeFillers }),
    [words, clip.start, clip.end, clip.edit.silenceThreshold, clip.edit.removeFillers],
  );
  const inRanges = (t: number, ranges: TimeRange[]) => ranges.some((r) => t >= r.start && t <= r.end);
  const lo = sel ? Math.min(sel.a, sel.b) : -1;
  const hi = sel ? Math.max(sel.a, sel.b) : -1;
  const selWords = sel ? visible.slice(lo, hi + 1) : [];

  const cutSelection = () => {
    if (!selWords.length) return;
    const range = { start: selWords[0]!.start - 0.02, end: selWords[selWords.length - 1]!.end + 0.02 };
    onChange({ manualCuts: mergeRanges([...clip.manualCuts, range]) });
    setSel(null);
  };
  const restoreSelection = () => {
    if (!selWords.length) return;
    const a = selWords[0]!.start;
    const b = selWords[selWords.length - 1]!.end;
    onChange({ manualCuts: clip.manualCuts.filter((c) => c.end < a || c.start > b) });
    setSel(null);
  };
  const nudge = (field: 'start' | 'end', d: number) => {
    const v = Math.max(0, clip[field] + d);
    if (field === 'start' && v < clip.end - 3) onChange({ start: v, reframe: undefined });
    if (field === 'end' && v > clip.start + 3) onChange({ end: Math.min(v, project.meta?.duration ?? v), reframe: undefined });
  };

  if (!words.length) return <p className="muted">No transcript for this source (no speech detected).</p>;
  return (
    <div className="transcript-editor">
      <div className="row between wrap gap">
        <div className="row gap center-v">
          <span className="small muted">Start</span>
          <Button size="sm" onClick={() => nudge('start', -1)}>
            −1s
          </Button>
          <span className="mono small">{formatTime(clip.start, true)}</span>
          <Button size="sm" onClick={() => nudge('start', 1)}>
            +1s
          </Button>
          <span className="small muted" style={{ marginLeft: 12 }}>
            End
          </span>
          <Button size="sm" onClick={() => nudge('end', -1)}>
            −1s
          </Button>
          <span className="mono small">{formatTime(clip.end, true)}</span>
          <Button size="sm" onClick={() => nudge('end', 1)}>
            +1s
          </Button>
        </div>
        <div className="row gap">
          {sel && (
            <>
              <Button size="sm" kind="danger" onClick={cutSelection}>
                ✂ Cut {selWords.length} word{selWords.length > 1 ? 's' : ''}
              </Button>
              <Button size="sm" onClick={restoreSelection}>
                Restore
              </Button>
              {selWords.length === 1 && (
                <>
                  <Button size="sm" onClick={() => (onChange({ start: Math.max(0, selWords[0]!.start - 0.12), reframe: undefined }), setSel(null))}>
                    Start here
                  </Button>
                  <Button size="sm" onClick={() => (onChange({ end: selWords[0]!.end + 0.3, reframe: undefined }), setSel(null))}>
                    End here
                  </Button>
                </>
              )}
            </>
          )}
          {clip.manualCuts.length > 0 && (
            <Button size="sm" kind="ghost" onClick={() => onChange({ manualCuts: [] })}>
              Undo all cuts
            </Button>
          )}
        </div>
      </div>
      <p className="muted small">Click a word to jump there · Shift+click to select a range, then cut it (text-based editing). Greyed words are outside the clip.</p>
      <div className="words">
        {visible.map((w, i) => {
          const mid = (w.start + w.end) / 2;
          const outside = mid < clip.start || mid > clip.end;
          const manual = inRanges(mid, clip.manualCuts);
          const auto = !manual && inRanges(mid, autoCuts);
          const active = srcTime >= w.start && srcTime < w.end;
          return (
            <span
              key={`${w.start}-${i}`}
              className={cx('word', outside && 'outside', manual && 'cut', auto && 'auto-cut', active && 'active', i >= lo && i <= hi && 'selected')}
              title={`${formatTime(w.start, true)}${auto ? ' · removed automatically (filler)' : ''}`}
              onClick={(e) => {
                if (e.shiftKey && sel) setSel({ a: sel.a, b: i });
                else {
                  setSel({ a: i, b: i });
                  onSeek(w.start);
                }
              }}
            >
              {w.text}{' '}
            </span>
          );
        })}
      </div>
    </div>
  );
}
