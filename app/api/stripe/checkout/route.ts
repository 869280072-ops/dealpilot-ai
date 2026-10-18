import { getUser, getCurrentMembership } from '@/lib/db/queries';
import { legacyPaymentsEnabled } from '@/lib/env';
import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/payments/stripe';

export async function GET(request: NextRequest) {
  if (!legacyPaymentsEnabled()) return NextResponse.json({ error: 'Payments unavailable' }, { status: 503 });
  const currentUser = await getUser();
  if (!currentUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const membership = await getCurrentMembership();
  if (!membership || membership.role !== 'owner') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const searchParams = request.nextUrl.searchParams;
  const sessionId = searchParams.get('session_id');

  if (!sessionId) {
    return NextResponse.redirect(new URL('/pricing', request.url));
  }

  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId, {
      expand: ['customer', 'subscription'],
    });

    if (session.client_reference_id !== String(currentUser.id) || session.metadata?.teamId !== String(membership.teamId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (session.status !== 'complete' || !['paid', 'no_payment_required'].includes(session.payment_status)) {
      return NextResponse.json({ error: 'Checkout incomplete' }, { status: 400 });
    }

    // Browser return only displays the result. Trusted server notifications own entitlements.
    return NextResponse.redirect(new URL('/dashboard', request.url));
  } catch {
    console.error('Checkout lookup failed');
    return NextResponse.redirect(new URL('/pricing', request.url));
  }
}
