/** Typed tool results. Preconditions fail as values, not exceptions, so the model can react. */
export type ToolOk<T> = { status: 'OK'; result: T };
export type ToolDuplicate<T> = { status: 'DUPLICATE'; actionKey: string; result: T };
export type ToolStale = { status: 'STALE'; expectedVersion: number; currentVersion: number; message: string };
export type ToolRejected = { status: 'REJECTED'; reason: string };
export type ToolResult<T> = ToolOk<T> | ToolDuplicate<T> | ToolStale | ToolRejected;

export const stale = (expectedVersion: number, currentVersion: number): ToolStale => ({
  status: 'STALE',
  expectedVersion,
  currentVersion,
  message: `Hire is at v${currentVersion}, you expected v${expectedVersion}. Re-read the hire and redo the work against v${currentVersion}.`,
});
export const rejected = (reason: string): ToolRejected => ({ status: 'REJECTED', reason });
