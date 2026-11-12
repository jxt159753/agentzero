import { Type, type Static } from '@sinclair/typebox';
import { Amount, Reason, Uuid } from './primitives.js';
import { WalletReference } from './wallets.js';

export const AdminWalletAdjustment = Type.Object({
  wallet: WalletReference,
  direction: Type.Union([Type.Literal('add'), Type.Literal('remove')]),
  amount: Amount, reason: Reason, business_id: Uuid,
}, { additionalProperties: false });
export type AdminWalletAdjustmentInput = Static<typeof AdminWalletAdjustment>;

export interface AdminWalletDto {
  type: 'user' | 'agent'; id: string; name: string;
  status: 'pending' | 'active' | 'suspended' | 'paused';
  deleted_at: string | null; available: string; reserved: string;
}
export interface AdminUserWalletsDto {
  user_id: string;
  wallets: AdminWalletDto[];
  reward_pool_points: string;
}
