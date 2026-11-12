import { Type, type Static } from '@sinclair/typebox';
import { Amount, Name, Reason, Uuid } from './primitives.js';

export const MarketVersion = Type.String({ pattern: '^[1-9][0-9]{0,18}$' });
export const MarketTemplateStatus = Type.Union([Type.Literal('active'), Type.Literal('paused')]);
export const ItemAppearance = Type.Union([Type.Literal('plant'), Type.Literal('lamp'), Type.Literal('bookshelf'), Type.Literal('banner')]);
export const PutMarketSettings = Type.Object({ version: MarketVersion, user_land_limit: Type.Integer({ minimum: 0, maximum: 1000 }), reason: Reason }, { additionalProperties: false });
export const CreateLandSupply = Type.Object({
  plots: Type.Array(Type.Object({
    code: Type.String({ minLength: 1, maxLength: 40, pattern: '^[A-Za-z0-9_-]+$' }),
    x: Type.Integer({ minimum: -1000000, maximum: 1000000 }), y: Type.Integer({ minimum: -1000000, maximum: 1000000 }),
    area: Type.Integer({ minimum: 1, maximum: 1000000 }), points_price: Amount,
    building_template: Type.Literal('studio'),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }), reason: Reason,
}, { additionalProperties: false });
export const CreateItemTemplate = Type.Object({
  name: Name, description: Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' }), appearance: ItemAppearance,
  points_price: Amount, total_quantity: Amount, reason: Reason,
}, { additionalProperties: false });
export const PatchItemTemplate = Type.Object({ version: MarketVersion, status: MarketTemplateStatus, add_quantity: Amount, reason: Reason }, { additionalProperties: false });
export const PatchLandPrice = Type.Object({ version: MarketVersion, points_price: Amount, reason: Reason }, { additionalProperties: false });
export const BuyMarketAsset = Type.Object({ agent_id: Uuid, version: MarketVersion }, { additionalProperties: false });
export const CreateMarketListing = Type.Object({
  agent_id: Uuid, land_id: Type.Optional(Uuid), item_id: Type.Optional(Uuid), asset_version: MarketVersion, points_price: Amount,
}, { additionalProperties: false });
export const CancelMarketListing = Type.Object({ version: MarketVersion }, { additionalProperties: false });
export const MAX_LAND_SHOWCASE_ITEMS = 8;
const ShowcaseTitle = Type.Optional(Type.String({ maxLength: 80 }));
const ShowcaseUrl = Type.String({ format: 'uri', maxLength: 2000, pattern: '^https://' });
export const LandShowcaseItem = Type.Union([
  Type.Object({ type: Type.Literal('text'), title: ShowcaseTitle, text: Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' }) }, { additionalProperties: false }),
  ...(['image', 'video', 'webpage'] as const).map(type => Type.Object({ type: Type.Literal(type), title: ShowcaseTitle, url: ShowcaseUrl }, { additionalProperties: false })),
]);
export type LandShowcaseItem = Static<typeof LandShowcaseItem>;
export const LandShowcase = Type.Array(LandShowcaseItem, { maxItems: MAX_LAND_SHOWCASE_ITEMS });
export const PatchStudio = Type.Object({
  agent_id: Uuid, version: MarketVersion, name: Name,
  works_url: Type.Union([Type.Null(), Type.String({ format: 'uri', maxLength: 2000, pattern: '^https://' })]),
  showcase: Type.Optional(LandShowcase),
}, { additionalProperties: false });
export const PlaceMarketItem = Type.Object({
  agent_id: Uuid, version: MarketVersion, land_id: Type.Union([Uuid, Type.Null()]),
}, { additionalProperties: false });

export type PutMarketSettingsInput = Static<typeof PutMarketSettings>;
export type CreateLandSupplyInput = Static<typeof CreateLandSupply>;
export type CreateItemTemplateInput = Static<typeof CreateItemTemplate>;
export type PatchItemTemplateInput = Static<typeof PatchItemTemplate>;
export type PatchLandPriceInput = Static<typeof PatchLandPrice>;
export type BuyMarketAssetInput = Static<typeof BuyMarketAsset>;
export type CreateMarketListingInput = Static<typeof CreateMarketListing>;
export type CancelMarketListingInput = Static<typeof CancelMarketListing>;
export type PatchStudioInput = Static<typeof PatchStudio>;
export type PlaceMarketItemInput = Static<typeof PlaceMarketItem>;

export interface MarketSettingsDto { user_land_limit: number; version: string }
export interface LandPlotDto {
  id: string; code: string; x: number; y: number; area: number; points_price: string; building_template: 'studio';
  width?: number | null; height?: number | null;
  // The user owns the land; the Agent pays for and manages it on their behalf.
  owner_agent_id: string | null; owner_agent_name: string | null; name: string; works_url: string | null;
  showcase?: LandShowcaseItem[];
  trading_frozen?: boolean; showcase_hidden?: boolean;
  owner_user_id: string | null; owner_github_login: string | null; tradeable: boolean;
  version: string; active_listing_id: string | null; created_at: string;
}
export interface ItemTemplateDto {
  id: string; name: string; description: string; appearance: 'plant' | 'lamp' | 'bookshelf' | 'banner';
  points_price: string; total_quantity: string; issued_quantity: string; remaining_quantity: string;
  status: 'active' | 'paused'; version: string; created_at: string;
}
export interface ItemInstanceDto {
  trading_frozen?: boolean;
  id: string; template_id: string; owner_agent_id: string; land_id: string | null;
  name: string; description: string; appearance: ItemTemplateDto['appearance'];
  version: string; active_listing_id: string | null; created_at: string;
}
export interface MarketListingDto {
  id: string; seller_agent_id: string; seller_agent_name: string; seller_user_id: string;
  land_id: string | null; item_id: string | null; points_price: string; status: 'active' | 'sold' | 'cancelled';
  version: string; land: LandPlotDto | null; item: ItemInstanceDto | null; created_at: string;
}
export interface MarketTradeDto {
  id: string; listing_id: string | null; land_id: string | null; item_id: string | null;
  buyer_agent_id: string; seller_agent_id: string | null; points_price: string;
  transaction_id: string; created_at: string;
}
export interface MarketCatalogDto {
  settings: MarketSettingsDto; user_land_count: number; lands: LandPlotDto[]; templates: ItemTemplateDto[]; listings: MarketListingDto[];
}
export interface MarketAssetsDto {
  agent_id: string; settings: MarketSettingsDto; user_land_count: number;
  lands: LandPlotDto[]; items: ItemInstanceDto[]; listings: MarketListingDto[];
}
