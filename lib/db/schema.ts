import {
  pgTable,
  jsonb,
  index,
  uniqueIndex,
  check,
  serial,
  varchar,
  text,
  timestamp,
  integer,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: varchar('role', { length: 20 }).notNull().default('member'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
});

export const teams = pgTable('teams', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  stripeProductId: text('stripe_product_id'),
  planName: varchar('plan_name', { length: 50 }),
  subscriptionStatus: varchar('subscription_status', { length: 20 }),
});

export const teamMembers = pgTable('team_members', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id),
  role: varchar('role', { length: 50 }).notNull(),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
});

export const activityLogs = pgTable('activity_logs', {
  id: serial('id').primaryKey(),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id),
  userId: integer('user_id').references(() => users.id),
  action: text('action').notNull(),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  ipAddress: varchar('ip_address', { length: 45 }),
});

export const invitations = pgTable('invitations', {
  id: serial('id').primaryKey(),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id),
  email: varchar('email', { length: 255 }).notNull(),
  role: varchar('role', { length: 50 }).notNull(),
  invitedBy: integer('invited_by')
    .notNull()
    .references(() => users.id),
  invitedAt: timestamp('invited_at').notNull().defaultNow(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
});

export const teamsRelations = relations(teams, ({ many }) => ({
  teamMembers: many(teamMembers),
  activityLogs: many(activityLogs),
  invitations: many(invitations),
}));

export const usersRelations = relations(users, ({ many }) => ({
  teamMembers: many(teamMembers),
  invitationsSent: many(invitations),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  team: one(teams, {
    fields: [invitations.teamId],
    references: [teams.id],
  }),
  invitedBy: one(users, {
    fields: [invitations.invitedBy],
    references: [users.id],
  }),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  user: one(users, {
    fields: [teamMembers.userId],
    references: [users.id],
  }),
  team: one(teams, {
    fields: [teamMembers.teamId],
    references: [teams.id],
  }),
}));

export const activityLogsRelations = relations(activityLogs, ({ one }) => ({
  team: one(teams, {
    fields: [activityLogs.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [activityLogs.userId],
    references: [users.id],
  }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type NewActivityLog = typeof activityLogs.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
export type TeamDataWithMembers = Pick<Team, 'id' | 'name' | 'planName' | 'subscriptionStatus'> & {
  teamMembers: (TeamMember & {
    user: Pick<User, 'id' | 'name' | 'email'>;
  })[];
};

export enum ActivityType {
  SIGN_UP = 'SIGN_UP',
  SIGN_IN = 'SIGN_IN',
  SIGN_OUT = 'SIGN_OUT',
  UPDATE_PASSWORD = 'UPDATE_PASSWORD',
  DELETE_ACCOUNT = 'DELETE_ACCOUNT',
  UPDATE_ACCOUNT = 'UPDATE_ACCOUNT',
  CREATE_TEAM = 'CREATE_TEAM',
  REMOVE_TEAM_MEMBER = 'REMOVE_TEAM_MEMBER',
  INVITE_TEAM_MEMBER = 'INVITE_TEAM_MEMBER',
  ACCEPT_INVITATION = 'ACCEPT_INVITATION',
}

// P1 private customer records. All access goes through the authorized service.
export const requirements = pgTable('requirements', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  teamId: integer('team_id').notNull().references(() => teams.id),
  title: varchar('title', { length: 120 }).notNull(),
  content: text('content').notNull(),
  service: varchar('service', { length: 30 }).notNull(),
  language: varchar('language', { length: 2 }).notNull(),
  revision: integer('revision').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
}, t => [index('requirements_scope_idx').on(t.userId, t.teamId), check('requirements_revision_positive', sql`${t.revision} > 0`)]);
export const analyses = pgTable('requirement_analyses', {
  id: serial('id').primaryKey(),
  requirementId: integer('requirement_id').notNull().references(() => requirements.id),
  revision: integer('revision').notNull(),
  mode: varchar('mode', { length: 10 }).notNull(),
  model: text('model').notNull(),
  result: jsonb('result').$type<import('@/lib/dealpilot/domain').Analysis>().notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow()
}, t => [index('analyses_requirement_revision_idx').on(t.requirementId, t.revision)]);
export const catalog = pgTable('service_catalog', {
  id: serial('id').primaryKey(),
  teamId: integer('team_id').notNull().references(() => teams.id),
  name: varchar('name', { length: 120 }).notNull(),
  service: varchar('service', { length: 30 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  unitCents: integer('unit_cents').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow()
}, t => [index('catalog_scope_idx').on(t.teamId, t.service, t.currency), check('catalog_price_bounds', sql`${t.unitCents} >= 0 AND ${t.unitCents} <= 100000000`)]);
export const quotations = pgTable('quotations', {
  id: serial('id').primaryKey(),
  requirementId: integer('requirement_id').notNull().references(() => requirements.id),
  requirementRevision: integer('requirement_revision').notNull(),
  analysisId: integer('analysis_id').notNull().references(() => analyses.id),
  revision: integer('revision').notNull().default(1),
  status: varchar('status', { length: 10 }).notNull().default('draft'),
  data: jsonb('data').$type<import('@/lib/dealpilot/domain').QuoteInput & { totalCents: number }>().notNull(),
  confirmedAt: timestamp('confirmed_at'),
  confirmedBy: integer('confirmed_by').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow()
}, t => [index('quotes_requirement_idx').on(t.requirementId), check('quote_confirmation_consistent', sql`(${t.status} = 'draft' AND ${t.confirmedAt} IS NULL AND ${t.confirmedBy} IS NULL) OR (${t.status} = 'confirmed' AND ${t.confirmedAt} IS NOT NULL AND ${t.confirmedBy} IS NOT NULL)`)]);
export const quoteHistory = pgTable('quotation_history', {
  id: serial('id').primaryKey(),
  quotationId: integer('quotation_id').notNull().references(() => quotations.id),
  revision: integer('revision').notNull(),
  status: varchar('status', { length: 10 }).notNull(),
  data: jsonb('data').$type<import('@/lib/dealpilot/domain').QuoteInput & { totalCents: number }>().notNull(),
  actorId: integer('actor_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow()
}, t => [uniqueIndex('quote_history_revision_unique').on(t.quotationId, t.revision)]);
