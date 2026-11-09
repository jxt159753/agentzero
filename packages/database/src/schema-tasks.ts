import { sql } from 'drizzle-orm';
import { bigint,boolean,check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,timestamp,unique,uniqueIndex,uuid,type AnyPgColumn } from 'drizzle-orm/pg-core';
import { agents,creditHolds,journalTransactions,users } from './schema.js';
import { repositories } from './schema-github.js';

const id=()=>uuid('id').primaryKey().defaultRandom();
const createdAt=()=>timestamp('created_at',{withTimezone:true}).notNull().defaultNow();
const time=(name:string)=>timestamp(name,{withTimezone:true});
const points=(name:string)=>bigint(name,{mode:'bigint'});

export const tasks=pgTable('tasks',{
  id:id(),title:text('title').notNull(),description:text('description').notNull(),repositoryId:uuid('repository_id').notNull().references(()=>repositories.id),
  issueNumber:integer('issue_number'),acceptanceCriteria:text('acceptance_criteria').notNull(),requiredChecks:jsonb('required_checks').notNull(),
  rewardPoints:points('reward_points').notNull(),deadlineAt:time('deadline_at').notNull(),
  publisherUserId:uuid('publisher_user_id').notNull().references(()=>users.id),publisherAgentId:uuid('publisher_agent_id').references(()=>agents.id),
  payerAgentId:uuid('payer_agent_id').references(()=>agents.id),reviewerUserId:uuid('reviewer_user_id').notNull().references(()=>users.id),
  assigneeAgentId:uuid('assignee_agent_id').references(()=>agents.id),status:text('status').notNull().default('draft'),version:points('version').notNull().default(1n),
  holdId:uuid('hold_id').unique('tasks_hold_id_key').references(()=>creditHolds.id),latestDeliveryId:uuid('latest_delivery_id'),
  disputed:boolean('disputed').notNull().default(false),disputeReason:text('dispute_reason'),reviewDueAt:time('review_due_at'),reviewRemindedAt:time('review_reminded_at'),
  settledJournalId:uuid('settled_journal_id').unique('tasks_settled_journal_id_key').references(()=>journalTransactions.id),
  createdAt:createdAt(),updatedAt:time('updated_at').notNull().defaultNow(),publishedAt:time('published_at'),acceptedAt:time('accepted_at'),finalizedAt:time('finalized_at'),
},t=>[
  check('tasks_title_check',sql`length(btrim(${t.title})) BETWEEN 1 AND 80`),check('tasks_description_check',sql`length(btrim(${t.description})) BETWEEN 1 AND 8000`),
  check('tasks_acceptance_criteria_check',sql`length(btrim(${t.acceptanceCriteria})) BETWEEN 1 AND 8000`),check('tasks_reward_points_check',sql`${t.rewardPoints}>0`),
  check('tasks_issue_number_check',sql`${t.issueNumber}>0`),check('tasks_required_checks_check',sql`jsonb_typeof(${t.requiredChecks})='array'`),
  check('tasks_version_check',sql`${t.version}>0`),check('tasks_status_check',sql`${t.status} IN ('draft','open','in_progress','submitted','changes_requested','settled','cancelled')`),
  index('tasks_list_idx').on(t.createdAt.desc(),t.id.desc()),index('tasks_publisher_idx').on(t.publisherUserId,t.status),index('tasks_assignee_idx').on(t.assigneeAgentId,t.status),
  index('tasks_reviewer_idx').on(t.reviewerUserId,t.status),index('tasks_deadline_idx').on(t.deadlineAt).where(sql`${t.status} IN ('in_progress','changes_requested') AND NOT ${t.disputed}`),
  index('tasks_review_due_idx').on(t.reviewDueAt).where(sql`${t.status}='submitted' AND ${t.reviewRemindedAt} IS NULL`),
  check('tasks_check',sql`${t.payerAgentId} IS NULL OR ${t.payerAgentId} IS DISTINCT FROM ${t.assigneeAgentId}`),
  check('tasks_check1',sql`${t.status}='draft' OR ${t.holdId} IS NOT NULL`),
  check('tasks_check2',sql`${t.status} NOT IN ('in_progress','submitted','changes_requested','settled') OR ${t.assigneeAgentId} IS NOT NULL`),
  check('tasks_check3',sql`(${t.status} IN ('settled','cancelled'))=(${t.finalizedAt} IS NOT NULL)`),
  check('tasks_check4',sql`${t.status} NOT IN ('settled','cancelled') OR (${t.settledJournalId} IS NOT NULL AND NOT ${t.disputed})`),
  foreignKey({name:'tasks_latest_delivery_fkey',columns:[t.id,t.latestDeliveryId],foreignColumns:[taskDeliveries.taskId,taskDeliveries.id]}),
]);
export const taskDeliveries=pgTable('task_deliveries',{
  id:id(),taskId:uuid('task_id').notNull().references(():AnyPgColumn=>tasks.id),agentId:uuid('agent_id').notNull().references(()=>agents.id),
  prNumber:integer('pr_number').notNull(),headSha:text('head_sha').notNull(),prUrl:text('pr_url').notNull(),evidence:jsonb('evidence').notNull(),createdAt:createdAt(),
},t=>[unique('task_deliveries_task_id_id_key').on(t.taskId,t.id),index('task_deliveries_task_idx').on(t.taskId,t.createdAt),check('task_deliveries_pr_number_check',sql`${t.prNumber}>0`),check('task_deliveries_head_sha_check',sql`${t.headSha} ~ '^[0-9a-f]{40}$'`)]);
export const taskReviews=pgTable('task_reviews',{
  id:id(),taskId:uuid('task_id').notNull().references(()=>tasks.id),deliveryId:uuid('delivery_id'),reviewerUserId:uuid('reviewer_user_id').notNull().references(()=>users.id),
  decision:text('decision').notNull(),reason:text('reason').notNull(),unmetCriteria:text('unmet_criteria'),evidence:jsonb('evidence'),createdAt:createdAt(),
},t=>[foreignKey({columns:[t.taskId,t.deliveryId],foreignColumns:[taskDeliveries.taskId,taskDeliveries.id]}),index('task_reviews_task_idx').on(t.taskId,t.createdAt),
  check('task_reviews_decision_check',sql`${t.decision} IN ('accept','request_changes','resolve_settled','resolve_cancelled')`),
  check('task_reviews_reason_check',sql`length(btrim(${t.reason})) BETWEEN 1 AND 500`),check('task_reviews_check',sql`${t.decision}<>'request_changes' OR (${t.unmetCriteria} IS NOT NULL AND length(btrim(${t.unmetCriteria}))>0)`)]);
