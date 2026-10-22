import { cookies } from 'next/headers';
import { z } from 'zod';
import { listStaff } from '@/lib/data';
import { SESSION_COOKIE, sealSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Sign in as a seeded staff member (demo auth). */
export async function POST(req: Request) {
  const parsed = z.object({ staffId: z.string() }).safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: 'invalid request' }, { status: 400 });
  const staff = (await listStaff()).find((s) => s.id === parsed.data.staffId);
  if (!staff) return Response.json({ error: 'unknown staff' }, { status: 404 });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, sealSession(staff.id), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 30 });
  return Response.json({ staff });
}

export async function DELETE() {
  (await cookies()).delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
