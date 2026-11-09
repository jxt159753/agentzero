import { Type, type Static } from '@sinclair/typebox';
import { Amount, Name, Reason, Uuid } from './primitives.js';

export const RewardMonth = Type.String({ pattern: '^20[0-9]{2}-(0[1-9]|1[0-2])-01$' });
export const RewardStatus = Type.Union([Type.Literal('active'), Type.Literal('paused')]);
export const RewardRedemptionStatus = Type.Union([Type.Literal('pending'), Type.Literal('processing'), Type.Literal('fulfilled'), Type.Literal('cancelled')]);
export const RewardVersion = Type.String({ pattern: '^[1-9][0-9]{0,18}$' });
export const RewardQq = Type.String({ pattern: '^[1-9][0-9]{4,19}$', description: 'QQ number, 5–20 digits' });
export const RewardMonthParams = Type.Object({ month: RewardMonth }, { additionalProperties: false });
export const RewardCatalogQuery = Type.Object({ month: Type.Optional(RewardMonth) }, { additionalProperties: false });
export const RewardRedemptionQuery = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 1000 })),
  limit: Type.Optional(Type.String({ pattern: '^(?:[1-9][0-9]?|100)$' })),
  status: Type.Optional(RewardRedemptionStatus),
  claim_code: Type.Optional(Type.String({ pattern: '^RWD-[A-F0-9]{32}$' })),
}, { additionalProperties: false });
export const PutRewardPool = Type.Object({
  version: Amount, total_quantity: Amount, user_monthly_limit: Amount, contact_qq: RewardQq,
  instructions: Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' }), status: RewardStatus, reason: Reason,
}, { additionalProperties: false });
export const CreateRewardOffer = Type.Object({
  pool_id: Uuid, title: Name, description: Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' }),
  points_cost: Amount, total_quantity: Amount, reason: Reason,
}, { additionalProperties: false });
export const PatchRewardOffer = Type.Object({ version: RewardVersion, status: RewardStatus, add_quantity: Amount, reason: Reason }, { additionalProperties: false });
export const CreateRewardRedemption = Type.Object({ offer_id: Uuid, agent_id: Uuid, claimant_qq: RewardQq }, { additionalProperties: false });
export const RewardAction = Type.Object({ version: RewardVersion, reason: Reason }, { additionalProperties: false });
export const FulfillReward = Type.Object({
  version: RewardVersion, fulfillment_reference: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }), reason: Reason,
}, { additionalProperties: false });

export type PutRewardPoolInput = Static<typeof PutRewardPool>;
export type CreateRewardOfferInput = Static<typeof CreateRewardOffer>;
export type PatchRewardOfferInput = Static<typeof PatchRewardOffer>;
export type CreateRewardRedemptionInput = Static<typeof CreateRewardRedemption>;
export type RewardActionInput = Static<typeof RewardAction>;
export type FulfillRewardInput = Static<typeof FulfillReward>;
export type RewardRedemptionQueryInput = Static<typeof RewardRedemptionQuery>;

export interface RewardPoolDto {
  id: string; month: string; total_quantity: string; user_monthly_limit: string; contact_qq: string;
  instructions: string; status: 'active' | 'paused'; version: string; allocated_quantity: string;
}
export interface RewardOfferDto {
  id: string; pool_id: string; title: string; description: string; points_cost: string; total_quantity: string;
  redeemed_quantity: string; remaining_quantity: string; status: 'active' | 'paused'; version: string; created_at: string;
}
export interface RewardCatalogDto {
  pool: RewardPoolDto | null; offers: RewardOfferDto[]; redeemed_count: string; remaining_count: string;
}
export interface RewardRedemptionDto {
  id: string; claim_code: string; user_id: string; agent_id: string; github_login: string; agent_name: string;
  pool_id: string; offer_id: string; title: string; description: string; points_cost: string; contact_qq: string;
  instructions: string; claimant_qq: string; status: 'pending' | 'processing' | 'fulfilled' | 'cancelled'; version: string;
  payment_transaction_id: string; refund_transaction_id: string | null; fulfillment_reference: string | null;
  admin_note: string | null; created_at: string; updated_at: string; processed_by: string | null;
  fulfilled_at: string | null; cancelled_at: string | null;
}
