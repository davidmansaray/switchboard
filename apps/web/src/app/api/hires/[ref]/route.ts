import { getDeskDetail } from '@/lib/data';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  const detail = await getDeskDetail(ref);
  if (!detail) return Response.json({ error: `no hire ${ref}` }, { status: 404 });
  return Response.json(detail, { headers: { 'cache-control': 'no-store' } });
}