export const rewardedPullRequests=pgTable('rewarded_pull_requests',{
  repositoryId:uuid('repository_id').notNull().references(()=>repositories.id),prNumber:integer('pr_number').notNull(),
  taskId:uuid('task_id').notNull().unique('rewarded_pull_requests_task_id_key').references(()=>tasks.id),journalId:uuid('journal_id').notNull().unique('rewarded_pull_requests_journal_id_key').references(()=>journalTransactions.id),createdAt:createdAt(),
},t=>[primaryKey({columns:[t.repositoryId,t.prNumber]}),check('rewarded_pull_requests_pr_number_check',sql`${t.prNumber}>0`)]);
export const taskCancellationProposals=pgTable('task_cancellation_proposals',{
  id:id(),taskId:uuid('task_id').notNull().references(()=>tasks.id),paymentPoints:points('payment_points').notNull(),refundPoints:points('refund_points').notNull(),reason:text('reason').notNull(),
  status:text('status').notNull().default('pending'),publisherAccepted:boolean('publisher_accepted').notNull().default(false),assigneeAccepted:boolean('assignee_accepted').notNull().default(false),createdAt:createdAt(),acceptedAt:time('accepted_at'),
  payments:jsonb('payments').notNull().default([]),confirmations:jsonb('confirmations').notNull().default([]),
},t=>[index('task_cancellation_task_idx').on(t.taskId,t.createdAt),
  uniqueIndex('task_cancellation_pending_idx').on(t.taskId).where(sql`${t.status}='pending'`),
  check('task_cancellation_proposals_payment_points_check',sql`${t.paymentPoints}>=0`),check('task_cancellation_proposals_refund_points_check',sql`${t.refundPoints}>=0`),
  check('task_cancellation_proposals_reason_check',sql`length(btrim(${t.reason})) BETWEEN 1 AND 500`),check('task_cancellation_proposals_status_check',sql`${t.status} IN ('pending','accepted','superseded')`),
  check('task_cancellation_proposals_payments_check',sql`jsonb_typeof(${t.payments})='array'`),check('task_cancellation_proposals_confirmations_check',sql`jsonb_typeof(${t.confirmations})='array'`),
  check('task_cancellation_proposals_check',sql`${t.status}<>'accepted' OR (${t.publisherAccepted} AND ${t.assigneeAccepted} AND ${t.acceptedAt} IS NOT NULL)`)]);
export const taskEvents=pgTable('task_events',{
  id:id(),taskId:uuid('task_id').notNull().references(()=>tasks.id,{onDelete:'cascade'}),kind:text('kind').notNull(),actorType:text('actor_type').notNull(),
  actorUserId:uuid('actor_user_id').references(()=>users.id),actorAgentId:uuid('actor_agent_id').references(()=>agents.id),details:jsonb('details').notNull().default({}),createdAt:createdAt(),
},t=>[index('task_events_task_idx').on(t.taskId,t.createdAt,t.id),check('task_events_actor_type_check',sql`${t.actorType} IN ('user','agent','system')`)]);
