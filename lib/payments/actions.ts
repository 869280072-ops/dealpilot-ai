'use server';

import { redirect } from 'next/navigation';
import { createCheckoutSession, createCustomerPortalSession } from './stripe';
import { db } from '@/lib/db/drizzle';
import { teams } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { withTeam } from '@/lib/auth/middleware';

export const checkoutAction = withTeam(async (formData, team) => {
  const priceId = formData.get('priceId') as string;
  await createCheckoutSession({ team: await db.query.teams.findFirst({ where: eq(teams.id, team.id) }) ?? null, priceId });
});

export const customerPortalAction = withTeam(async (_, team) => {
  const billingTeam = await db.query.teams.findFirst({ where: eq(teams.id, team.id) });
  if (!billingTeam) throw new Error('Team not found');
  const portalSession = await createCustomerPortalSession(billingTeam);
  redirect(portalSession.url);
});
