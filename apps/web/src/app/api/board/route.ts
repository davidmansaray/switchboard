import { getBoard } from '@/lib/data';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const desk = new URL(req.url).searchParams.get('desk');
  return Response.json(await getBoard({ desk }), { headers: { 'cache-control': 'no-store' } });
}
