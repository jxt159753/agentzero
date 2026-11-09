import { Type, type Static } from '@sinclair/typebox';
import { Amount, Uuid, Name, Reason } from './primitives.js';
export { Amount, Uuid, Name, Reason } from './primitives.js';

export const Month = Type.String({ pattern: '^20[0-9]{2}-(0[1-9]|1[0-2])-01$' });
export const IdParams = Type.Object({ id: Uuid });
export const KeyParams = Type.Object({ id: Uuid, keyId: Uuid });
export const PageQuery = Type.Object({ cursor: Type.Optional(Type.String({ maxLength: 1000 })), limit: Type.Optional(Type.String({ pattern: '^(?:[1-9][0-9]?|100)$', default: '30' })) });
export const CreateAgent = Type.Object({ name: Name }, { additionalProperties: false });
export const PatchAgent = Type.Object({ name: Type.Optional(Name), status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('paused')])) }, { additionalProperties: false, minProperties: 1 });
export const DeleteAgent = Type.Object({ version: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }) }, { additionalProperties: false });
export const Policy = Type.Object({
  version: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
  can_accept_task: Type.Boolean(), can_collaborate: Type.Boolean(), can_trade: Type.Boolean(), can_redeem_api: Type.Boolean(),
  single_spend_limit: Amount, daily_spend_limit: Amount,
}, { additionalProperties: false });
export type PolicyInput = Static<typeof Policy>;
export const CreateKey = Type.Object({ label: Name }, { additionalProperties: false });
export const UserStatusChange = Type.Object({ status: Type.Union([Type.Literal('active'), Type.Literal('suspended'), Type.Literal('pending')]), reason: Reason }, { additionalProperties: false });
export const IssuanceLimit = Type.Object({ limit_points: Amount, reason: Reason }, { additionalProperties: false });
export const Issue = Type.Object({ month: Month, amount: Amount, reason: Reason, business_id: Uuid }, { additionalProperties: false });
export const ErrorResponse = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }) });
export const AgentResponse = Type.Object({ id: Uuid, owner_user_id: Uuid, name: Type.String(), status: Type.Union([Type.Literal('active'),Type.Literal('paused')]), version: Type.String(), deleted_at: Type.Union([Type.Null(),Type.String()]), created_at: Type.String(), updated_at: Type.String(), operation_id: Type.Optional(Uuid) });
export const KeyResponse = Type.Object({ id: Uuid, label: Type.String(), expires_at: Type.String(), revoked_at: Type.Optional(Type.Union([Type.Null(), Type.String()])), created_at: Type.Optional(Type.String()), secret: Type.Optional(Type.String()), secret_shown: Type.Optional(Type.Boolean()), operation_id: Type.Optional(Uuid) });
export const WalletResponse = Type.Object({ available: Amount, reserved: Amount, daily_spent: Amount, held: Amount, daily_usage: Amount, business_date: Type.String() });
export type AgentDto = Static<typeof AgentResponse>;
export type KeyDto = Static<typeof KeyResponse>;
export type WalletDto = Static<typeof WalletResponse>;

export type Actor =
  | { type: 'user'; userId: string; sessionId: string; representedAgentId?: string }
  | { type: 'agent'; agentId: string; ownerUserId: string; credentialId: string }
  | { type: 'system' };
export const errorCodes = ['UNAUTHENTICATED','ACCESS_DENIED','ACCOUNT_PENDING','ACCOUNT_SUSPENDED','AGENT_PAUSED','AGENT_DELETED','AGENT_DELETE_BLOCKED','AGENT_VERSION_CONFLICT','CREDENTIAL_REVOKED','POLICY_VERSION_CONFLICT','INSUFFICIENT_FUNDS','SPEND_LIMIT_EXCEEDED','ISSUANCE_LIMIT_EXCEEDED','IDEMPOTENCY_CONFLICT','BUSINESS_ALREADY_FINALIZED','BUSINESS_CONFLICT','INVALID_AMOUNT','INVALID_REQUEST','CSRF_INVALID','OAUTH_INVALID','OAUTH_UNAVAILABLE','LEDGER_INCONSISTENT','LEDGER_QUARANTINED','INVALID_INPUT','ISSUANCE_PERIOD_CHANGED','INVALID_ISSUANCE_PERIOD','NOT_FOUND','NO_CHANGE','INVALID_SETTLEMENT','INVALID_REFUND'] as const;
export type ErrorCode = typeof errorCodes[number];
export function parseAmount(value: string, positive = false): bigint {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) throw new Error('INVALID_AMOUNT');
  const amount = BigInt(value);
  if (amount > 9223372036854775807n || (positive && amount === 0n)) throw new Error('INVALID_AMOUNT');
  return amount;
}
export * from './tasks.js';
export * from './collaboration.js';
export * from './messages.js';
export * from './rewards.js';
export * from './market.js';
export * from './world.js';
export * from './world-models.js';
export * from './games.js';
export * from './contributions.js';
export * from './repository-requests.js';
export * from './wallets.js';
