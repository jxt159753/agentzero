import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents, creditHolds, users } from './schema.js';
import { worldModelPlacements } from './schema-world.js';

export const arcadeGames = pgTable('arcade_games', {
  id: uuid('id').primaryKey().defaultRandom(), authorAgentId: uuid('author_agent_id').notNull().references(() => agents.id),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id), name: text('name').notNull(), description: text('description').notNull(),
  entryFee: bigint('entry_fee', { mode: 'bigint' }).notNull(), maxReward: bigint('max_reward', { mode: 'bigint' }).notNull(),
  minimumPool: bigint('minimum_pool', { mode: 'bigint' }).notNull(),
  settlementRule: text('settlement_rule').notNull().default('manual'),
  moderationBlocked: boolean('moderation_blocked').notNull().default(false),
  source: jsonb('source').notNull(), status: text('status').notNull().default('paused'), version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
  poolHoldId: uuid('pool_hold_id').references(() => creditHolds.id), poolBalance: bigint('pool_balance', { mode: 'bigint' }).notNull().default(0n),
  poolCommitted: bigint('pool_committed', { mode: 'bigint' }).notNull().default(0n), createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [index('arcade_games_owner_idx').on(t.ownerUserId, t.createdAt), check('arcade_games_pool_check', sql`${t.poolCommitted}>=0 AND ${t.poolCommitted}<=${t.poolBalance}`),
  check('arcade_games_settlement_rule_check', sql`${t.settlementRule} IN ('manual','starlight_slots_v1') AND (${t.settlementRule}='manual' OR (${t.entryFee}=1 AND ${t.maxReward}=3))`)]);
export const arcadeGameMachines = pgTable('arcade_game_machines', {
  placementId: uuid('placement_id').primaryKey().references(() => worldModelPlacements.id, { onDelete: 'cascade' }),
  gameId: uuid('game_id').notNull().references(() => arcadeGames.id),
});
export const arcadeGameSessions = pgTable('arcade_game_sessions', {
  id: uuid('id').primaryKey().defaultRandom(), gameId: uuid('game_id').notNull().references(() => arcadeGames.id),
  playerAgentId: uuid('player_agent_id').references(() => agents.id), playerUserId: uuid('player_user_id').notNull().references(() => users.id),
  feeHoldId: uuid('fee_hold_id').notNull().unique().references(() => creditHolds.id), gameVersion: bigint('game_version', { mode: 'bigint' }).notNull(),
  entryFee: bigint('entry_fee', { mode: 'bigint' }).notNull(), maxReward: bigint('max_reward', { mode: 'bigint' }).notNull(),
  settlementRule: text('settlement_rule').notNull().default('manual'),
  status: text('status').notNull().default('playing'), score: bigint('score', { mode: 'bigint' }),
  rewardRequested: bigint('reward_requested', { mode: 'bigint' }), rewardPoints: bigint('reward_points', { mode: 'bigint' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()+interval '30 minutes'`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`), settledAt: timestamp('settled_at', { withTimezone: true }),
}, t => [index('arcade_sessions_player_idx').on(t.playerUserId, t.createdAt), index('arcade_sessions_game_idx').on(t.gameId, t.createdAt),
  check('arcade_sessions_settlement_rule_check', sql`${t.settlementRule} IN ('manual','starlight_slots_v1') AND (${t.settlementRule}='manual' OR (${t.entryFee}=1 AND ${t.maxReward}=3))`)]);
