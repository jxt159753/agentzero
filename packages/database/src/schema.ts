import { sql } from 'drizzle-orm';
export * from './schema-github.js';
export * from './schema-tasks.js';
export * from './schema-collaboration.js';
export * from './schema-messages.js';
export * from './schema-rewards.js';
export * from './schema-market.js';
export * from './schema-world.js';
export * from './schema-games.js';
import { bigint, boolean, check, customType, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const points = (name: string) => bigint(name, { mode: 'bigint' });

export const users = pgTable('users', {
  id: id(), githubUserId: points('github_user_id').notNull().unique('users_github_user_id_key'), githubLogin: text('github_login').notNull(),
  displayName: text('display_name').notNull(), avatarUrl: text('avatar_url'),
  status: text('status').notNull().default('pending'), role: text('role').notNull().default('member'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [check('users_github_user_id_check', sql`${t.githubUserId} > 0`),
  check('users_status_check', sql`${t.status} IN ('pending', 'active', 'suspended')`),
  check('users_role_check', sql`${t.role} IN ('member', 'admin')`)]);

export const oauthLoginStates = pgTable('oauth_login_states', {
  id: id(), stateHash: bytea('state_hash').notNull().unique('oauth_login_states_state_hash_key'), browserBindingHash: bytea('browser_binding_hash').notNull(),
  codeVerifier: text('code_verifier').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }), createdAt: createdAt(),
}, (t) => [index('oauth_login_states_expiry_idx').on(t.expiresAt)]);

export const userSessions = pgTable('user_sessions', {
  id: id(), userId: uuid('user_id').notNull().references(() => users.id), tokenHash: bytea('token_hash').notNull().unique('user_sessions_token_hash_key'),
  csrfTokenHash: bytea('csrf_token_hash').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }), createdAt: createdAt(),
}, (t) => [index('user_sessions_user_idx').on(t.userId)]);

export const agents = pgTable('agents', {
  id: id(), ownerUserId: uuid('owner_user_id').notNull().references(() => users.id), name: text('name').notNull(),
  status: text('status').notNull().default('active'), version: points('version').notNull().default(1n),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('agents_owner_idx').on(t.ownerUserId), unique('agents_id_owner_user_id_key').on(t.id, t.ownerUserId), check('agents_name_check', sql`length(btrim(${t.name})) BETWEEN 1 AND 100`),
  check('agents_status_check', sql`${t.status} IN ('active', 'paused')`), check('agents_version_check', sql`${t.version} > 0`),
  check('agents_deleted_paused', sql`${t.deletedAt} IS NULL OR ${t.status} = 'paused'`)]);

export const agentPolicies = pgTable('agent_policies', {
  agentId: uuid('agent_id').primaryKey().references(() => agents.id), canAcceptTask: boolean('can_accept_task').notNull().default(false),
  canCollaborate: boolean('can_collaborate').notNull().default(false), canTrade: boolean('can_trade').notNull().default(false),
  canRedeemApi: boolean('can_redeem_api').notNull().default(false), singleSpendLimit: points('single_spend_limit').notNull().default(0n),
  dailySpendLimit: points('daily_spend_limit').notNull().default(0n), version: points('version').notNull().default(1n), updatedAt: updatedAt(),
}, (t) => [check('agent_policies_single_spend_limit_check', sql`${t.singleSpendLimit} >= 0`),
  check('agent_policies_daily_spend_limit_check', sql`${t.dailySpendLimit} >= 0`), check('agent_policies_version_check', sql`${t.version} > 0`)]);

export const agentKeys = pgTable('agent_keys', {
  id: id(), agentId: uuid('agent_id').notNull().references(() => agents.id), label: text('label').notNull(),
  secretHash: bytea('secret_hash').notNull().unique('agent_keys_secret_hash_key'), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull().default(sql`now() + interval '90 days'`),
  revokedAt: timestamp('revoked_at', { withTimezone: true }), createdAt: createdAt(),
}, (t) => [index('agent_keys_agent_idx').on(t.agentId)]);

