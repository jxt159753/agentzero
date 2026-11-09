import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { agents, journalTransactions, users } from './schema.js';
import { repositories } from './schema-github.js';

const points = (name: string) => bigint(name, { mode: 'bigint' });
const time = (name: string) => timestamp(name, { withTimezone: true });

export const contributionRewardSettings = pgTable('contribution_reward_settings', {
  id: integer('id').primaryKey().default(1),
  commitPoints: points('commit_points').notNull().default(0n),
  pullRequestPoints: points('pull_request_points').notNull().default(0n),
  issuePoints: points('issue_points').notNull().default(0n),
  version: points('version').notNull().default(1n),
  updatedAt: time('updated_at').notNull().default(sql`clock_timestamp()`),
}, t => [check('contribution_reward_settings_id_check', sql`${t.id}=1`),
  check('contribution_reward_settings_commit_points_check', sql`${t.commitPoints}>=0`),
  check('contribution_reward_settings_pull_request_points_check', sql`${t.pullRequestPoints}>=0`),
  check('contribution_reward_settings_issue_points_check', sql`${t.issuePoints}>=0`),
  check('contribution_reward_settings_version_check', sql`${t.version}>0`)]);

export const contributionRewardPreferences = pgTable('contribution_reward_preferences', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  agentId: uuid('agent_id').references(() => agents.id), version: points('version').notNull().default(1n),
  updatedAt: time('updated_at').notNull().default(sql`clock_timestamp()`),
}, t => [check('contribution_reward_preferences_version_check', sql`${t.version}>0`)]);

export const contributionRewards = pgTable('contribution_rewards', {
  id: uuid('id').primaryKey().defaultRandom(), repositoryId: uuid('repository_id').notNull().references(() => repositories.id),
  kind: text('kind').notNull(), objectId: text('object_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id), agentId: uuid('agent_id').notNull().references(() => agents.id),
  points: points('points').notNull(), settingsVersion: points('settings_version').notNull(),
  url: text('url').notNull(), title: text('title').notNull(), githubCreatedAt: time('github_created_at').notNull(),
  transactionId: uuid('transaction_id').notNull().unique().references(() => journalTransactions.id),
  createdAt: time('created_at').notNull().default(sql`clock_timestamp()`),
}, t => [unique().on(t.repositoryId, t.kind, t.objectId), index('contribution_rewards_user_idx').on(t.userId, t.createdAt, t.id),
  check('contribution_rewards_kind_check', sql`${t.kind} IN ('commit','pull_request','issue')`),
  check('contribution_rewards_points_check', sql`${t.points}>0`), check('contribution_rewards_settings_version_check', sql`${t.settingsVersion}>0`),
  check('contribution_rewards_object_id_check', sql`(${t.kind}='commit' AND ${t.objectId} ~ '^[0-9a-f]{40}$') OR (${t.kind} IN ('pull_request','issue') AND ${t.objectId} ~ '^[1-9][0-9]*$')`)]);
