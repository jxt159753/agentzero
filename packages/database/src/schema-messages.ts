import { sql } from 'drizzle-orm';
import { bigint,boolean,check,index,pgTable,text,timestamp,unique,uuid } from 'drizzle-orm/pg-core';
import { agents,users } from './schema.js';
import { tasks } from './schema-tasks.js';

export const conversations=pgTable('conversations',{
  id:uuid('id').primaryKey().defaultRandom(),kind:text('kind').notNull(),taskId:uuid('task_id').unique().references(()=>tasks.id,{onDelete:'cascade'}),
  directKey:text('direct_key').unique(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[check('conversations_kind_check',sql`${t.kind} IN ('direct','task')`),check('conversations_check',sql`(${t.kind}='task' AND ${t.taskId} IS NOT NULL AND ${t.directKey} IS NULL) OR (${t.kind}='direct' AND ${t.taskId} IS NULL AND ${t.directKey} IS NOT NULL)`)]);
export const conversationMembers=pgTable('conversation_members',{
  id:uuid('id').primaryKey().defaultRandom(),conversationId:uuid('conversation_id').notNull().references(()=>conversations.id,{onDelete:'cascade'}),
  userId:uuid('user_id').references(()=>users.id),agentId:uuid('agent_id').references(()=>agents.id),
},t=>[check('conversation_members_check',sql`(${t.userId} IS NULL)<>(${t.agentId} IS NULL)`),unique().on(t.conversationId,t.userId),unique().on(t.conversationId,t.agentId),index('conversation_members_user_idx').on(t.userId,t.conversationId),index('conversation_members_agent_idx').on(t.agentId,t.conversationId)]);
export const messageCursor=pgTable('message_cursor',{
  singleton:boolean('singleton').primaryKey().default(true),value:bigint('value',{mode:'bigint'}).notNull().default(0n),
},t=>[check('message_cursor_singleton_check',sql`${t.singleton}`),check('message_cursor_value_check',sql`${t.value}>=0`)]);
export const messages=pgTable('messages',{
  id:uuid('id').primaryKey().defaultRandom(),cursor:bigint('cursor',{mode:'bigint'}).notNull().unique(),conversationId:uuid('conversation_id').notNull().references(()=>conversations.id,{onDelete:'cascade'}),
  senderUserId:uuid('sender_user_id').references(()=>users.id),senderAgentId:uuid('sender_agent_id').references(()=>agents.id),actorUserId:uuid('actor_user_id').notNull().references(()=>users.id),
  body:text('body').notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().default(sql`clock_timestamp()`),
},t=>[check('messages_cursor_check',sql`${t.cursor}>0`),check('messages_body_check',sql`length(btrim(${t.body})) BETWEEN 1 AND 8000`),check('messages_check',sql`(${t.senderUserId} IS NULL)<>(${t.senderAgentId} IS NULL)`),index('messages_conversation_cursor_idx').on(t.conversationId,t.cursor)]);
