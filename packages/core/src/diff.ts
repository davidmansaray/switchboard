export type DiffEntry = { path: string; from: unknown; to: unknown };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep diff of two JSON snapshots; arrays compare by value. Paths use dots. */
export function diffSnapshots(a: unknown, b: unknown, prefix = ''): DiffEntry[] {
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => diffSnapshots(a[k], b[k], prefix ? `${prefix}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path: prefix, from: a ?? null, to: b ?? null }];
}

/** "v4 → v5: deliveryDate 2026-11-03 → 2026-11-05; lines.2.model JCB 535-95 → Manitou MT 1335" */
export function formatDiff(fromVersion: number, toVersion: number, diff: readonly DiffEntry[]): string {
  const parts = diff
    .filter((d) => !['updatedAt', 'updatedBy', 'version'].includes(d.path))
    .map((d) => `${d.path} ${fmt(d.from)} → ${fmt(d.to)}`);
  return `v${fromVersion} → v${toVersion}: ${parts.length ? parts.join('; ') : 'no business changes'}`;
}

const fmt = (v: unknown) => (v === null || v === undefined ? '∅' : typeof v === 'string' ? v : JSON.stringify(v));
