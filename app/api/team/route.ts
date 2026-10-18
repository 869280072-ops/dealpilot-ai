import { getTeamForUser } from '@/lib/db/queries';

export async function GET() {
  const team = await getTeamForUser();
  return Response.json(team, { headers: { 'Cache-Control': 'private, no-store' } });
}
