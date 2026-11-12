import { randomUUID } from 'node:crypto';
import { landOverlapsPublicArea, parseAmount, WORLD_METERS_PER_UNIT, worldLandSize, type Actor, type BuyMarketAssetInput, type CancelMarketListingInput, type CreateItemTemplateInput,
  type CreateLandSupplyInput, type CreateMarketListingInput, type ItemInstanceDto, type ItemTemplateDto, type LandPlotDto,
  type MarketAssetsDto, type MarketCatalogDto, type MarketListingDto, type MarketSettingsDto, type MarketTradeDto,
  type PatchItemTemplateInput, type PatchLandPriceInput, type PatchStudioInput, type PlaceMarketItemInput, type PutMarketSettingsInput,
  type AdminAssetActionInput, type AdminAssetCatalog, type AdminAssetTransferInput, type AdminLandModerationInput, type AdminItemModerationInput } from '@agentzero/contracts';
import type { Tx } from '@agentzero/database';
import { AppError, audit, type CommandResult } from '../../core.js';
import { finalizeHold, pay, reserve } from '../ledger/service.js';

type LandRow = Omit<LandPlotDto, 'created_at' | 'tradeable'> & { created_at: Date | string };
type ItemRow = Omit<ItemInstanceDto, 'created_at'> & { created_at: Date | string };
type TemplateRow = Omit<ItemTemplateDto, 'created_at' | 'remaining_quantity'> & { created_at: Date | string };
type ListingRow = Omit<MarketListingDto, 'land' | 'item' | 'created_at'> & { created_at: Date | string };

const landSelect = `SELECT l.id,l.code,l.x,l.y,l.area,l.width,l.height,l.points_price,l.building_template,l.owner_agent_id,
  a.name AS owner_agent_name,l.owner_user_id,u.github_login AS owner_github_login,
  l.name,l.works_url,l.showcase,l.trading_frozen,l.showcase_hidden,l.version,l.created_at,ml.id AS active_listing_id
  FROM land_plots l LEFT JOIN agents a ON a.id=l.owner_agent_id
  LEFT JOIN users u ON u.id=l.owner_user_id
  LEFT JOIN market_listings ml ON ml.land_id=l.id AND ml.status='active'`;
const itemSelect = `SELECT i.id,i.template_id,i.owner_agent_id,i.land_id,i.trading_frozen,i.version,i.created_at,
  t.name,t.description,t.appearance,ml.id AS active_listing_id FROM item_instances i
  JOIN item_templates t ON t.id=i.template_id LEFT JOIN market_listings ml ON ml.item_id=i.id AND ml.status='active'`;
const listingSelect = `SELECT ml.id,ml.seller_agent_id,a.name AS seller_agent_name,a.owner_user_id AS seller_user_id,
  ml.land_id,ml.item_id,ml.points_price,ml.status,ml.version,ml.created_at FROM market_listings ml JOIN agents a ON a.id=ml.seller_agent_id`;

const dated = <T extends { created_at: Date | string }>(row: T) => ({ ...row, created_at: new Date(row.created_at).toISOString() });
const landBody = (row: LandRow, admin = false): LandPlotDto => ({ ...dated(row), tradeable: !row.trading_frozen && !landOverlapsPublicArea(row),
  ...(!admin && row.showcase_hidden ? { name: '展示已屏蔽', works_url: null, showcase: [] } : {}) });
