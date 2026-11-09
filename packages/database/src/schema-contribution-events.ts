import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { githubDeliveries, githubInstallations, repositories } from './schema-github.js';

export const contributionEvents = pgTable('contribution_events', {
  id: uuid('id').primaryKey().defaultRandom(), repositoryId: uuid('repository_id').notNull().references(() => repositories.id),
  installationId: text('installation_id').notNull().references(() => githubInstallations.installationId),
  deliveryId: text('delivery_id').references(() => githubDeliveries.deliveryId),
  isHistorical: boolean('is_historical').notNull().default(false),
  kind: text('kind').notNull(), objectId: text('object_id').notNull(), status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  leaseId: uuid('lease_id'), lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, t => [unique().on(t.repositoryId, t.kind, t.objectId),
  check('contribution_events_kind_check', sql`${t.kind} IN ('commit','pull_request','issue')`),
  check('contribution_events_status_check', sql`${t.status} IN ('pending','processed','skipped')`),
  check('contribution_events_attempts_check', sql`${t.attempts}>=0`),
  check('contribution_events_object_id_check', sql`(${t.kind}='commit' AND ${t.objectId} ~ '^[0-9a-f]{40}$') OR (${t.kind} IN ('pull_request','issue') AND ${t.objectId} ~ '^[1-9][0-9]*$')`),
  index('contribution_events_pending_idx').on(t.nextAttemptAt, t.id).where(sql`${t.status}='pending'`)]);

export const contributionHistoryScans = pgTable('contribution_history_scans', {
  repositoryId: uuid('repository_id').primaryKey().references(() => repositories.id),
  cursor: jsonb('cursor'), status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  leaseId: uuid('lease_id'), lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, t => [check('contribution_history_scans_status_check', sql`${t.status} IN ('pending','completed')`),
  check('contribution_history_scans_attempts_check', sql`${t.attempts}>=0`),
  index('contribution_history_scans_pending_idx').on(t.nextAttemptAt, t.repositoryId).where(sql`${t.status}='pending'`)]);
