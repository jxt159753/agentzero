import { sql } from 'drizzle-orm';
import { bigint, check, doublePrecision, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { agentKeys, agents, userSessions, users } from './schema.js';
import { tasks } from './schema-tasks.js';
import { landPlots } from './schema-market.js';

export const worldPositions = pgTable('world_positions', {
  kind: text('kind').notNull(), subjectId: uuid('subject_id').notNull(), userId: uuid('user_id').notNull().references(() => users.id),
  agentId: uuid('agent_id').references(() => agents.id), sessionId: uuid('session_id').references(() => userSessions.id),
  credentialId: uuid('credential_id').references(() => agentKeys.id), x: integer('x').notNull().default(0), y: integer('y').notNull().default(0),
  roomId: uuid('room_id').references(() => worldModelPlacements.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [primaryKey({ columns: [t.kind, t.subjectId] }), index('world_positions_room_idx').on(t.roomId), check('world_positions_kind_check', sql`${t.kind} IN ('visitor','agent')`),
  check('world_positions_x_check', sql`${t.x} BETWEEN -1000000 AND 1000000`), check('world_positions_y_check', sql`${t.y} BETWEEN -1000000 AND 1000000`),
  check('world_positions_check', sql`(${t.kind}='visitor' AND ${t.subjectId}=${t.userId} AND ${t.agentId} IS NULL AND ${t.sessionId} IS NOT NULL AND ${t.credentialId} IS NULL)
    OR (${t.kind}='agent' AND ${t.subjectId}=${t.agentId} AND ${t.agentId} IS NOT NULL AND ${t.sessionId} IS NULL AND ${t.credentialId} IS NOT NULL)`)]);

export const worldPublications = pgTable('world_publications', {
  agentId: uuid('agent_id').notNull().references(() => agents.id), taskId: uuid('task_id').notNull().references(() => tasks.id),
  summary: text('summary').notNull(), publishedBy: uuid('published_by').notNull().references(() => users.id),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [primaryKey({ columns: [t.agentId, t.taskId] }), index('world_publications_task_idx').on(t.taskId),
  check('world_publications_summary_check', sql`length(btrim(${t.summary})) BETWEEN 1 AND 500`)]);

export const worldModelPlacements = pgTable('world_model_placements', {
  id: uuid('id').primaryKey().defaultRandom(), landId: uuid('land_id').notNull().references(() => landPlots.id, { onDelete: 'cascade' }),
  modelId: text('model_id').notNull(), x: doublePrecision('x').notNull(), y: doublePrecision('y').notNull(),
  rotation: doublePrecision('rotation').notNull(), scale: doublePrecision('scale').notNull(),
  roomId: uuid('room_id'),
  version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
}, t => [index('world_model_placements_land_idx').on(t.landId),
  index('world_model_placements_room_idx').on(t.roomId), unique('world_model_placements_id_land_unique').on(t.id, t.landId),
  foreignKey({ name: 'world_model_placements_room_fk', columns: [t.roomId, t.landId], foreignColumns: [t.id, t.landId] }).onDelete('cascade'),
  check('world_model_placements_room_check', sql`${t.roomId} IS NULL OR (${t.roomId}<>${t.id} AND ${t.modelId} NOT IN ('studio','cabin','shed'))`),
  check('world_model_placements_model_id_check', sql`${t.modelId} IN ('studio','tree','lamp','bench','fountain','plant','bookshelf','cabin','shed','tent','fence','rock','flowerbox','pine','picnic','chair','barrel','crate','signpost','well','arcade')`),
  check('world_model_placements_x_check', sql`${t.x} BETWEEN -1000000 AND 1000000`),
  check('world_model_placements_y_check', sql`${t.y} BETWEEN -1000000 AND 1000000`),
  check('world_model_placements_rotation_check', sql`${t.rotation} BETWEEN 0 AND 359`),
  check('world_model_placements_scale_check', sql`${t.scale} BETWEEN 0.25 AND 2`),
  check('world_model_placements_version_check', sql`${t.version}>0`)]);
