import { Type, type Static } from '@sinclair/typebox';
import { Reason, Uuid } from './primitives.js';
import { MarketVersion, type ItemInstanceDto, type LandPlotDto, type MarketListingDto } from './market.js';
import type { WorldModelPlacement } from './world-models.js';

export const AdminAssetAction = Type.Object({ version: MarketVersion, reason: Reason }, { additionalProperties: false });
export const AdminLandModeration = Type.Object({ version: MarketVersion, reason: Reason,
  trading_frozen: Type.Optional(Type.Boolean()), showcase_hidden: Type.Optional(Type.Boolean()),
}, { additionalProperties: false, minProperties: 3 });
export const AdminItemModeration = Type.Object({ version: MarketVersion, reason: Reason, trading_frozen: Type.Boolean() }, { additionalProperties: false });
export const AdminGameModeration = Type.Object({ version: MarketVersion, reason: Reason, moderation_blocked: Type.Boolean() }, { additionalProperties: false });
export const AdminAssetTransfer = Type.Object({
  version: MarketVersion, expected_owner_agent_id: Type.Union([Uuid, Type.Null()]), target_agent_id: Uuid, reason: Reason,
  mode: Type.Union([Type.Literal('transfer'), Type.Literal('recover')]),
}, { additionalProperties: false });
export type AdminAssetActionInput = Static<typeof AdminAssetAction>;
export type AdminLandModerationInput = Static<typeof AdminLandModeration>;
export type AdminItemModerationInput = Static<typeof AdminItemModeration>;
export type AdminGameModerationInput = Static<typeof AdminGameModeration>;
export type AdminAssetTransferInput = Static<typeof AdminAssetTransfer>;
export interface AdminAssetCatalog {
  lands: LandPlotDto[];
  items: (ItemInstanceDto & { owner_agent_name: string; owner_github_login: string })[];
  listings: MarketListingDto[];
  models: (WorldModelPlacement & { land_id: string })[];
}
