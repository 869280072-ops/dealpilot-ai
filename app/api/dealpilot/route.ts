import { getUser } from '@/lib/db/queries';
import { db } from '@/lib/db/drizzle';
import { createDealPilotService, BusinessError, RateLimitError } from '@/lib/dealpilot/service';
import { aiMode } from '@/lib/dealpilot/ai';
import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
async function handle(run: (service: ReturnType<typeof createDealPilotService>) => Promise<unknown>) {
  try {
    const user = await getUser();
    if (!user) return Response.json({ error: '请先登录。' }, { status: 401, headers });
    return Response.json(await run(createDealPilotService(db, user.id)), { headers });
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: '输入格式不正确，请检查必填项及金额。' }, { status: 400, headers });
    if (error instanceof RateLimitError) return Response.json({ error: error.message }, { status: 429, headers: { ...headers, 'Retry-After': '60' } });
    if (error instanceof BusinessError) return Response.json({ error: error.message }, { status: 409, headers });
    const errorId = randomUUID();
    console.error(JSON.stringify({ event: 'dealpilot_request_failed', errorId }));
    const message = error instanceof Error && error.message.startsWith('AI 分析暂时不可用') ? error.message : `操作暂时不可用，请稍后重试。参考编号：${errorId}`;
    return Response.json({ error: message }, { status: 503, headers });
  }
}
export async function GET() {
  return handle(async service => ({ ...await service.list(), mode: aiMode() }));
}
export async function POST(request: Request) {
  // Cookie authentication requires a same-origin mutation, including fetch APIs.
  const origin = request.headers.get('origin');
  if (origin !== new URL(request.url).origin) return Response.json({ error: '请求来源无效。' }, { status: 403, headers });
  if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: '需要 JSON 请求。' }, { status: 415, headers });
  return handle(async service => {
    const reader = request.body?.getReader(); if (!reader) throw new ZodError([]);
    const parts: Uint8Array[] = []; let bytes = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 64000) { await reader.cancel(); throw new ZodError([]); } parts.push(value); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new ZodError([]); }
    return service.execute(body);
  });
}
