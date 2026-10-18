import { NextResponse, type NextRequest } from 'next/server';
import { verifyToken } from '@/lib/auth/session';
// Early redirect only: data/action boundaries recheck the live user and membership.
export async function proxy(request: NextRequest) {
  const token = request.cookies.get('session')?.value;
  if (token) {
    try { await verifyToken(token); return NextResponse.next(); }
    catch { /* Fail closed without logging cookie contents. */ }
  }
  const response = NextResponse.redirect(new URL('/sign-in', request.url));
  response.cookies.delete('session');
  return response;
}
export const config = { matcher: ['/dashboard/:path*'] };
