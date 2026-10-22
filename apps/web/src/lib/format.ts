/** Formatting shared by server and client. UK English, Europe/London, no comma after the weekday. */

export const TZ = 'Europe/London';

export function fmtTime(iso: string | Date): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
}

export function fmtTimeSec(iso: string | Date): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: TZ });
}

/** "Thu 29 Oct" */
export function fmtDay(iso: string | Date): string {
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ }).replace(',', '');
}

/** A calendar date ("2026-11-04") → "Wed 4 Nov". */
export function fmtDate(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
}

export function fmtDateLong(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export const gbp = (pence: number) => `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const gbp0 = (pence: number) => `£${Math.round(pence / 100).toLocaleString('en-GB')}`;

/** "run_043e" from a Mastra run id or the app loop's "app-<uuid>". */
export const shortRun = (id: string | null | undefined) => (id ? `run_${id.replace(/^app-/, '').replace(/-/g, '').slice(0, 4)}` : null);
export const shortSig = (id: string) => `sig-${id.replace(/-/g, '').slice(0, 4)}`;

/** Short machine names for narrow T-cards ("19m articulated boom lift" → "19m boom"). */
export function shortMachine(desc: string): string {
  return desc
    .replace(/\b(articulated|electric|forward-tipping|mini|LED)\s/gi, '')
    .replace(/\s(lift)\b/i, '')
    .replace(/\sx(\d)/, ' ×$1')
    .replace(/^tower/, 'Tower');
}

export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