export const ledgerAccounts = pgTable('ledger_accounts', {
  id: id(), agentId: uuid('agent_id').references(() => agents.id), userId: uuid('user_id').references(() => users.id), systemKey: text('system_key').unique('ledger_accounts_system_key_key'), bucket: text('bucket').notNull(),
  normalSide: text('normal_side').notNull(), balance: points('balance').notNull().default(0n), createdAt: createdAt(),
}, (t) => [unique('ledger_accounts_agent_id_bucket_key').on(t.agentId, t.bucket), unique('ledger_accounts_user_id_bucket_key').on(t.userId, t.bucket), check('ledger_accounts_balance_check', sql`${t.balance} >= 0`),
  check('ledger_accounts_check', sql`(${t.agentId} IS NOT NULL AND ${t.userId} IS NULL AND ${t.systemKey} IS NULL AND ${t.bucket} IN ('AVAILABLE', 'RESERVED') AND ${t.normalSide} = 'debit')
    OR (${t.agentId} IS NULL AND ${t.userId} IS NOT NULL AND ${t.systemKey} IS NULL AND ${t.bucket} IN ('USER_AVAILABLE', 'USER_RESERVED') AND ${t.normalSide} = 'debit')
    OR (${t.agentId} IS NULL AND ${t.userId} IS NULL AND ${t.systemKey} IS NOT NULL AND ${t.bucket} = ${t.systemKey}
      AND ((${t.systemKey} IN ('REWARD_POOL', 'REWARD_RESERVED', 'RECOVERY') AND ${t.normalSide} = 'debit')
        OR (${t.systemKey} = 'ISSUANCE_CONTROL' AND ${t.normalSide} = 'credit')))`)]);

export const journalTransactions = pgTable('journal_transactions', {
  id: id(), kind: text('kind').notNull(), businessKey: text('business_key').notNull().unique('journal_transactions_business_key_key'), payloadHash: bytea('payload_hash').notNull(),
  actorType: text('actor_type').notNull(), actorUserId: uuid('actor_user_id').references(() => users.id),
  actorAgentId: uuid('actor_agent_id').references(() => agents.id), representedAgentId: uuid('represented_agent_id').references(() => agents.id),
  credentialId: uuid('credential_id').references(() => agentKeys.id), payerAgentId: uuid('payer_agent_id').references(() => agents.id),
  spendPoints: points('spend_points').notNull().default(0n), businessDate: date('business_date').notNull(),
  correctionOf: uuid('correction_of').references((): AnyPgColumn => journalTransactions.id), reason: text('reason').notNull(), createdAt: createdAt(),
}, (t) => [index('journal_payer_date_idx').on(t.payerAgentId, t.businessDate), index('journal_created_idx').on(t.createdAt, t.id),
  check('journal_transactions_kind_check', sql`${t.kind} IN ('ISSUE', 'INITIAL_GRANT', 'TRANSFER', 'RESERVE', 'ADJUST_HOLD', 'FINALIZE_HOLD', 'PAY', 'REFUND', 'RECYCLE', 'ADMIN_ADJUST')`),
  check('journal_transactions_spend_points_check', sql`${t.spendPoints} >= 0`),
  check('journal_transactions_reason_check', sql`length(btrim(${t.reason})) > 0`),
  check('journal_transactions_check', sql`(${t.actorType} = 'user' AND ${t.actorUserId} IS NOT NULL AND ${t.actorAgentId} IS NULL AND ${t.credentialId} IS NULL)
    OR (${t.actorType} = 'agent' AND ${t.actorUserId} IS NULL AND ${t.actorAgentId} IS NOT NULL AND ${t.credentialId} IS NOT NULL)
    OR (${t.actorType} = 'system' AND ${t.actorUserId} IS NULL AND ${t.actorAgentId} IS NULL AND ${t.credentialId} IS NULL)`),
  check('journal_transactions_check1', sql`${t.spendPoints} = 0 OR ${t.payerAgentId} IS NOT NULL`)]);

export const journalEntries = pgTable('journal_entries', {
  transactionId: uuid('transaction_id').notNull().references(() => journalTransactions.id), lineNo: integer('line_no').notNull(),
  accountId: uuid('account_id').notNull().references(() => ledgerAccounts.id), side: text('side').notNull(), amount: points('amount').notNull(),
}, (t) => [primaryKey({ columns: [t.transactionId, t.lineNo] }), unique('journal_entries_transaction_id_account_id_key').on(t.transactionId, t.accountId),
  index('journal_entries_account_idx').on(t.accountId, t.transactionId), check('journal_entries_line_no_check', sql`${t.lineNo} > 0`),
  check('journal_entries_side_check', sql`${t.side} IN ('debit', 'credit')`), check('journal_entries_amount_check', sql`${t.amount} > 0`)]);

