import { z } from 'zod';
import { agent, errorResponse } from '@/lib/agent';
import { currentStaff } from '@/lib/session';

export const dynamic = 'force-dynamic';

const body = z.object({ draftRef: z.string().regex(/^D-\d+$/), decision: z.enum(['approved', 'rejected']), channel: z.enum(['web', 'mobile']).default('web') });

/**
 * Approve or reject a draft as the signed-in staff member. The agent writes the approval row and
 * then signals the desk (an approval is an event, not a suspended step). Staff who are not
 * approvers are refused here and again in the agent service.
 */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: 'invalid request' }, { status: 400 });
  const staff = await currentStaff();
  if (staff.role !== 'approver') return Response.json({ error: `${staff.name} is not an approver` }, { status: 403 });
  try {
    return Response.json(await agent('/internal/approvals', { ...parsed.data, staffId: staff.id }));
  } catch (e) {
    return errorResponse(e);
  }
}
