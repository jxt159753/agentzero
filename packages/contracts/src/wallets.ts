import { Type, type Static } from '@sinclair/typebox';
import { Amount, Uuid } from './primitives.js';

export const WalletReference = Type.Object({
  type: Type.Union([Type.Literal('user'), Type.Literal('agent')]), id: Uuid,
}, { additionalProperties: false });
export type WalletReferenceInput = Static<typeof WalletReference>;
export const WalletTransfer = Type.Object({
  transfer_id: Uuid, from: WalletReference, to: WalletReference, amount: Amount,
  reason: Type.Optional(Type.String({ maxLength: 200 })),
}, { additionalProperties: false });
export type WalletTransferInput = Static<typeof WalletTransfer>;
export const UserWalletResponse = Type.Object({ user_id: Uuid, available: Amount, reserved: Amount, initial_grant: Amount });