function tradable(asset: { trading_frozen?: boolean }) {
  if (asset.trading_frozen) throw new AppError('ASSET_TRADING_FROZEN', 409, '管理员已冻结此资产交易');
}
function requirePrivateLand(land: { x: number; y: number; area: number; width?: number | null; height?: number | null }) {
  if (landOverlapsPublicArea(land)) throw new AppError('PUBLIC_LAND_NOT_TRADEABLE', 409, '公共广场、道路和公共设施用地不可购买或挂牌');
}
const templateBody = (row: TemplateRow): ItemTemplateDto => ({ ...dated(row), remaining_quantity: (BigInt(row.total_quantity) - BigInt(row.issued_quantity)).toString() });
export const marketUserId = (actor: Actor) => {
  if (actor.type === 'system') throw new AppError('ACCESS_DENIED', 403);
  return actor.type === 'user' ? actor.userId : actor.ownerUserId;
};
function adminId(actor: Actor) {
  if (actor.type !== 'user') throw new AppError('ACCESS_DENIED', 403);
  return actor.userId;
}
function version(current: string, expected: string) {
  parseAmount(expected, true);
  if (current !== expected) throw new AppError('MARKET_VERSION_CONFLICT', 409, '资产或报价已变化，请刷新后重试');
}
function ownership(owner: string | null, agentId: string) {
  if (owner !== agentId) throw new AppError('ACCESS_DENIED', 403, '只能操作所选 Agent 持有或管理的资产');
}
function editable(listingId: string | null) {
  if (listingId) throw new AppError('ASSET_LISTED', 409, '资产已挂牌，请先撤单再编辑或移动');
}
async function tradePolicy(tx: Tx, agentId: string) {
  const policy = (await tx.query<{ can_trade: boolean }>('SELECT can_trade FROM agent_policies WHERE agent_id=$1 FOR UPDATE', [agentId])).rows[0];
  if (!policy?.can_trade) throw new AppError('ACCESS_DENIED', 403, '请先开启此 Agent 的资产交易权限');
}
export async function settings(tx: Tx): Promise<MarketSettingsDto> {
  const row = (await tx.query<MarketSettingsDto>('SELECT user_land_limit,version FROM market_settings WHERE id=1 FOR SHARE')).rows[0];
  if (!row) throw new AppError('LEDGER_INCONSISTENT', 409);
  return row;
}
async function userLandCount(tx: Tx, userId: string): Promise<number> {
  return (await tx.query<{ count: number }>('SELECT count(*)::integer AS count FROM land_plots WHERE owner_user_id=$1', [userId])).rows[0]!.count;
}
async function requireLandCapacity(tx: Tx, actor: Actor) {
  const config = await settings(tx);
  // runCommand holds the owner's user row, serializing all their Agents' acquisitions.
  if (await userLandCount(tx, marketUserId(actor)) >= config.user_land_limit) throw new AppError('LAND_LIMIT_EXCEEDED', 409, '已达到每位用户合计持有的土地上限');
}
export async function loadLand(tx: Tx, id: string, lock = false, admin = false): Promise<LandPlotDto> {
  const row = (await tx.query<LandRow>(`${landSelect} WHERE l.id=$1${lock ? ' FOR UPDATE OF l' : ''}`, [id])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, '地块不存在');
  return landBody(row, admin);
}
export async function loadItem(tx: Tx, id: string, lock = false): Promise<ItemInstanceDto> {
  const row = (await tx.query<ItemRow>(`${itemSelect} WHERE i.id=$1${lock ? ' FOR UPDATE OF i' : ''}`, [id])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, '物品不存在');
  return dated(row);
}
async function loadTemplate(tx: Tx, id: string, lock = false): Promise<ItemTemplateDto> {
  const row = (await tx.query<TemplateRow>(`SELECT id,name,description,appearance,points_price,total_quantity,issued_quantity,status,version,created_at FROM item_templates WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, '物品模板不存在');
  return templateBody(row);
}
export async function listingOwner(tx: Tx, id: string) {
  const row = (await tx.query<{ seller_agent_id: string; seller_user_id: string }>(
    'SELECT ml.seller_agent_id,a.owner_user_id AS seller_user_id FROM market_listings ml JOIN agents a ON a.id=ml.seller_agent_id WHERE ml.id=$1', [id])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, '挂牌不存在');
  return row;
}
async function listingRows(tx: Tx, condition: string, args: unknown[], lock = false): Promise<MarketListingDto[]> {
  const rows = (await tx.query<ListingRow>(`${listingSelect} WHERE ${condition} ORDER BY ml.created_at DESC,ml.id DESC${lock ? ' FOR UPDATE OF ml' : ''}`, args)).rows;
  if (!rows.length) return [];
  const lands = (await tx.query<LandRow>(`${landSelect} WHERE l.id=ANY($1::uuid[])`, [rows.flatMap(row => row.status === 'active' && row.land_id ? [row.land_id] : [])])).rows;
  const items = (await tx.query<ItemRow>(`${itemSelect} WHERE i.id=ANY($1::uuid[])`, [rows.flatMap(row => row.status === 'active' && row.item_id ? [row.item_id] : [])])).rows;
  const landMap = new Map(lands.map(row => [row.id, landBody(row)])), itemMap = new Map(items.map(row => [row.id, dated(row)]));
  // Closed quotes identify the original asset, but never expose its subsequent owner's private inventory state.
  return rows.map(row => {
    const land = row.land_id ? landMap.get(row.land_id) : undefined, item = row.item_id ? itemMap.get(row.item_id) : undefined;
    // READ COMMITTED queries may straddle a sale: only attach an asset still belonging to this active quote.
    return { ...dated(row), land: row.status === 'active' && land?.active_listing_id === row.id ? land : null,
      item: row.status === 'active' && item?.active_listing_id === row.id ? item : null };
  });
}
export async function loadListing(tx: Tx, id: string, lock = false): Promise<MarketListingDto> {
  const row = (await listingRows(tx, 'ml.id=$1', [id], lock))[0];
  if (!row) throw new AppError('NOT_FOUND', 404, '挂牌不存在');
  return row;
}
export async function readItem(tx: Tx, id: string, actor: Actor) {
  const item = await loadItem(tx, id);
  if (!item.active_listing_id) {
    const owner = (await tx.query<{ owner_user_id: string }>('SELECT owner_user_id FROM agents WHERE id=$1', [item.owner_agent_id])).rows[0]!;
    if (actor.type === 'agent' ? actor.agentId !== item.owner_agent_id : owner.owner_user_id !== marketUserId(actor)) throw new AppError('NOT_FOUND', 404);
  }
  return item;
}
export async function marketCatalog(tx: Tx, actor: Actor, admin = false): Promise<MarketCatalogDto> {
  const config = await settings(tx);
  const lands = (await tx.query<LandRow>(`${landSelect} ORDER BY l.created_at DESC,l.id DESC`)).rows.map(row => landBody(row));
  const templates = (await tx.query<TemplateRow>('SELECT id,name,description,appearance,points_price,total_quantity,issued_quantity,status,version,created_at FROM item_templates ORDER BY created_at DESC,id DESC')).rows.map(templateBody);
  return { settings: config, user_land_count: await userLandCount(tx, marketUserId(actor)), lands, templates,
    listings: await listingRows(tx, admin ? 'true' : "ml.status='active'", []) };
}
export async function marketAssets(tx: Tx, actor: Actor, agentId: string): Promise<MarketAssetsDto> {
  const lands = (await tx.query<LandRow>(`${landSelect} WHERE l.owner_agent_id=$1 ORDER BY l.created_at DESC,l.id DESC`, [agentId])).rows.map(row => landBody(row));
  const items = (await tx.query<ItemRow>(`${itemSelect} WHERE i.owner_agent_id=$1 ORDER BY i.created_at DESC,i.id DESC`, [agentId])).rows.map(dated);
  return { agent_id: agentId, settings: await settings(tx), user_land_count: await userLandCount(tx, marketUserId(actor)),
    lands, items, listings: await listingRows(tx, 'ml.seller_agent_id=$1', [agentId]) };
}

export async function putMarketSettings(tx: Tx, actor: Actor, requestId: string, input: PutMarketSettingsInput): Promise<CommandResult> {
  const current = (await tx.query<MarketSettingsDto>('SELECT user_land_limit,version FROM market_settings WHERE id=1 FOR UPDATE')).rows[0]!;
  version(current.version, input.version);
  await tx.query('UPDATE market_settings SET user_land_limit=$1,version=version+1,updated_at=clock_timestamp() WHERE id=1', [input.user_land_limit]);
  await audit(tx, actor, 'market.settings_changed', 'market_settings', '1', requestId, { ...input });
  return { status: 200, body: { ...await settings(tx) } };
}
export async function createLandSupply(tx: Tx, actor: Actor, requestId: string, input: CreateLandSupplyInput): Promise<CommandResult> {
  // Serialize supply across administrators so the geometry check and insertion are one decision.
  await tx.query('SELECT id FROM market_settings WHERE id=1 FOR UPDATE');
  const ids: string[] = [];
  for (const plot of input.plots) {
    parseAmount(plot.points_price, true);
    requirePrivateLand(plot);
    const overlap = await tx.query(`SELECT 1 FROM land_plots
      WHERE abs(x-$1)<COALESCE(width/2,sqrt(area::double precision)/$4)+$3-1e-9
        AND abs(y-$2)<COALESCE(height/2,sqrt(area::double precision)/$4)+$3-1e-9 LIMIT 1`,
    [plot.x, plot.y, worldLandSize(plot.area) / 2, WORLD_METERS_PER_UNIT * 2]);
    if (overlap.rowCount) throw new AppError('LAND_SUPPLY_CONFLICT', 409, '地块占地范围与已有或同批地块重叠，整批供应未创建');
    const row = (await tx.query<{ id: string }>(`INSERT INTO land_plots(code,x,y,area,points_price,building_template,created_by,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,transaction_timestamp()) ON CONFLICT DO NOTHING RETURNING id`, [plot.code, plot.x, plot.y, plot.area, plot.points_price, plot.building_template, adminId(actor)])).rows[0];
    if (!row) throw new AppError('LAND_SUPPLY_CONFLICT', 409, '地块编号或位置已存在，整批供应未创建');
    ids.push(row.id);
  }
  const lands = (await tx.query<LandRow>(`${landSelect} WHERE l.id=ANY($1::uuid[]) ORDER BY l.code`, [ids])).rows.map(row => landBody(row));
  await audit(tx, actor, 'market.land_supplied', 'land_supply', ids[0]!, requestId, { reason: input.reason, count: ids.length, plots: input.plots });
  return { status: 201, body: { lands }, resourceType: 'land', resourceId: ids[0] };
}
export async function patchLandPrice(tx: Tx, actor: Actor, requestId: string, id: string, input: PatchLandPriceInput): Promise<CommandResult> {
  const land = await loadLand(tx, id, true);
  version(land.version, input.version);
  requirePrivateLand(land);
  if (land.owner_user_id) throw new AppError('ASSET_UNAVAILABLE', 409, '已售土地由产权人通过管理 Agent 挂牌定价，不能修改系统售价');
  parseAmount(input.points_price, true);
  await tx.query('UPDATE land_plots SET points_price=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [id, input.points_price]);
  await audit(tx, actor, 'market.land_price_updated', 'land', id, requestId, { ...input, previous_points_price: land.points_price });
  return { status: 200, body: { ...await loadLand(tx, id) }, resourceType: 'land', resourceId: id };
}
export async function createItemTemplate(tx: Tx, actor: Actor, requestId: string, input: CreateItemTemplateInput): Promise<CommandResult> {
  parseAmount(input.points_price, true); parseAmount(input.total_quantity);
  const row = (await tx.query<{ id: string }>(`INSERT INTO item_templates(name,description,appearance,points_price,total_quantity,created_by)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [input.name.trim(), input.description.trim(), input.appearance, input.points_price, input.total_quantity, adminId(actor)])).rows[0]!;
  await audit(tx, actor, 'market.template_created', 'item_template', row.id, requestId, { ...input });
  return { status: 201, body: { ...await loadTemplate(tx, row.id) }, resourceType: 'item_template', resourceId: row.id };
}
export async function patchItemTemplate(tx: Tx, actor: Actor, requestId: string, id: string, input: PatchItemTemplateInput): Promise<CommandResult> {
  const row = await loadTemplate(tx, id, true);
  version(row.version, input.version); parseAmount(input.add_quantity);
  parseAmount((BigInt(row.total_quantity) + BigInt(input.add_quantity)).toString());
  await tx.query('UPDATE item_templates SET status=$2,total_quantity=total_quantity+$3::bigint,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [id, input.status, input.add_quantity]);
  await audit(tx, actor, 'market.template_updated', 'item_template', id, requestId, { ...input });
  return { status: 200, body: { ...await loadTemplate(tx, id) }, resourceType: 'item_template', resourceId: id };
}

async function recordTrade(tx: Tx, actor: Actor, requestId: string, input: {
  id: string; buyerId: string; sellerId?: string; listingId?: string; landId?: string; itemId?: string;
  price: string; transactionId: string; snapshot: LandPlotDto | ItemTemplateDto | ItemInstanceDto;
}): Promise<CommandResult> {
  const row = (await tx.query<Omit<MarketTradeDto, 'created_at'> & { created_at: Date | string }>(`INSERT INTO market_trades
    (id,listing_id,land_id,item_id,buyer_agent_id,seller_agent_id,points_price,transaction_id,asset_snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,listing_id,land_id,item_id,buyer_agent_id,seller_agent_id,points_price,transaction_id,created_at`,
  [input.id, input.listingId ?? null, input.landId ?? null, input.itemId ?? null, input.buyerId, input.sellerId ?? null, input.price, input.transactionId, JSON.stringify(input.snapshot)])).rows[0]!;
  await audit(tx, actor, 'market.trade_completed', 'market_trade', input.id, requestId, { ...dated(row) }, `market-trade:${input.id}`);
  return { status: 201, body: { ...dated(row) }, resourceType: 'market_trade', resourceId: input.id };
}
export async function buyLand(tx: Tx, actor: Actor, requestId: string, id: string, input: BuyMarketAssetInput): Promise<CommandResult> {
  await tradePolicy(tx, input.agent_id);
  await requireLandCapacity(tx, actor);
  const land = await loadLand(tx, id, true);
  version(land.version, input.version);
  tradable(land);
  requirePrivateLand(land);
  if (land.owner_user_id) throw new AppError('ASSET_UNAVAILABLE', 409, '地块已经售出');
  const tradeId = randomUUID();
  const paid = await pay(tx, { actor, requestId }, { businessKey: `market-land:${id}:initial`, payerAgentId: input.agent_id,
    amount: land.points_price, permission: 'can_trade', reason: `购买系统地块 ${land.code}` });
  await tx.query('UPDATE land_plots SET owner_agent_id=$2,owner_user_id=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [id, input.agent_id, marketUserId(actor)]);
  return recordTrade(tx, actor, requestId, { id: tradeId, buyerId: input.agent_id, landId: id, price: land.points_price, transactionId: paid.transactionId, snapshot: land });
}
export async function buyTemplate(tx: Tx, actor: Actor, requestId: string, id: string, input: BuyMarketAssetInput): Promise<CommandResult> {
  await tradePolicy(tx, input.agent_id);
  const template = await loadTemplate(tx, id, true);
  version(template.version, input.version);
  if (template.status !== 'active' || BigInt(template.remaining_quantity) === 0n) throw new AppError('ASSET_UNAVAILABLE', 409, '此物品已暂停供应或售罄');
  const tradeId = randomUUID(), itemId = randomUUID();
  const paid = await pay(tx, { actor, requestId }, { businessKey: `market-item:${itemId}:initial`, payerAgentId: input.agent_id,
    amount: template.points_price, permission: 'can_trade', reason: `购买系统物品 ${template.name}` });
  // Version identifies the offer terms. Inventory consumption does not invalidate another buyer's unchanged quote.
  await tx.query('UPDATE item_templates SET issued_quantity=issued_quantity+1,updated_at=clock_timestamp() WHERE id=$1', [id]);
  await tx.query('INSERT INTO item_instances(id,template_id,owner_agent_id) VALUES($1,$2,$3)', [itemId, id, input.agent_id]);
  return recordTrade(tx, actor, requestId, { id: tradeId, buyerId: input.agent_id, itemId, price: template.points_price, transactionId: paid.transactionId, snapshot: template });
}
export async function createListing(tx: Tx, actor: Actor, requestId: string, input: CreateMarketListingInput): Promise<CommandResult> {
  if (!!input.land_id === !!input.item_id) throw new AppError('INVALID_REQUEST', 400, '每次挂牌必须且只能选择一块土地或一个物品');
  parseAmount(input.points_price, true);
  await tradePolicy(tx, input.agent_id);
  const asset = input.land_id ? await loadLand(tx, input.land_id, true) : await loadItem(tx, input.item_id!, true);
  ownership(asset.owner_agent_id, input.agent_id); version(asset.version, input.asset_version); editable(asset.active_listing_id);
  tradable(asset);
  if ('code' in asset) requirePrivateLand(asset);
  if ('land_id' in asset && asset.land_id) throw new AppError('ITEM_PLACED', 409, '装饰物须先从地块取下，才能挂牌');
  const id = randomUUID();
  await tx.query('INSERT INTO market_listings(id,seller_agent_id,land_id,item_id,points_price) VALUES($1,$2,$3,$4,$5)', [id, input.agent_id, input.land_id ?? null, input.item_id ?? null, input.points_price]);
  await tx.query(`UPDATE ${input.land_id ? 'land_plots' : 'item_instances'} SET version=version+1,updated_at=clock_timestamp() WHERE id=$1`, [asset.id]);
  await audit(tx, actor, 'market.listing_created', 'market_listing', id, requestId, { ...input });
  return { status: 201, body: { ...await loadListing(tx, id) }, resourceType: 'market_listing', resourceId: id };
}
export async function cancelListing(tx: Tx, actor: Actor, requestId: string, id: string, input: CancelMarketListingInput): Promise<CommandResult> {
  const listing = await loadListing(tx, id, true);
  const represented = actor.type === 'agent' ? actor.agentId : actor.type === 'user' ? actor.representedAgentId : undefined;
  ownership(listing.seller_agent_id, represented ?? ''); version(listing.version, input.version);
  if (listing.status !== 'active') throw new AppError('LISTING_CLOSED', 409, '挂牌已经关闭');
  await closeListing(tx, actor, requestId, listing);
  return { status: 200, body: { ...await loadListing(tx, id) }, resourceType: 'market_listing', resourceId: id };
}
async function closeListing(tx: Tx, actor: Actor, requestId: string, listing: MarketListingDto, reason?: string) {
  const id = listing.id;
  await tx.query("UPDATE market_listings SET status='cancelled',version=version+1,closed_at=clock_timestamp() WHERE id=$1", [id]);
  await tx.query(`UPDATE ${listing.land_id ? 'land_plots' : 'item_instances'} SET version=version+1,updated_at=clock_timestamp() WHERE id=$1`, [listing.land_id ?? listing.item_id]);
  await audit(tx, actor, reason ? 'admin.asset_listing_cancelled' : 'market.listing_cancelled', 'market_listing', id, requestId, reason ? { reason, previous_version: listing.version } : {});
}
export async function cancelAssetListing(tx: Tx, actor: Actor, requestId: string, id: string | null, reason: string) {
  if (!id) return;
  const listing = await loadListing(tx, id, true);
  if (listing.status === 'active') await closeListing(tx, actor, requestId, listing, reason);
}
export async function buyListing(tx: Tx, actor: Actor, requestId: string, id: string, input: BuyMarketAssetInput): Promise<CommandResult> {
  // Both owner user rows were locked in sorted order by the route, before policy/asset/account locks.
  await tradePolicy(tx, input.agent_id);
  const listing = await loadListing(tx, id, true);
  version(listing.version, input.version);
  if (listing.status !== 'active') throw new AppError('LISTING_CLOSED', 409, '挂牌已经关闭，请刷新报价');
  if (listing.seller_user_id === marketUserId(actor)) throw new AppError('SAME_OWNER_TRADE', 409, '同一用户所属 Agent 之间不能买卖土地或物品');
  if (listing.land_id) await requireLandCapacity(tx, actor);
  const asset = listing.land_id ? await loadLand(tx, listing.land_id, true) : await loadItem(tx, listing.item_id!, true);
  ownership(asset.owner_agent_id, listing.seller_agent_id);
  tradable(asset);
  if ('code' in asset) requirePrivateLand(asset);
  if (asset.active_listing_id !== id || ('land_id' in asset && asset.land_id)) throw new AppError('ASSET_UNAVAILABLE', 409);
  const tradeId = randomUUID();
  const held = await reserve(tx, { actor, requestId }, { businessRef: `market-listing:${id}`, payerAgentId: input.agent_id,
    amount: listing.points_price, permission: 'can_trade', reason: `市场成交 ${id}` });
  const paid = await finalizeHold(tx, { actor, requestId }, { holdId: String(held.holdId), payments: [{ agentId: listing.seller_agent_id, amount: listing.points_price }], refund: '0', reason: `市场成交 ${id}` });
  if (listing.land_id) {
    await changeLandOwner(tx, listing.land_id, input.agent_id, marketUserId(actor));
  } else {
    await tx.query('UPDATE item_instances SET owner_agent_id=$2,land_id=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [listing.item_id, input.agent_id]);
  }
  await tx.query("UPDATE market_listings SET status='sold',version=version+1,closed_at=clock_timestamp() WHERE id=$1", [id]);
  return recordTrade(tx, actor, requestId, { id: tradeId, buyerId: input.agent_id, sellerId: listing.seller_agent_id, listingId: id,
    ...(listing.land_id ? { landId: listing.land_id } : { itemId: listing.item_id! }), price: listing.points_price, transactionId: paid.transactionId, snapshot: asset });
}
async function changeLandOwner(tx: Tx, id: string, agentId: string, userId: string) {
  // Paid decorations stay with their original owner. Room removal uses the existing occupant-exit trigger.
  await tx.query('UPDATE item_instances SET land_id=NULL,version=version+1,updated_at=clock_timestamp() WHERE land_id=$1', [id]);
  await tx.query('DELETE FROM world_model_placements WHERE land_id=$1', [id]);
  await tx.query("UPDATE land_plots SET owner_agent_id=$2,owner_user_id=$3,name='默认工作室',works_url=NULL,showcase='[]'::jsonb,version=version+1,updated_at=clock_timestamp() WHERE id=$1", [id, agentId, userId]);
}
export async function patchStudio(tx: Tx, actor: Actor, requestId: string, id: string, input: PatchStudioInput): Promise<CommandResult> {
  const land = await loadLand(tx, id, true);
  ownership(land.owner_agent_id, input.agent_id); version(land.version, input.version); editable(land.active_listing_id);
  if (land.showcase_hidden) throw new AppError('CONTENT_MODERATED', 409, '此地块展示已被管理员屏蔽，恢复前不能修改展示');
  const showcase = input.showcase?.map(item => ({ ...item, ...(item.title !== undefined ? { title: item.title.trim() } : {}),
    ...(item.type === 'text' ? { text: item.text.trim() } : {}) }));
  await tx.query('UPDATE land_plots SET name=$2,works_url=$3,showcase=COALESCE($4::jsonb,showcase),version=version+1,updated_at=clock_timestamp() WHERE id=$1',
    [id, input.name.trim(), input.works_url, showcase === undefined ? null : JSON.stringify(showcase)]);
  await audit(tx, actor, 'market.studio_updated', 'land', id, requestId, { name: input.name.trim(), works_url: input.works_url, ...(showcase === undefined ? {} : { showcase }) });
  return { status: 200, body: { ...await loadLand(tx, id) }, resourceType: 'land', resourceId: id };
}
export async function placeItem(tx: Tx, actor: Actor, requestId: string, id: string, input: PlaceMarketItemInput): Promise<CommandResult> {
  const item = await loadItem(tx, id, true);
  ownership(item.owner_agent_id, input.agent_id); version(item.version, input.version); editable(item.active_listing_id);
  // The owning user row serializes every placement, listing and transfer of these assets.
  for (const landId of [...new Set([item.land_id, input.land_id].filter((value): value is string => !!value))].sort()) {
    const land = await loadLand(tx, landId, true);
    ownership(land.owner_agent_id, input.agent_id); editable(land.active_listing_id);
    if (landId === input.land_id && land.showcase_hidden) throw new AppError('CONTENT_MODERATED', 409, '此地块展示已被管理员屏蔽，恢复前不能摆放物品');
  }
  if (item.land_id === input.land_id) throw new AppError('NO_CHANGE', 409, '物品已在目标位置');
  await tx.query('UPDATE item_instances SET land_id=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [id, input.land_id]);
  await audit(tx, actor, 'market.item_placed', 'item', id, requestId, { from_land_id: item.land_id, land_id: input.land_id });
  return { status: 200, body: { ...await loadItem(tx, id) }, resourceType: 'item', resourceId: id };
}

// The route locks these owners together with the administrator before locking assets.
// A subsequent sale changes the asset version, so the command cannot affect a new owner using an old quote.
export async function assetOwnerIds(tx: Tx, kind: 'lands' | 'items', id: string): Promise<string[]> {
  const row = kind === 'lands'
    ? (await tx.query<{ owner_user_id: string | null }>('SELECT owner_user_id FROM land_plots WHERE id=$1', [id])).rows[0]
    : (await tx.query<{ owner_user_id: string }>('SELECT a.owner_user_id FROM item_instances i JOIN agents a ON a.id=i.owner_agent_id WHERE i.id=$1', [id])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404);
  return row.owner_user_id ? [row.owner_user_id] : [];
}

export async function assetTransferOwners(tx: Tx, expectedOwnerAgentId: string | null, targetAgentId: string) {
  // Lock the owner asserted by the request, then verify the asset still belongs to that Agent.
  // Looking up only the asset's current owner here could miss a transfer committed before command() starts.
  const rows = (await tx.query<{ id: string; owner_user_id: string }>('SELECT id,owner_user_id FROM agents WHERE id=ANY($1::uuid[])', [[targetAgentId, ...(expectedOwnerAgentId ? [expectedOwnerAgentId] : [])]])).rows;
  const target = rows.find(row => row.id === targetAgentId);
  if (!target) throw new AppError('NOT_FOUND', 404, '目标 Agent 不存在');
  return rows.map(row => row.owner_user_id);
}

export async function transferAdminAsset(tx: Tx, actor: Actor, requestId: string, kind: 'lands' | 'items', id: string, input: AdminAssetTransferInput): Promise<CommandResult> {
  const asset = kind === 'lands' ? await loadLand(tx, id, true, true) : await loadItem(tx, id, true);
  version(asset.version, input.version);
  if (asset.owner_agent_id !== input.expected_owner_agent_id) throw new AppError('ASSET_OWNER_CONFLICT', 409, '资产归属已变化，请刷新并重新核对旧归属');
  if (asset.owner_agent_id === input.target_agent_id) throw new AppError('NO_CHANGE', 409, '目标 Agent 已持有此资产');
  const target = (await tx.query<{ id: string; owner_user_id: string; status: string; deleted_at: Date | null; user_status: string }>(
    'SELECT a.id,a.owner_user_id,a.status,a.deleted_at,u.status AS user_status FROM agents a JOIN users u ON u.id=a.owner_user_id WHERE a.id=$1 FOR UPDATE OF a', [input.target_agent_id])).rows[0];
  if (!target || target.deleted_at || target.status !== 'active' || target.user_status !== 'active')
    throw new AppError('ASSET_TARGET_UNAVAILABLE', 409, '目标必须是活跃用户所属、未删除且已启用的 Agent');
  if (input.mode === 'recover' && target.owner_user_id !== adminId(actor)) throw new AppError('ACCESS_DENIED', 403, '回收只能转入当前管理员所属的托管 Agent');
  if (input.mode === 'recover' && !asset.owner_agent_id) throw new AppError('NO_CHANGE', 409, '系统未售资产无需回收');
  let previousContent: Record<string, unknown> = {};
  if ('code' in asset) {
    requirePrivateLand(asset);
    const returnedItems = (await tx.query('SELECT id,owner_agent_id,land_id,version::text FROM item_instances WHERE land_id=$1 ORDER BY id', [id])).rows;
    const removedModels = (await tx.query('SELECT id,model_id,x,y,rotation,scale,room_id,version::text FROM world_model_placements WHERE land_id=$1 ORDER BY id', [id])).rows;
    const removedBindings = (await tx.query('SELECT gm.placement_id,gm.game_id FROM arcade_game_machines gm JOIN world_model_placements m ON m.id=gm.placement_id WHERE m.land_id=$1 ORDER BY gm.placement_id', [id])).rows;
    previousContent = { returned_items: returnedItems, removed_models: removedModels, removed_game_bindings: removedBindings };
    await cancelAssetListing(tx, actor, requestId, asset.active_listing_id, input.reason);
    await changeLandOwner(tx, id, target.id, target.owner_user_id);
  } else {
    await cancelAssetListing(tx, actor, requestId, asset.active_listing_id, input.reason);
    if (asset.land_id) {
      const land = await loadLand(tx, asset.land_id, true);
      await cancelAssetListing(tx, actor, requestId, land.active_listing_id, input.reason);
      await tx.query('UPDATE land_plots SET version=version+1,updated_at=clock_timestamp() WHERE id=$1', [land.id]);
    }
    await tx.query('UPDATE item_instances SET owner_agent_id=$2,land_id=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [id, target.id]);
  }
  // An administrative correction/custody transfer does not charge, refund, mint or alter historical trades.
  await audit(tx, actor, input.mode === 'recover' ? 'admin.asset_recovered' : 'admin.asset_transferred', kind === 'lands' ? 'land' : 'item', id, requestId,
    { ...input, previous_asset: asset, target_user_id: target.owner_user_id, ...previousContent });
  return { status: 200, body: { ...(kind === 'lands' ? await loadLand(tx, id) : await loadItem(tx, id)) }, resourceType: kind === 'lands' ? 'land' : 'item', resourceId: id };
}

export async function adminAssetCatalog(tx: Tx): Promise<AdminAssetCatalog> {
  const lands = (await tx.query<LandRow>(`${landSelect} ORDER BY l.created_at DESC,l.id`)).rows.map(row => landBody(row, true));
  const items = (await tx.query<ItemRow & { owner_agent_name: string; owner_github_login: string }>(`SELECT i.*,a.name AS owner_agent_name,u.github_login AS owner_github_login
    FROM (${itemSelect}) i JOIN agents a ON a.id=i.owner_agent_id JOIN users u ON u.id=a.owner_user_id ORDER BY i.created_at DESC,i.id`)).rows.map(dated);
  const models = (await tx.query<AdminAssetCatalog['models'][number]>('SELECT id,land_id,model_id,x,y,rotation,scale,room_id,version::text FROM world_model_placements ORDER BY land_id,id')).rows;
  return { lands, items, models, listings: await listingRows(tx, "ml.status='active'", []) };
}

export async function moderateLand(tx: Tx, actor: Actor, requestId: string, id: string, input: AdminLandModerationInput): Promise<CommandResult> {
  const land = await loadLand(tx, id, true);
  version(land.version, input.version);
  // Either action changes the offer being quoted. Existing buyers must refresh after an administrator intervenes.
  await cancelAssetListing(tx, actor, requestId, land.active_listing_id, input.reason);
  await tx.query(`UPDATE land_plots SET trading_frozen=COALESCE($2,trading_frozen),showcase_hidden=COALESCE($3,showcase_hidden),
    version=version+1,updated_at=clock_timestamp() WHERE id=$1`, [id, input.trading_frozen ?? null, input.showcase_hidden ?? null]);
  if (input.showcase_hidden) await tx.query(`UPDATE world_positions p SET room_id=NULL,x=l.x+m.x,y=l.y+m.y+1,updated_at=clock_timestamp()
    FROM world_model_placements m JOIN land_plots l ON l.id=m.land_id WHERE p.room_id=m.id AND l.id=$1`, [id]);
  await audit(tx, actor, 'admin.land_moderated', 'land', id, requestId, { ...input,
    previous_trading_frozen: land.trading_frozen, previous_showcase_hidden: land.showcase_hidden });
  return { status: 200, body: { ...await loadLand(tx, id) }, resourceType: 'land', resourceId: id };
}

export async function moderateItem(tx: Tx, actor: Actor, requestId: string, id: string, input: AdminItemModerationInput): Promise<CommandResult> {
  const item = await loadItem(tx, id, true);
  version(item.version, input.version);
  await cancelAssetListing(tx, actor, requestId, item.active_listing_id, input.reason);
  await tx.query('UPDATE item_instances SET trading_frozen=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [id, input.trading_frozen]);
  await audit(tx, actor, 'admin.item_moderated', 'item', id, requestId, { ...input, previous_trading_frozen: item.trading_frozen });
  return { status: 200, body: { ...await loadItem(tx, id) }, resourceType: 'item', resourceId: id };
}

export async function adminCancelListing(tx: Tx, actor: Actor, requestId: string, id: string, input: AdminAssetActionInput): Promise<CommandResult> {
  const listing = await loadListing(tx, id, true);
  version(listing.version, input.version);
  if (listing.status !== 'active') throw new AppError('LISTING_CLOSED', 409, '挂牌已经关闭');
  await closeListing(tx, actor, requestId, listing, input.reason);
  return { status: 200, body: { ...await loadListing(tx, id) }, resourceType: 'market_listing', resourceId: id };
}

export async function returnAdminItem(tx: Tx, actor: Actor, requestId: string, id: string, input: AdminAssetActionInput): Promise<CommandResult> {
  const item = await loadItem(tx, id, true);
  version(item.version, input.version);
  if (!item.land_id) throw new AppError('NO_CHANGE', 409, '物品已在原主库存中');
  const land = await loadLand(tx, item.land_id, true);
  await cancelAssetListing(tx, actor, requestId, land.active_listing_id, input.reason);
  await tx.query('UPDATE item_instances SET land_id=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [id]);
  await tx.query('UPDATE land_plots SET version=version+1,updated_at=clock_timestamp() WHERE id=$1', [land.id]);
  await audit(tx, actor, 'admin.item_returned', 'item', id, requestId, { ...input, from_land_id: land.id, owner_agent_id: item.owner_agent_id });
  return { status: 200, body: { ...await loadItem(tx, id) }, resourceType: 'item', resourceId: id };
}
