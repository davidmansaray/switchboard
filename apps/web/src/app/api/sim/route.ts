import { z } from 'zod';
import { agent, errorResponse } from '@/lib/agent';
import { currentStaff } from '@/lib/session';

export const dynamic = 'force-dynamic';

const ref = z.string().regex(/^NH-\d+$/);
const action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('beat'), n: z.number().int().min(1).max(9) }),
  z.object({ action: z.literal('reset') }),
  z.object({ action: z.literal('email'), hireRef: ref, threadLabel: z.string().max(4), from: z.string().email(), subject: z.string().min(1).max(200), body: z.string().min(1).max(4000) }),
  z.object({ action: z.literal('note'), hireRef: ref, body: z.string().min(1).max(2000) }),
  z.object({
    action: z.literal('edit'),
    hireRef: ref,
    deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    swap: z.object({ lineNo: z.number().int(), model: z.string(), description: z.string(), spec: z.string(), fleetNo: z.string(), weeklyRatePence: z.number().int() }).optional(),
  }),
  z.object({ action: z.literal('status'), hireRef: ref, lineNo: z.number().int(), status: z.enum(['booked', 'on_hire', 'cancelled']) }),
  z.object({ action: z.literal('sweep'), hireRef: ref }),
  z.object({ action: z.literal('crash'), mode: z.enum(['arm', 'now', 'disarm']) }),
]);

/** The simulator rail: scenario beats and free-form signals, all through the agent's real services. */
export async function POST(req: Request) {
  const parsed = action.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: 'invalid request', issues: parsed.error.issues }, { status: 400 });
  const a = parsed.data;
  const staff = await currentStaff();
  try {
    switch (a.action) {
      case 'beat':
        return Response.json(await agent('/internal/scenario/beat', { n: a.n }));
      case 'reset':
        return Response.json(await agent('/internal/scenario/reset', {}, { timeoutMs: 30_000 }));
      case 'email':
        return Response.json(await agent('/internal/emails', { hireRef: a.hireRef, threadLabel: a.threadLabel, from: a.from, subject: a.subject, body: a.body }));
      case 'note':
        return Response.json(await agent('/internal/notes', { hireRef: a.hireRef, authorId: staff.id, body: a.body }));
      case 'edit':
        return Response.json(
          await agent('/internal/hires/edit', {
            hireRef: a.hireRef,
            staffId: staff.id,
            changes: a.deliveryDate ? { deliveryDate: a.deliveryDate } : {},
            lines: a.swap ? [a.swap] : undefined,
          }),
        );
      case 'status':
        return Response.json(await agent('/internal/lines/status', { hireRef: a.hireRef, staffId: staff.id, lineNo: a.lineNo, status: a.status }));
      case 'sweep':
        return Response.json(await agent('/internal/sweeps/fire', { hireRef: a.hireRef }));
      case 'crash':
        return Response.json(await agent(a.mode === 'disarm' ? '/internal/crash/disarm' : '/internal/crash', a.mode === 'disarm' ? {} : { tool: '*', now: a.mode === 'now' }));
    }
  } catch (e) {
    return errorResponse(e);
  }
}
