import { sql } from 'drizzle-orm';
import { boolean,check,customType,index,integer,jsonb,pgTable,text,timestamp,uuid } from 'drizzle-orm/pg-core';
const createdAt=()=>timestamp('created_at',{withTimezone:true}).notNull().defaultNow();
const updatedAt=()=>timestamp('updated_at',{withTimezone:true}).notNull().defaultNow();
const bytea=customType<{data:Buffer}>({dataType:()=>'bytea'});
export const githubInstallations=pgTable('github_installations',{
  installationId:text('installation_id').primaryKey(),accountLogin:text('account_login').notNull(),status:text('status').notNull(),createdAt:createdAt(),updatedAt:updatedAt(),
},t=>[check('github_installations_installation_id_check',sql`${t.installationId} ~ '^[1-9][0-9]*$'`),check('github_installations_status_check',sql`${t.status} IN ('active','suspended','deleted')`)]);
export const repositories=pgTable('repositories',{
  id:uuid('id').primaryKey().defaultRandom(),githubId:text('github_id').notNull().unique(),installationId:text('installation_id').notNull().references(()=>githubInstallations.installationId),
  owner:text('owner').notNull(),name:text('name').notNull(),fullName:text('full_name').notNull(),isPrivate:boolean('is_private').notNull().default(false),
  status:text('status').notNull().default('approved'),createdAt:createdAt(),updatedAt:updatedAt(),
},t=>[index('repositories_installation_idx').on(t.installationId),check('repositories_github_id_check',sql`${t.githubId} ~ '^[1-9][0-9]*$'`),check('repositories_status_check',sql`${t.status} IN ('approved','disabled')`),check('repositories_check',sql`NOT ${t.isPrivate} OR ${t.status}='disabled'`)]);
export const githubDeliveries=pgTable('github_deliveries',{
  deliveryId:text('delivery_id').primaryKey(),eventName:text('event_name').notNull(),payloadHash:bytea('payload_hash').notNull(),payload:jsonb('payload').notNull(),status:text('status').notNull().default('pending'),
  attempts:integer('attempts').notNull().default(0),lastError:text('last_error'),nextAttemptAt:timestamp('next_attempt_at',{withTimezone:true}).notNull().defaultNow(),
  createdAt:createdAt(),processedAt:timestamp('processed_at',{withTimezone:true}),
},t=>[check('github_deliveries_status_check',sql`${t.status} IN ('pending','processed')`),index('github_deliveries_pending_idx').on(t.nextAttemptAt).where(sql`${t.status}='pending'`)]);
