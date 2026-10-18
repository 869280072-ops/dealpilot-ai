import { getUser } from '@/lib/db/queries';

export async function GET() {
  const user = await getUser();
  return Response.json(user, { headers: { 'Cache-Control': 'private, no-store' } });
}
