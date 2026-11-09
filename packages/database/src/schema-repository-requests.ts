import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema.js';
import { repositories } from './schema-github.js';

const time = (name: string) => timestamp(name, { withTimezone: true });
export const repositoryRequests = pgTable('repository_requests', {
  id: uuid('id').primaryKey().defaultRandom(), userId: uuid('user_id').notNull().references(() => users.id),
  owner: text('owner').notNull(), name: text('name').notNull(), repositoryUrl: text('repository_url').notNull(), reason: text('reason').notNull(),
  status: text('status').notNull().default('pending'), version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  repositoryId: uuid('repository_id').references(() => repositories.id), reviewerUserId: uuid('reviewer_user_id').references(() => users.id),
  reviewReason: text('review_reason'), reviewedAt: time('reviewed_at'),
  createdAt: time('created_at').notNull().default(sql`clock_timestamp()`), updatedAt: time('updated_at').notNull().default(sql`clock_timestamp()`),
}, t => [uniqueIndex('repository_requests_pending_unique').on(t.userId, sql`lower(${t.owner})`, sql`lower(${t.name})`).where(sql`${t.status}='pending'`),
  index('repository_requests_user_idx').on(t.userId, t.createdAt, t.id), index('repository_requests_status_idx').on(t.status, t.createdAt, t.id),
  check('repository_requests_owner_check', sql`${t.owner} ~ '^[A-Za-z0-9_.-]{1,100}$'`), check('repository_requests_name_check', sql`${t.name} ~ '^[A-Za-z0-9_.-]{1,100}$'`),
  check('repository_requests_reason_check', sql`length(btrim(${t.reason})) BETWEEN 1 AND 500`),
  check('repository_requests_status_check', sql`${t.status} IN ('pending','approved','rejected')`), check('repository_requests_version_check', sql`${t.version}>0`),
  check('repository_requests_review_reason_check', sql`length(btrim(${t.reviewReason})) BETWEEN 1 AND 500`),
  check('repository_requests_check', sql`(${t.status}='pending' AND ${t.repositoryId} IS NULL AND ${t.reviewerUserId} IS NULL AND ${t.reviewReason} IS NULL AND ${t.reviewedAt} IS NULL)
    OR (${t.status}='approved' AND ${t.repositoryId} IS NOT NULL AND ${t.reviewerUserId} IS NOT NULL AND ${t.reviewReason} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL)
    OR (${t.status}='rejected' AND ${t.repositoryId} IS NULL AND ${t.reviewerUserId} IS NOT NULL AND ${t.reviewReason} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL)`)]);
