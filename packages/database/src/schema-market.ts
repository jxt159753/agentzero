import { sql } from 'drizzle-orm';
import { bigint, boolean, check, doublePrecision, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agents, journalTransactions, users } from './schema.js';

const points = (name: string) => bigint(name, { mode: 'bigint' });
const time = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => time('created_at').notNull().default(sql`clock_timestamp()`);
const updatedAt = () => time('updated_at').notNull().default(sql`clock_timestamp()`);

export const marketSettings = pgTable('market_settings', {
  id: integer('id').primaryKey().default(1), userLandLimit: integer('user_land_limit').notNull().default(3),
  defaultLandSupplied: boolean('default_land_supplied').notNull().default(false),
  version: points('version').notNull().default(1n), updatedAt: updatedAt(),
}, t => [check('market_settings_id_check', sql`${t.id}=1`), check('market_settings_user_land_limit_check', sql`${t.userLandLimit} BETWEEN 0 AND 1000`), check('market_settings_version_check', sql`${t.version}>0`)]);

export const landPlots = pgTable('land_plots', {
  id: uuid('id').primaryKey().defaultRandom(), code: text('code').notNull().unique(), x: doublePrecision('x').notNull(), y: doublePrecision('y').notNull(), area: doublePrecision('area').notNull(),
  width: doublePrecision('width'), height: doublePrecision('height'),
  pointsPrice: points('points_price').notNull(), buildingTemplate: text('building_template').notNull().default('studio'), ownerAgentId: uuid('owner_agent_id').references(() => agents.id),
  ownerUserId: uuid('owner_user_id').references(() => users.id),
  name: text('name').notNull().default('默认工作室'), worksUrl: text('works_url'), version: points('version').notNull().default(1n),
  createdBy: uuid('created_by').references(() => users.id), createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [unique().on(t.x, t.y), unique().on(t.id, t.ownerAgentId), index('land_plots_owner_idx').on(t.ownerAgentId),
  index('land_plots_owner_user_idx').on(t.ownerUserId),
  foreignKey({ name: 'land_plots_owner_agent_user_fkey', columns: [t.ownerAgentId, t.ownerUserId], foreignColumns: [agents.id, agents.ownerUserId] }),
  check('land_plots_ownership_check', sql`(${t.ownerUserId} IS NULL)=(${t.ownerAgentId} IS NULL)`),
  check('land_plots_code_check', sql`${t.code} ~ '^[A-Za-z0-9_-]{1,40}$'`), check('land_plots_x_check', sql`${t.x} BETWEEN -1000000 AND 1000000`),
  check('land_plots_y_check', sql`${t.y} BETWEEN -1000000 AND 1000000`), check('land_plots_area_check', sql`${t.area}>0 AND ${t.area}<=1000000`),
  check('land_plots_dimensions_check', sql`(${t.width} IS NULL AND ${t.height} IS NULL) OR (${t.width} IS NOT NULL AND ${t.height} IS NOT NULL
    AND ${t.width}>0 AND ${t.width}<=2000000 AND ${t.height}>0 AND ${t.height}<=2000000
    AND abs(${t.area}-${t.width}*${t.height}*100)<0.000001)`),
  check('land_plots_points_price_check', sql`${t.pointsPrice}>0`), check('land_plots_building_template_check', sql`${t.buildingTemplate}='studio'`),
  check('land_plots_name_check', sql`length(btrim(${t.name})) BETWEEN 1 AND 80`), check('land_plots_works_url_check', sql`${t.worksUrl} ~ '^https://' AND length(${t.worksUrl})<=2000`),
  check('land_plots_version_check', sql`${t.version}>0`)]);

export const itemTemplates = pgTable('item_templates', {
  id: uuid('id').primaryKey().defaultRandom(), name: text('name').notNull(), description: text('description').notNull(), appearance: text('appearance').notNull(),
  pointsPrice: points('points_price').notNull(), totalQuantity: points('total_quantity').notNull().default(0n), issuedQuantity: points('issued_quantity').notNull().default(0n),
  status: text('status').notNull().default('active'), version: points('version').notNull().default(1n),
  createdBy: uuid('created_by').notNull().references(() => users.id), createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [check('item_templates_name_check', sql`length(btrim(${t.name})) BETWEEN 1 AND 80`), check('item_templates_description_check', sql`length(btrim(${t.description})) BETWEEN 1 AND 2000`),
  check('item_templates_appearance_check', sql`${t.appearance} IN ('plant','lamp','bookshelf','banner')`), check('item_templates_points_price_check', sql`${t.pointsPrice}>0`),
  check('item_templates_total_quantity_check', sql`${t.totalQuantity}>=0`), check('item_templates_issued_quantity_check', sql`${t.issuedQuantity}>=0 AND ${t.issuedQuantity}<=${t.totalQuantity}`),
  check('item_templates_status_check', sql`${t.status} IN ('active','paused')`), check('item_templates_version_check', sql`${t.version}>0`)]);

export const itemInstances = pgTable('item_instances', {
  id: uuid('id').primaryKey().defaultRandom(), templateId: uuid('template_id').notNull().references(() => itemTemplates.id),
  ownerAgentId: uuid('owner_agent_id').notNull().references(() => agents.id), landId: uuid('land_id'),
  version: points('version').notNull().default(1n), createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [foreignKey({ columns: [t.landId, t.ownerAgentId], foreignColumns: [landPlots.id, landPlots.ownerAgentId] }),
  index('item_instances_owner_idx').on(t.ownerAgentId), index('item_instances_land_idx').on(t.landId), check('item_instances_version_check', sql`${t.version}>0`)]);

export const marketListings = pgTable('market_listings', {
  id: uuid('id').primaryKey().defaultRandom(), sellerAgentId: uuid('seller_agent_id').notNull().references(() => agents.id),
  landId: uuid('land_id').references(() => landPlots.id), itemId: uuid('item_id').references(() => itemInstances.id),
  pointsPrice: points('points_price').notNull(), status: text('status').notNull().default('active'), version: points('version').notNull().default(1n),
  createdAt: createdAt(), closedAt: time('closed_at'),
}, t => [uniqueIndex('market_listings_active_land_idx').on(t.landId).where(sql`${t.status}='active'`),
  uniqueIndex('market_listings_active_item_idx').on(t.itemId).where(sql`${t.status}='active'`), index('market_listings_seller_idx').on(t.sellerAgentId, t.createdAt, t.id),
  check('market_listings_points_price_check', sql`${t.pointsPrice}>0`), check('market_listings_status_check', sql`${t.status} IN ('active','sold','cancelled')`),
  check('market_listings_version_check', sql`${t.version}>0`), check('market_listings_check', sql`num_nonnulls(${t.landId},${t.itemId})=1`),
  check('market_listings_check1', sql`(${t.status}='active')=(${t.closedAt} IS NULL)`)]);

export const marketTrades = pgTable('market_trades', {
  id: uuid('id').primaryKey().defaultRandom(), listingId: uuid('listing_id').unique().references(() => marketListings.id),
  landId: uuid('land_id').references(() => landPlots.id), itemId: uuid('item_id').references(() => itemInstances.id),
  buyerAgentId: uuid('buyer_agent_id').notNull().references(() => agents.id), sellerAgentId: uuid('seller_agent_id').references(() => agents.id),
  pointsPrice: points('points_price').notNull(), transactionId: uuid('transaction_id').notNull().unique().references(() => journalTransactions.id),
  assetSnapshot: jsonb('asset_snapshot').notNull(), createdAt: createdAt(),
}, t => [uniqueIndex('market_trades_initial_land_idx').on(t.landId).where(sql`${t.listingId} IS NULL AND ${t.landId} IS NOT NULL`),
  uniqueIndex('market_trades_initial_item_idx').on(t.itemId).where(sql`${t.listingId} IS NULL AND ${t.itemId} IS NOT NULL`),
  index('market_trades_buyer_idx').on(t.buyerAgentId, t.createdAt, t.id), index('market_trades_seller_idx').on(t.sellerAgentId, t.createdAt, t.id),
  check('market_trades_points_price_check', sql`${t.pointsPrice}>0`), check('market_trades_check', sql`num_nonnulls(${t.landId},${t.itemId})=1`),
  check('market_trades_check1', sql`(${t.listingId} IS NULL)=(${t.sellerAgentId} IS NULL)`), check('market_trades_check2', sql`${t.buyerAgentId} IS DISTINCT FROM ${t.sellerAgentId}`)]);
