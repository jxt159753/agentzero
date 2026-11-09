import { sql } from 'drizzle-orm';
import { bigint, check, date, foreignKey, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { agents, journalTransactions, users } from './schema.js';

const quantity = (name: string) => bigint(name, { mode: 'bigint' });
const time = (name: string) => timestamp(name, { withTimezone: true });

export const rewardPools = pgTable('reward_pools', {
  id: uuid('id').primaryKey().defaultRandom(), month: date('month').notNull().unique(),
  totalQuantity: quantity('total_quantity').notNull().default(0n), allocatedQuantity: quantity('allocated_quantity').notNull().default(0n),
  userMonthlyLimit: quantity('user_monthly_limit').notNull().default(0n), contactQq: text('contact_qq').notNull(), instructions: text('instructions').notNull(),
  status: text('status').notNull().default('active'), version: quantity('version').notNull().default(1n),
  createdBy: uuid('created_by').notNull().references(() => users.id), updatedBy: uuid('updated_by').notNull().references(() => users.id),
  createdAt: time('created_at').notNull().default(sql`clock_timestamp()`), updatedAt: time('updated_at').notNull().default(sql`clock_timestamp()`),
}, t => [check('reward_pools_month_check', sql`extract(day FROM ${t.month})=1`),
  check('reward_pools_total_quantity_check', sql`${t.totalQuantity}>=0`),
  check('reward_pools_allocated_quantity_check', sql`${t.allocatedQuantity}>=0 AND ${t.allocatedQuantity}<=${t.totalQuantity}`),
  check('reward_pools_user_monthly_limit_check', sql`${t.userMonthlyLimit}>=0 AND ${t.userMonthlyLimit}<=${t.totalQuantity}`),
  check('reward_pools_contact_qq_check', sql`${t.contactQq} ~ '^[1-9][0-9]{4,19}$'`),
  check('reward_pools_instructions_check', sql`length(btrim(${t.instructions})) BETWEEN 1 AND 2000`),
  check('reward_pools_status_check', sql`${t.status} IN ('active','paused')`), check('reward_pools_version_check', sql`${t.version}>0`)]);

export const rewardOffers = pgTable('reward_offers', {
  id: uuid('id').primaryKey().defaultRandom(), poolId: uuid('pool_id').notNull().references(() => rewardPools.id),
  title: text('title').notNull(), description: text('description').notNull(), pointsCost: quantity('points_cost').notNull(),
  totalQuantity: quantity('total_quantity').notNull().default(0n), redeemedQuantity: quantity('redeemed_quantity').notNull().default(0n),
  status: text('status').notNull().default('active'), version: quantity('version').notNull().default(1n), createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: time('created_at').notNull().default(sql`clock_timestamp()`), updatedAt: time('updated_at').notNull().default(sql`clock_timestamp()`),
}, t => [unique().on(t.id, t.poolId), index('reward_offers_pool_idx').on(t.poolId, t.createdAt, t.id),
  check('reward_offers_title_check', sql`length(btrim(${t.title})) BETWEEN 1 AND 80`), check('reward_offers_description_check', sql`length(btrim(${t.description})) BETWEEN 1 AND 2000`),
  check('reward_offers_points_cost_check', sql`${t.pointsCost}>0`), check('reward_offers_total_quantity_check', sql`${t.totalQuantity}>=0`),
  check('reward_offers_redeemed_quantity_check', sql`${t.redeemedQuantity}>=0 AND ${t.redeemedQuantity}<=${t.totalQuantity}`),
  check('reward_offers_status_check', sql`${t.status} IN ('active','paused')`), check('reward_offers_version_check', sql`${t.version}>0`)]);

export const rewardRedemptions = pgTable('reward_redemptions', {
  id: uuid('id').primaryKey().defaultRandom(), claimCode: text('claim_code').notNull().unique(), userId: uuid('user_id').notNull().references(() => users.id),
  agentId: uuid('agent_id').notNull().references(() => agents.id), poolId: uuid('pool_id').notNull().references(() => rewardPools.id), offerId: uuid('offer_id').notNull(),
  title: text('title').notNull(), description: text('description').notNull(), pointsCost: quantity('points_cost').notNull(), contactQq: text('contact_qq').notNull(),
  instructions: text('instructions').notNull(), claimantQq: text('claimant_qq').notNull(), status: text('status').notNull().default('pending'), version: quantity('version').notNull().default(1n),
  paymentTransactionId: uuid('payment_transaction_id').notNull().unique().references(() => journalTransactions.id),
  refundTransactionId: uuid('refund_transaction_id').unique().references(() => journalTransactions.id), fulfillmentReference: text('fulfillment_reference'), adminNote: text('admin_note'),
  processedBy: uuid('processed_by').references(() => users.id), fulfilledAt: time('fulfilled_at'), cancelledAt: time('cancelled_at'),
  createdAt: time('created_at').notNull().default(sql`clock_timestamp()`), updatedAt: time('updated_at').notNull().default(sql`clock_timestamp()`),
}, t => [foreignKey({ columns: [t.offerId, t.poolId], foreignColumns: [rewardOffers.id, rewardOffers.poolId] }),
  index('reward_redemptions_user_pool_idx').on(t.userId, t.poolId), index('reward_redemptions_user_page_idx').on(t.userId, t.createdAt, t.id),
  index('reward_redemptions_agent_page_idx').on(t.agentId, t.createdAt, t.id), index('reward_redemptions_status_page_idx').on(t.status, t.createdAt, t.id),
  check('reward_redemptions_claim_code_check', sql`${t.claimCode} ~ '^RWD-[A-F0-9]{32}$'`), check('reward_redemptions_points_cost_check', sql`${t.pointsCost}>0`),
  check('reward_redemptions_contact_qq_check', sql`${t.contactQq} ~ '^[1-9][0-9]{4,19}$'`), check('reward_redemptions_claimant_qq_check', sql`${t.claimantQq} ~ '^[1-9][0-9]{4,19}$'`),
  check('reward_redemptions_status_check', sql`${t.status} IN ('pending','processing','fulfilled','cancelled')`), check('reward_redemptions_version_check', sql`${t.version}>0`),
  check('reward_redemptions_fulfillment_reference_check', sql`length(btrim(${t.fulfillmentReference})) BETWEEN 1 AND 500`), check('reward_redemptions_admin_note_check', sql`length(btrim(${t.adminNote})) BETWEEN 1 AND 500`),
  check('reward_redemptions_check', sql`(${t.status} IN ('pending','processing') AND ${t.refundTransactionId} IS NULL AND ${t.fulfillmentReference} IS NULL AND ${t.fulfilledAt} IS NULL AND ${t.cancelledAt} IS NULL)
    OR (${t.status}='fulfilled' AND ${t.refundTransactionId} IS NULL AND ${t.fulfillmentReference} IS NOT NULL AND ${t.fulfilledAt} IS NOT NULL AND ${t.cancelledAt} IS NULL)
    OR (${t.status}='cancelled' AND ${t.refundTransactionId} IS NOT NULL AND ${t.fulfillmentReference} IS NULL AND ${t.fulfilledAt} IS NULL AND ${t.cancelledAt} IS NOT NULL)`),
  check('reward_redemptions_check1', sql`${t.status} NOT IN ('processing','fulfilled') OR ${t.processedBy} IS NOT NULL`)]);
