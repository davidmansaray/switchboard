import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { listStaff } from './data';
import type { Staff } from './types';

/**
 * Demo auth: "sign in as" one of the seeded staff, held in an HMAC-signed cookie. Without a
 * cookie the desk lead (Gary, an approver) is assumed so the Control Room opens straight away.
 * Approvals are checked against the role again in the agent service.
 */
export const SESSION_COOKIE = 'sb_session';
const DEFAULT_STAFF = 'gary';

const secret = () => process.env.SESSION_SECRET || 'switchboard-dev-secret';
const sign = (v: string) => createHmac('sha256', secret()).update(v).digest('base64url');

export function sealSession(staffId: string): string {
  return `${staffId}.${sign(staffId)}`;
}

export function openSession(token: string | undefined): string | null {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const id = token.slice(0, i);
  const a = Buffer.from(token.slice(i + 1));
  const b = Buffer.from(sign(id));
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

export async function currentStaff(): Promise<Staff> {
  const jar = await cookies();
  const id = openSession(jar.get(SESSION_COOKIE)?.value) ?? DEFAULT_STAFF;
  const staff = await listStaff();
  return staff.find((s) => s.id === id) ?? staff.find((s) => s.id === DEFAULT_STAFF) ?? staff[0]!;
}