export const creditHolds = pgTable('credit_holds', {
  id: id(), businessRef: text('business_ref').notNull().unique('credit_holds_business_ref_key'), payerAgentId: uuid('payer_agent_id').references(() => agents.id),
  payerUserId: uuid('payer_user_id').references(() => users.id),
  sourceAccountId: uuid('source_account_id').notNull().references(() => ledgerAccounts.id),
  reservedAccountId: uuid('reserved_account_id').notNull().references(() => ledgerAccounts.id),
  reservedTotal: points('reserved_total').notNull(), capturedTotal: points('captured_total').notNull().default(0n),
  releasedTotal: points('released_total').notNull().default(0n), status: text('status').notNull().default('open'),
  version: points('version').notNull().default(1n), createdAt: createdAt(), closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => [index('credit_holds_payer_status_idx').on(t.payerAgentId, t.status),
  check('credit_holds_payer_check', sql`${t.payerAgentId} IS NULL OR ${t.payerUserId} IS NULL`),
  check('credit_holds_reserved_total_check', sql`${t.reservedTotal} >= 0`), check('credit_holds_captured_total_check', sql`${t.capturedTotal} >= 0`),
  check('credit_holds_released_total_check', sql`${t.releasedTotal} >= 0`), check('credit_holds_status_check', sql`${t.status} IN ('open', 'closed')`),
  check('credit_holds_version_check', sql`${t.version} > 0`), check('credit_holds_check', sql`${t.sourceAccountId} <> ${t.reservedAccountId}`),
  check('credit_holds_check1', sql`${t.capturedTotal}::numeric + ${t.releasedTotal}::numeric <= ${t.reservedTotal}::numeric`),
  check('credit_holds_check2', sql`(${t.status} = 'open' AND ${t.closedAt} IS NULL) OR (${t.status} = 'closed' AND ${t.closedAt} IS NOT NULL
    AND ${t.capturedTotal}::numeric + ${t.releasedTotal}::numeric = ${t.reservedTotal}::numeric)`)]);

export const creditIssuancePeriods = pgTable('credit_issuance_periods', {
  period: date('period').primaryKey(), limitPoints: points('limit_points').notNull().default(0n), issuedPoints: points('issued_points').notNull().default(0n),
  updatedBy: uuid('updated_by').notNull().references(() => users.id), updatedAt: updatedAt(),
}, (t) => [check('credit_issuance_periods_period_check', sql`extract(day FROM ${t.period}) = 1`),
  check('credit_issuance_periods_limit_points_check', sql`${t.limitPoints} >= 0`),
  check('credit_issuance_periods_issued_points_check', sql`${t.issuedPoints} >= 0 AND ${t.issuedPoints} <= ${t.limitPoints}`)]);

export const idempotencyRequests = pgTable('idempotency_requests', {
  id: id(), principalKey: text('principal_key').notNull(), routeKey: text('route_key').notNull(), idempotencyKey: text('idempotency_key').notNull(),
  requestHash: bytea('request_hash').notNull(), status: text('status').notNull().default('processing'), responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'), resourceType: text('resource_type'), resourceId: uuid('resource_id'), createdAt: createdAt(),
}, (t) => [unique('idempotency_requests_principal_key_route_key_idempotency_key_key').on(t.principalKey, t.routeKey, t.idempotencyKey), check('idempotency_requests_status_check', sql`${t.status} IN ('processing', 'completed')`),
  check('idempotency_requests_check', sql`${t.status} <> 'completed' OR (${t.responseStatus} IS NOT NULL AND ${t.responseStatus} BETWEEN 100 AND 599 AND ${t.responseBody} IS NOT NULL)`)]);

export const auditEvents = pgTable('audit_events', {
  id: id(), actorType: text('actor_type').notNull(), actorUserId: uuid('actor_user_id').references(() => users.id),
  actorAgentId: uuid('actor_agent_id').references(() => agents.id), representedAgentId: uuid('represented_agent_id').references(() => agents.id),
  credentialId: uuid('credential_id').references(() => agentKeys.id), action: text('action').notNull(), targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(), requestId: text('request_id').notNull(), businessKey: text('business_key'),
  details: jsonb('details').notNull().default({}), createdAt: createdAt(),
}, (t) => [index('audit_target_idx').on(t.targetType, t.targetId, t.createdAt, t.id), index('audit_actor_idx').on(t.actorUserId, t.createdAt, t.id),
  index('audit_business_idx').on(t.businessKey),
  check('audit_events_check', sql`(${t.actorType} = 'user' AND ${t.actorUserId} IS NOT NULL AND ${t.actorAgentId} IS NULL AND ${t.credentialId} IS NULL)
    OR (${t.actorType} = 'agent' AND ${t.actorUserId} IS NULL AND ${t.actorAgentId} IS NOT NULL AND ${t.credentialId} IS NOT NULL)
    OR (${t.actorType} = 'system' AND ${t.actorUserId} IS NULL AND ${t.actorAgentId} IS NULL AND ${t.credentialId} IS NULL)`)]);
