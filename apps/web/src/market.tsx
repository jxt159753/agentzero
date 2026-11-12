import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { ItemInstanceDto, ItemTemplateDto, LandPlotDto, LandShowcaseItem, MarketAssetsDto, MarketCatalogDto, MarketListingDto, MarketSettingsDto, MarketTradeDto } from '@agentzero/contracts';
import { landOverlapsPublicArea, MAX_LAND_SHOWCASE_ITEMS } from '@agentzero/contracts';
import { api, ApiError, dateTime, measure, points, queryString, useCommand } from './api';
import { Badge, CommandNotice, Empty, ErrorNotice, Loading, PointField } from './components';
import type { Agent, ListResult, Me } from './types';
import styles from './style.module.css';
import marketStyles from './market.module.css';

type Quote = { kind: 'land'; asset: LandPlotDto } | { kind: 'template'; asset: ItemTemplateDto } | { kind: 'listing'; asset: MarketListingDto };
type Receipt = MarketTradeDto & { operation_id?: string };
const appearances: Record<ItemTemplateDto['appearance'], string> = { plant: '盆栽', lamp: '灯具', bookshelf: '书架', banner: '挂旗' };
const landScope = '交易包含地块，房屋和其他免费模型由用户自行添加。土地产权登记在买方 Agent 的主人名下，由该 Agent 管理。二手成交时产权转移给买方主人，卖方装饰物回到原 Agent 库存，免费模型布置、个性化名称、作品链接和展示内容清除。作品归属、聊天记录和任务合同不随土地转移。';

function useRefreshMarket() {
  const client = useQueryClient();
  return async () => { await Promise.all(['market', 'market-assets', 'admin-market', 'wallet', 'transactions'].map((key) => client.invalidateQueries({ queryKey: [key] }))); };
}
function useMarketAgents() {
  return useInfiniteQuery({ queryKey: ['agents', 'market-options'], queryFn: ({ pageParam }) => api<ListResult<Agent>>(`/agents${queryString({ cursor: pageParam, limit: '100' })}`), initialPageParam: undefined as string | undefined, getNextPageParam: (last) => last.next_cursor ?? undefined });
}
function MarketState({ available, children }: { available: boolean; children: React.ReactNode }) {
  return <span className={`${marketStyles.state} ${available ? '' : marketStyles.unavailable}`}>{children}</span>;
}
function LandFacts({ land }: { land: LandPlotDto }) {
  return <div className={marketStyles.meta}><span>地块 {land.code} · 坐标 ({measure(land.x, 4)}, {measure(land.y, 4)})</span><span>面积 {measure(land.area)} m² · 自主布置</span><span>产权人：{land.owner_github_login ? `@${land.owner_github_login}` : land.trading_frozen ? '平台持有' : land.tradeable === false ? '公共土地' : '平台待售'}</span>{land.owner_agent_name && <span>管理 Agent：{land.owner_agent_name}</span>}{land.trading_frozen ? <span>管理员已冻结交易</span> : land.tradeable === false && <span>公共区域 · 不可买卖</span>}{land.showcase_hidden && <span>展示已被管理员屏蔽</span>}<Link to={`/world/studios/${land.id}`}>在小镇中查看 →</Link></div>;
}
function CountField({ label, value, onChange, max }: { label: string; value: string; onChange: (value: string) => void; max?: number }) {
  return <label className={styles.field}>{label}<input required inputMode="numeric" pattern="(0|[1-9][0-9]*)" maxLength={max ? String(max).length : 19} value={value} onChange={(event) => { if (/^\d*$/.test(event.target.value)) onChange(event.target.value); }} /></label>;
}
function ReasonField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className={styles.field}>操作理由<textarea required rows={2} maxLength={500} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

export function MarketPage() {
  const [search, setSearch] = useSearchParams();
  const tab = search.get('tab') ?? 'land';
  const catalog = useQuery({ queryKey: ['market'], queryFn: () => api<MarketCatalogDto>('/market') });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const refresh = useRefreshMarket();
  const requestedLand = search.get('land');
  useEffect(() => {
    if (!requestedLand || !catalog.data) return;
    const land = catalog.data.lands.find(value => value.id === requestedLand);
    if (land && !land.owner_agent_id && land.tradeable !== false) setQuote({ kind: 'land', asset: land });
    setSearch(current => { const next = new URLSearchParams(current); next.delete('land'); return next; }, { replace: true });
  }, [requestedLand, catalog.data, setSearch]);
  const userId = me.data?.user.id;
  const canBuyLand = catalog.data ? catalog.data.user_land_count < catalog.data.settings.user_land_limit : false;
  return <>
    <div className={styles.pageHeading}><div><div className={styles.eyebrow}>ASSET MARKET</div><h1>资产市场</h1><p>由 Agent 代主人购地并管理工作室，购买装饰物和发布固定价挂牌。</p></div><button className={styles.secondary} onClick={() => void refresh()}>刷新市场</button></div>
    {catalog.data && <div className={marketStyles.summary}><span>我的土地 <strong>{catalog.data.user_land_count}</strong> / {catalog.data.settings.user_land_limit} 块</span><span>所有所属 Agent 合并计算；限额调整仅影响新购入。</span><span>二次交易手续费 0</span></div>}
    <div className={`${styles.tabs} ${marketStyles.tabs}`} role="tablist" aria-label="资产市场">{([['land', '系统土地'], ['items', '装饰物品'], ['resale', '二手挂牌'], ['assets', '我的资产']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? styles.tabActive : ''} onClick={() => setSearch(key === 'assets' && search.get('agent') ? { tab: key, agent: search.get('agent')! } : { tab: key })}>{label}</button>)}</div>
    {receipt && <div className={marketStyles.receipt} role="status"><strong>交易成功 · {points(receipt.points_price)} 积分</strong><div>成交编号 <code>{receipt.id}</code></div><div>积分交易 <code>{receipt.transaction_id}</code></div>{receipt.operation_id && <div>业务编号 <code>{receipt.operation_id}</code></div>}<p>产权与积分已同时完成变更，可在“我的资产”和钱包中查看。</p><button className={styles.textButton} onClick={() => setReceipt(null)}>收起成交记录</button></div>}
    {quote && <BuyForm key={`${quote.kind}-${quote.asset.id}-${quote.asset.version}`} quote={quote} landCount={catalog.data?.user_land_count ?? 0} landLimit={catalog.data?.settings.user_land_limit ?? 3} onClose={() => setQuote(null)} onSuccess={async (result) => { setReceipt(result); setQuote(null); await refresh(); }} />}
    <ErrorNotice error={catalog.error} />
    <div role="tabpanel">{tab === 'assets' ? <AssetsPanel initialAgentId={search.get('agent') ?? ''} /> : catalog.isPending ? <Loading /> : catalog.data && <>
      {tab === 'land' && <><p className={marketStyles.scope}>{landScope}</p><p className={styles.hint}>默认地图内公共广场、道路和公共建筑以外的土地均开放购买。同面积地块越靠近中央广场，默认价格越高；标准 1,600 m² 地块按位置约 100–1,000 积分，边缘切分地块按面积计价。每块实际售价以当前报价为准。土地不自动产出积分，不收维护费。</p><LandCatalog lands={catalog.data.lands} canBuyLand={canBuyLand} onQuote={land => setQuote({ kind: 'land', asset: land })} /><SupplyDisclosure lands={catalog.data.lands} /></>}
      {tab === 'items' && <><p className={styles.hint}>物品是平台发布的装饰模板。每次购买生成一个唯一实例，进入付款 Agent 库存；不提供收益加成。</p><div className={marketStyles.grid}>{catalog.data.templates.map((item) => <article key={item.id} className={`${styles.card} ${marketStyles.asset}`}><div className={marketStyles.symbol} aria-hidden>✧</div><div className={styles.sectionHeading}><h3>{item.name}</h3><MarketState available={item.status === 'active' && item.remaining_quantity !== '0'}>{item.status === 'paused' ? '暂停销售' : item.remaining_quantity === '0' ? '已售罄' : appearances[item.appearance]}</MarketState></div><p className={marketStyles.text}>{item.description}</p><div className={marketStyles.meta}><span>剩余 {item.remaining_quantity} / {item.total_quantity} 件</span></div><div className={marketStyles.footer}><span className={marketStyles.price}>{points(item.points_price)}<small>积分 / 件</small></span><button disabled={item.status !== 'active' || item.remaining_quantity === '0'} onClick={() => setQuote({ kind: 'template', asset: item })}>查看物品报价</button></div></article>)}</div>{!catalog.data.templates.length && <Empty>当前没有装饰物品在售。</Empty>}</>}
      {tab === 'resale' && <><p className={styles.hint}>固定价成交，手续费为零。同一用户所属 Agent 之间不能交易。挂牌可撤销，改价须撤销后重新挂牌。</p><div className={marketStyles.grid}>{catalog.data.listings.map((listing) => <article key={listing.id} className={`${styles.card} ${marketStyles.asset}`}><div className={styles.sectionHeading}><h3>{listing.land?.code ?? listing.item?.name}</h3><MarketState available={listing.status === 'active'}>{listing.land ? '土地挂牌' : '物品挂牌'}</MarketState></div><p className={marketStyles.text}>卖方：{listing.seller_agent_name}</p>{listing.land ? <><LandFacts land={listing.land} /><p className={marketStyles.scope}>{landScope}</p></> : <><p className={marketStyles.text}>{listing.item?.description}</p><p className={styles.hint}>仅交易此唯一物品实例，成交后进入买方 Agent 库存。</p></>}<div className={marketStyles.meta}><span>挂牌编号 {listing.id}</span><span>报价版本 {listing.version} · {dateTime(listing.created_at)}</span></div><div className={marketStyles.footer}><span className={marketStyles.price}>{points(listing.points_price)}<small>积分</small></span><button disabled={listing.seller_user_id === userId || Boolean(listing.land && !canBuyLand)} onClick={() => setQuote({ kind: 'listing', asset: listing })}>{listing.seller_user_id === userId ? '我的挂牌' : listing.land && !canBuyLand ? '已达持有上限' : '查看交易报价'}</button></div></article>)}</div>{!catalog.data.listings.length && <Empty>当前没有二手挂牌。</Empty>}</>}
    </>}</div>
  </>;
}

function LandCatalog({ lands, canBuyLand, onQuote }: { lands: LandPlotDto[]; canBuyLand: boolean; onQuote: (land: LandPlotDto) => void }) {
  const [filter, setFilter] = useState(''), [limit, setLimit] = useState(24);
  const matching = lands.filter(land => `${land.code} ${land.owner_github_login ?? ''} ${land.owner_agent_name ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y) || a.code.localeCompare(b.code));
  return <><div className={marketStyles.toolbar}><label className={styles.field}>查找地块<input type="search" value={filter} placeholder="地块编号、产权人或管理 Agent" onChange={event => { setFilter(event.target.value); setLimit(24); }} /></label><span className={styles.hint}>共 {matching.length} 块 · 按距中央广场由近到远</span></div><div className={marketStyles.grid}>{matching.slice(0, limit).map(land => <article key={land.id} className={`${styles.card} ${marketStyles.asset}`}><div className={marketStyles.symbol} aria-hidden>⌂</div><div className={styles.sectionHeading}><h3>{land.code}</h3><MarketState available={!land.owner_agent_id && land.tradeable !== false}>{land.trading_frozen ? '交易已冻结' : land.tradeable === false ? '公共区域 · 不可购买' : land.owner_agent_id ? '已售出' : '可购买'}</MarketState></div><LandFacts land={land} /><p className={marketStyles.text}>购入后从空地开始，可自主添加免费房屋和其他模型，陈列所属装饰与公开作品链接。</p><div className={marketStyles.footer}><span className={marketStyles.price}>{points(land.points_price)}<small>积分</small></span><button disabled={land.tradeable === false || Boolean(land.owner_agent_id) || !canBuyLand} onClick={() => onQuote(land)}>{land.trading_frozen ? '交易已冻结' : land.tradeable === false ? '公共区域不可购买' : land.owner_agent_id ? '已售出' : !canBuyLand ? '已达持有上限' : '查看购地报价'}</button></div></article>)}</div>{matching.length > limit && <button className={styles.secondary} onClick={() => setLimit(value => value + 24)}>加载更多地块</button>}{!matching.length && <Empty>{lands.length ? '没有匹配的地块。' : '当前没有土地供应。'}</Empty>}</>;
}

function SupplyDisclosure({ lands }: { lands: LandPlotDto[] }) {
  const groups = new Map<string, LandPlotDto[]>();
  for (const land of lands) {
    const day = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium' }).format(new Date(land.created_at));
    groups.set(day, [...(groups.get(day) ?? []), land]);
  }
  return <section className={styles.card}><h2>土地供应记录</h2><p className={styles.hint}>已供应 {lands.length} 块，未售 {lands.filter((land) => !land.owner_agent_id).length} 块。按北京时间登记日期汇总，显示各地块当前系统售价；管理员调整售价后同步更新。</p>{[...groups].map(([date, batch]) => <details key={date} className={marketStyles.batchRow} open={batch.length <= 24}><summary>{date} · 新增 {batch.length} 块</summary><p className={marketStyles.text}>{batch.map((land) => `${land.code}：${points(land.points_price)} 积分`).join('；')}</p></details>)}</section>;
}

function BuyForm({ quote, landCount, landLimit, onClose, onSuccess }: { quote: Quote; landCount: number; landLimit: number; onClose: () => void; onSuccess: (trade: Receipt) => Promise<void> }) {
  const agents = useMarketAgents();
  const [agentId, setAgentId] = useState('');
  const [accepted, setAccepted] = useState(false);
  const command = useCommand();
  const uncertain = command.error instanceof ApiError && command.error.uncertain;
  const isLand = quote.kind === 'land' || (quote.kind === 'listing' && Boolean(quote.asset.land));
  const title = quote.kind === 'land' ? quote.asset.code : quote.kind === 'template' ? quote.asset.name : quote.asset.land?.code ?? quote.asset.item?.name;
  const seller = quote.kind === 'listing' ? quote.asset.land?.owner_github_login
    ? `产权人 @${quote.asset.land.owner_github_login} · 管理 Agent：${quote.asset.seller_agent_name}`
    : quote.asset.seller_agent_name : '平台系统供应';
  const path = `/market/${quote.kind === 'land' ? 'lands' : quote.kind === 'template' ? 'templates' : 'listings'}/${quote.asset.id}/buy`;
  const ownAgents = agents.data?.pages.flatMap((page) => page.items).filter((agent) => agent.status === 'active') ?? [];
  return <section className={styles.card} aria-label="确认交易"><div className={styles.sectionHeading}><h2>确认购买：{title}</h2><button className={styles.textButton} disabled={command.pending || uncertain} onClick={onClose}>收起报价</button></div><p>卖方：<strong>{seller}</strong> · 固定价格 <strong>{points(quote.asset.points_price)} 积分</strong></p><p className={marketStyles.scope}>{isLand ? landScope : '购买一个装饰物品实例，成交后进入付款 Agent 的库存。物品无积分产出或任务奖励加成。'}</p><p className={styles.hint}>报价版本 {quote.asset.version}。成交后不能单方撤销。{isLand && `用户当前持有 ${landCount} / ${landLimit} 块土地。`}</p>
    <ErrorNotice error={agents.error} /><form onSubmit={(event) => { event.preventDefault(); void command.run<Receipt>(path, 'POST', { agent_id: agentId, version: quote.asset.version }, onSuccess); }}><label className={styles.field}>付款 Agent<select required disabled={command.pending || uncertain} value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">选择所属 Agent</option>{ownAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>{agents.hasNextPage && <button type="button" className={styles.textButton} onClick={() => void agents.fetchNextPage()}>加载更多 Agent</button>}<p className={styles.hint}>{isLand && '所选 Agent 代主人购买并管理土地，积分从该 Agent 钱包支付，土地产权登记在主人（用户）名下。'}付款 Agent 需开启“资产交易”权限，并具有足够的可用积分及支出额度。<Link to={agentId ? `/agents/${agentId}` : '/agents'}>管理权限与钱包</Link></p><label className={marketStyles.checkbox}><input type="checkbox" required disabled={command.pending || uncertain} checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />我已确认价格、卖方和交易范围，成交后不能单方撤销。</label><div className={styles.formFooter}><span /><button disabled={command.pending || !accepted || !agentId || (!uncertain && isLand && landCount >= landLimit)}>{command.pending ? '正在提交…' : `支付 ${points(quote.asset.points_price)} 积分购买`}</button></div><CommandNotice command={command} /></form>
  </section>;
}

function AssetsPanel({ initialAgentId }: { initialAgentId: string }) {
  const agents = useMarketAgents();
  const [agentId, setAgentId] = useState(initialAgentId);
  const ownAgents = agents.data?.pages.flatMap((page) => page.items) ?? [];
  const selectedId = agentId || ownAgents[0]?.id || '';
  const assets = useQuery({ queryKey: ['market-assets', selectedId], queryFn: () => api<MarketAssetsDto>(`/agents/${selectedId}/assets`), enabled: Boolean(selectedId) });
  return <><div className={marketStyles.toolbar}><label className={styles.field}>管理 Agent<select value={selectedId} onChange={(event) => setAgentId(event.target.value)}><option value="">选择所属 Agent</option>{ownAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{agent.status === 'paused' ? '（已暂停）' : ''}</option>)}</select></label>{agents.hasNextPage && <button className={styles.secondary} onClick={() => void agents.fetchNextPage()}>加载更多 Agent</button>}{selectedId && <Link to={`/agents/${selectedId}`}>查看钱包与权限 →</Link>}</div><p className={styles.hint}>土地产权归你所有，以下按管理 Agent 展示土地；装饰物仍保存在对应 Agent 库存。</p><ErrorNotice error={agents.error} /><ErrorNotice error={assets.error} />{!selectedId ? <Empty>创建 Agent 后，可在这里管理土地与物品。</Empty> : assets.isPending ? <Loading /> : assets.data && <><h2>管理的土地 · {assets.data.lands.length} 块</h2><div className={marketStyles.grid}>{assets.data.lands.map((land) => <OwnedLand key={land.id} land={land} agentId={selectedId} listing={assets.data.listings.find((listing) => listing.id === land.active_listing_id)} />)}</div>{!assets.data.lands.length && <Empty>此 Agent 尚未管理土地。</Empty>}<h2>所属物品 · {assets.data.items.length} 件</h2><div className={marketStyles.grid}>{assets.data.items.map((item) => <OwnedItem key={item.id} item={item} assets={assets.data} listing={assets.data.listings.find((listing) => listing.id === item.active_listing_id)} />)}</div>{!assets.data.items.length && <Empty>此 Agent 库存为空。</Empty>}</>}</>;
}

function OwnedLand({ land, agentId, listing }: { land: LandPlotDto; agentId: string; listing?: MarketListingDto }) {
  return <article className={`${styles.card} ${marketStyles.asset}`}><div className={styles.sectionHeading}><h3>{land.name}</h3><MarketState available={!land.active_listing_id}>{land.active_listing_id ? '已挂牌 · 布置冻结' : '我的工作室'}</MarketState></div><LandFacts land={land} />{land.works_url && <p className={marketStyles.text}><a href={land.works_url} target="_blank" rel="noreferrer">查看公开作品 ↗</a></p>}{land.active_listing_id ? <><p className={marketStyles.scope}>挂牌期间停止编辑布置。成交时土地产权转移给买方主人，装饰归还原 Agent 库存，免费模型清除，买方可从空地重新布置。</p>{listing && <CancelListing listing={listing} />}</> : <>{!land.showcase_hidden && <StudioForm land={land} agentId={agentId} />}{!land.trading_frozen && <ListingForm key={`listing-${land.version}`} asset={land} agentId={agentId} kind="land" />}</>}</article>;
}
function StudioForm({ land, agentId }: { land: LandPlotDto; agentId: string }) {
  const [name, setName] = useState(land.name), [url, setUrl] = useState(land.works_url ?? '');
  const [showcase, setShowcase] = useState<LandShowcaseItem[]>(land.showcase ?? []);
  const [version, setVersion] = useState(land.version);
  const command = useCommand(), refresh = useRefreshMarket();
  const uncertain = command.error instanceof ApiError && command.error.uncertain;
  const update = (index: number, item: LandShowcaseItem) => setShowcase(current => current.map((value, position) => position === index ? item : value));
  const move = (index: number, offset: number) => setShowcase(current => { const next = [...current]; [next[index], next[index + offset]] = [next[index + offset]!, next[index]!]; return next; });
  const valid = showcase.every(item => item.type === 'text' ? item.text.trim() : item.url.trim());
  return <details className={marketStyles.details}><summary>编辑工作室展示</summary><form className={marketStyles.form} aria-label="工作室展示设置" onSubmit={(event) => {
    event.preventDefault();
    void command.run<LandPlotDto>(`/market/lands/${land.id}/studio`, 'PATCH', { agent_id: agentId, version, name: name.trim(), works_url: url.trim() || null,
      showcase: showcase.map(item => ({ ...item, title: item.title?.trim() || undefined, ...(item.type === 'text' ? { text: item.text.trim() } : { url: item.url.trim() }) })) }, async result => { setVersion(result.version); setName(result.name); setUrl(result.works_url ?? ''); setShowcase(result.showcase ?? []); await refresh(); });
  }}><fieldset disabled={command.pending || uncertain}><label className={styles.field}>工作室名称<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label><label className={styles.field}>公开作品链接<input type="url" pattern="https://.*" maxLength={2000} value={url} placeholder="https://…（可留空）" onChange={(event) => setUrl(event.target.value)} /></label>
    <div className={marketStyles.showcaseHeading}><h4>靠近地块时展示</h4><span>{showcase.length} / {MAX_LAND_SHOWCASE_ITEMS}</span></div><p className={styles.hint}>添加文字、图片、视频或网页，访客靠近时会看到展示气泡。图片和视频填写可直接访问的 HTTPS 文件链接。</p>
    {showcase.map((item, index) => <fieldset key={index} className={marketStyles.showcaseItem}><legend>展示 {index + 1}</legend><label className={styles.field}>展示类型<select aria-label={`展示 ${index + 1} 类型`} value={item.type} onChange={event => { const type = event.target.value as LandShowcaseItem['type']; update(index, type === 'text' ? { type, title: item.title, text: '' } : { type, title: item.title, url: item.type === 'text' ? '' : item.url }); }}><option value="text">文字</option><option value="image">图片</option><option value="video">视频</option><option value="webpage">网页</option></select></label><label className={styles.field}>展示标题（可选）<input aria-label={`展示 ${index + 1} 标题`} maxLength={80} value={item.title ?? ''} onChange={event => update(index, { ...item, title: event.target.value })} /></label>
      {item.type === 'text' ? <label className={styles.field}>展示文字<textarea aria-label={`展示 ${index + 1} 文字`} required maxLength={2000} rows={4} value={item.text} onChange={event => update(index, { ...item, text: event.target.value })} /></label> : <label className={styles.field}>{item.type === 'webpage' ? '网页' : item.type === 'image' ? '图片' : '视频'}链接<input aria-label={`展示 ${index + 1} 链接`} required type="url" pattern="https://.*" maxLength={2000} placeholder="https://…" value={item.url} onChange={event => update(index, { ...item, url: event.target.value })} /></label>}
      <div className={marketStyles.showcaseActions}><button type="button" className={styles.secondary} aria-label={`上移展示 ${index + 1}`} disabled={index === 0} onClick={() => move(index, -1)}>上移</button><button type="button" className={styles.secondary} aria-label={`下移展示 ${index + 1}`} disabled={index === showcase.length - 1} onClick={() => move(index, 1)}>下移</button><button type="button" className={styles.dangerText} aria-label={`移除展示 ${index + 1}`} onClick={() => setShowcase(current => current.filter((_, position) => position !== index))}>移除</button></div>
    </fieldset>)}<button type="button" className={styles.secondary} disabled={showcase.length >= MAX_LAND_SHOWCASE_ITEMS} onClick={() => setShowcase(current => [...current, { type: 'text', text: '' }])}>添加展示内容</button><p className={styles.hint}>视频由访客手动播放。移除全部内容并保存可关闭气泡。</p></fieldset>
    {version !== land.version && !command.pending && !uncertain && <p className={styles.hint}>地块已有更新。<button type="button" className={styles.textButton} onClick={() => { setVersion(land.version); setName(land.name); setUrl(land.works_url ?? ''); setShowcase(land.showcase ?? []); }}>放弃修改并载入最新展示</button></p>}<button disabled={command.pending || !name.trim() || !valid}>{command.pending ? '正在保存…' : '保存工作室'}</button><CommandNotice command={command} /></form></details>;
}
function ListingForm({ asset, agentId, kind }: { asset: LandPlotDto | ItemInstanceDto; agentId: string; kind: 'land' | 'item' }) {
  const [price, setPrice] = useState('');
  const command = useCommand(), refresh = useRefreshMarket();
  return <details className={marketStyles.details}><summary>固定价挂牌出售</summary><form className={marketStyles.form} onSubmit={(event) => { event.preventDefault(); void command.run('/market/listings', 'POST', { agent_id: agentId, [kind === 'land' ? 'land_id' : 'item_id']: asset.id, asset_version: asset.version, points_price: price }, refresh); }}><PointField name="listing_price" label="挂牌售价" value={price} onChange={setPrice} positive /><p className={styles.hint}>{kind === 'land' ? landScope : '交易仅包含此物品实例。'}挂牌不收费，成交手续费为零；成交前可撤单。</p><button disabled={command.pending || !price}>确认挂牌</button><CommandNotice command={command} /></form></details>;
}
function CancelListing({ listing }: { listing: MarketListingDto }) {
  const command = useCommand(), refresh = useRefreshMarket();
  return <div className={marketStyles.details}><p>当前售价 <strong>{points(listing.points_price)} 积分</strong></p><p className={styles.hint}>挂牌编号 {listing.id} · 版本 {listing.version}。改价请先撤销，再重新挂牌。</p><button className={styles.secondary} disabled={command.pending} onClick={() => void command.run(`/market/listings/${listing.id}/cancel`, 'POST', { version: listing.version }, refresh)}>撤销挂牌</button><CommandNotice command={command} /></div>;
}
function OwnedItem({ item, assets, listing }: { item: ItemInstanceDto; assets: MarketAssetsDto; listing?: MarketListingDto }) {
  const placedLand = assets.lands.find((land) => land.id === item.land_id);
  const frozen = Boolean(placedLand?.active_listing_id);
  return <article className={`${styles.card} ${marketStyles.asset}`}><div className={styles.sectionHeading}><h3>{item.name}</h3><MarketState available={!item.active_listing_id}>{item.trading_frozen ? '交易已冻结' : item.active_listing_id ? '已挂牌' : item.land_id ? '已放置' : '库存中'}</MarketState></div><p className={marketStyles.text}>{item.description}</p><div className={marketStyles.meta}><span>实例编号 {item.id}</span><span>{item.land_id ? `所在工作室：${placedLand?.name ?? item.land_id}` : '位于 Agent 库存'}</span></div>{item.active_listing_id ? listing && <CancelListing listing={listing} /> : <>{frozen ? <p className={marketStyles.scope}>所在土地已挂牌，布置冻结；撤单后可取下，成交后自动归还库存。</p> : <PlacementForm key={`${item.version}-${item.land_id}`} item={item} lands={assets.lands} />}{!item.land_id && !item.trading_frozen && <ListingForm key={`listing-${item.version}`} asset={item} agentId={assets.agent_id} kind="item" />}{item.land_id && !frozen && <p className={styles.hint}>物品须先取回库存，才能挂牌出售。</p>}</>}</article>;
}
function PlacementForm({ item, lands }: { item: ItemInstanceDto; lands: LandPlotDto[] }) {
  const [landId, setLandId] = useState(item.land_id ?? '');
  const command = useCommand(), refresh = useRefreshMarket();
  return <form className={marketStyles.details} onSubmit={(event) => { event.preventDefault(); void command.run(`/market/items/${item.id}/place`, 'POST', { agent_id: item.owner_agent_id, version: item.version, land_id: landId || null }, refresh); }}><label className={styles.field}>物品位置<select value={landId} onChange={(event) => setLandId(event.target.value)}><option value="">Agent 库存</option>{lands.filter((land) => !land.active_listing_id && !land.showcase_hidden).map((land) => <option key={land.id} value={land.id}>{land.name} · {land.code}</option>)}</select></label><button className={styles.secondary} disabled={command.pending || landId === (item.land_id ?? '')}>{landId ? '放置到工作室' : '取回库存'}</button><CommandNotice command={command} /></form>;
}

export function MarketAdminPanel() {
  const catalog = useQuery({ queryKey: ['admin-market'], queryFn: () => api<MarketCatalogDto>('/admin/market') });
  return <><ErrorNotice error={catalog.error} />{catalog.isPending ? <Loading /> : catalog.data && <><MarketSettings key={catalog.data.settings.version} settings={catalog.data.settings} /><LandPrices lands={catalog.data.lands} /><LandSupplyForm /><TemplateCreateForm /><section className={styles.card}><h2>模板物品供应</h2><p className={styles.hint}>内容和价格固定；更改内容或价格请新建模板。现有模板可暂停或追加库存。</p>{catalog.data.templates.map((template) => <TemplateSupply key={`${template.id}-${template.version}`} template={template} />)}{!catalog.data.templates.length && <Empty>尚未建立物品模板。</Empty>}</section><SupplyDisclosure lands={catalog.data.lands} /></>}</>;
}
function LandPrices({ lands }: { lands: LandPlotDto[] }) {
  const [filter, setFilter] = useState(''), [selectedId, setSelectedId] = useState('');
  const refresh = useRefreshMarket();
  const available = lands.filter(land => !land.owner_agent_id && land.tradeable !== false && land.code.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => a.code.localeCompare(b.code));
  const selected = available.find(land => land.id === selectedId) ?? available[0];
  return <section className={styles.card} aria-label="逐块调整售价"><div className={styles.sectionHeading}><h2>逐块调整售价</h2><button className={styles.textButton} onClick={() => void refresh()}>刷新地价</button></div><p className={styles.hint}>默认地价按面积和距中央广场的距离计算。可为每块未售土地单独定价，保存后一直采用该价格。已售土地由产权人通过管理 Agent 自行挂牌定价。</p><div className={marketStyles.formGrid}><label className={styles.field}>筛选待售地块<input type="search" value={filter} placeholder="地块编号" onChange={event => setFilter(event.target.value)} /></label><label className={styles.field}>调价地块<select value={selected?.id ?? ''} onChange={event => setSelectedId(event.target.value)}>{!available.length && <option value="">没有匹配的待售地块</option>}{available.map(land => <option key={land.id} value={land.id}>{land.code} · {points(land.points_price)} 积分</option>)}</select></label></div>{selected ? <LandPriceForm key={`${selected.id}-${selected.version}`} land={selected} /> : <Empty>没有可调价的地块。</Empty>}</section>;
}
function LandPriceForm({ land }: { land: LandPlotDto }) {
  const [price, setPrice] = useState(land.points_price), [reason, setReason] = useState('');
  const command = useCommand(), refresh = useRefreshMarket();
  const uncertain = command.error instanceof ApiError && command.error.uncertain;
  return <form onSubmit={event => { event.preventDefault(); void command.run(`/admin/market/lands/${land.id}`, 'PATCH', { version: land.version, points_price: price, reason: reason.trim() }, refresh); }}><LandFacts land={land} /><p className={styles.hint}>当前售价 {points(land.points_price)} 积分 · 报价版本 {land.version}</p><fieldset disabled={command.pending || uncertain}><PointField name={`land-price-${land.id}`} label="新的系统售价" value={price} onChange={setPrice} positive /><ReasonField value={reason} onChange={setReason} /></fieldset><button disabled={command.pending || !price || !reason.trim() || (!uncertain && price === land.points_price)}>保存此地块售价</button><CommandNotice command={command} /></form>;
}
function MarketSettings({ settings }: { settings: MarketSettingsDto }) {
  const [limit, setLimit] = useState(String(settings.user_land_limit)), [reason, setReason] = useState('');
  const command = useCommand(), refresh = useRefreshMarket();
  return <section className={styles.card}><h2>用户持地上限</h2><p className={styles.hint}>所有所属 Agent 合并计算。降低上限只限制新购入，不收回已有土地。</p><form onSubmit={(event) => { event.preventDefault(); void command.run('/admin/market/settings', 'PUT', { version: settings.version, user_land_limit: Number(limit), reason: reason.trim() }, refresh); }}><CountField label="每用户最多持地（块）" value={limit} onChange={setLimit} max={1000} /><ReasonField value={reason} onChange={setReason} /><button disabled={command.pending || !reason.trim() || Number(limit) > 1000}>保存持地上限</button><CommandNotice command={command} /></form></section>;
}
interface SupplyRow { key: string; code: string; x: string; y: string; area: string; price: string }
const emptyPlot = (): SupplyRow => ({ key: crypto.randomUUID(), code: '', x: '', y: '', area: '', price: '' });
function LandSupplyForm() {
  const [plots, setPlots] = useState<SupplyRow[]>([emptyPlot()]), [reason, setReason] = useState('');
  const command = useCommand(), refresh = useRefreshMarket();
  const update = (key: string, changes: Partial<SupplyRow>) => setPlots((rows) => rows.map((row) => row.key === key ? { ...row, ...changes } : row));
  const overlapsPublic = plots.some(plot => plot.x !== '' && plot.y !== '' && Number(plot.area) > 0 && landOverlapsPublicArea({ x: Number(plot.x), y: Number(plot.y), area: Number(plot.area) }));
  return <section className={styles.card}><h2>批量发布土地</h2><p className={styles.hint}>每批最多 100 块；地块编号必须唯一，占地不能相互重叠。面积单位为平方米，地图坐标每单位对应 10 米。地块须避开公共广场、道路和公共建筑，发布后公开数量与售价。</p><form onSubmit={(event) => { event.preventDefault(); void command.run('/admin/market/lands', 'POST', { plots: plots.map((plot) => ({ code: plot.code.trim(), x: Number(plot.x), y: Number(plot.y), area: Number(plot.area), points_price: plot.price, building_template: 'studio' })), reason: reason.trim() }, async () => { await refresh(); setPlots([emptyPlot()]); setReason(''); }); }}>{plots.map((plot, index) => <fieldset key={plot.key} className={marketStyles.batchRow}><legend>地块 {index + 1}</legend><div className={marketStyles.formGrid}><label className={styles.field}>地块编号<input required maxLength={40} pattern="[A-Za-z0-9_-]+" value={plot.code} onChange={(event) => update(plot.key, { code: event.target.value })} placeholder="例如 NORTH-001" /></label><label className={styles.field}>面积<input required type="number" min={1} max={1000000} step={1} value={plot.area} onChange={(event) => update(plot.key, { area: event.target.value })} /></label><label className={styles.field}>位置 X<input required type="number" min={-1000000} max={1000000} step={1} value={plot.x} onChange={(event) => update(plot.key, { x: event.target.value })} /></label><label className={styles.field}>位置 Y<input required type="number" min={-1000000} max={1000000} step={1} value={plot.y} onChange={(event) => update(plot.key, { y: event.target.value })} /></label><PointField name={`price-${plot.key}`} label="系统售价" value={plot.price} onChange={(price) => update(plot.key, { price })} positive /></div>{plots.length > 1 && <button type="button" className={styles.dangerText} onClick={() => setPlots((rows) => rows.filter((row) => row.key !== plot.key))}>移除此地块</button>}</fieldset>)}<button type="button" className={styles.secondary} disabled={plots.length >= 100 || command.pending} onClick={() => setPlots((rows) => [...rows, emptyPlot()])}>添加一块土地</button><ReasonField value={reason} onChange={setReason} /><div className={styles.formFooter}><span className={styles.hint}>{overlapsPublic ? '所选地块与公共区域重叠，请调整位置或面积。' : `本批新增 ${plots.length} 块 · 均为空地，可自主布置`}</span><button disabled={command.pending || !reason.trim() || overlapsPublic}>发布土地供应</button></div><CommandNotice command={command} /></form></section>;
}
function TemplateCreateForm() {
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [appearance, setAppearance] = useState<ItemTemplateDto['appearance']>('plant');
  const [price, setPrice] = useState(''), [quantity, setQuantity] = useState(''), [reason, setReason] = useState('');
  const command = useCommand(), refresh = useRefreshMarket();
  return <section className={styles.card}><h2>发布装饰模板</h2><form onSubmit={(event) => { event.preventDefault(); void command.run('/admin/market/templates', 'POST', { name: name.trim(), description: description.trim(), appearance, points_price: price, total_quantity: quantity, reason: reason.trim() }, async () => { await refresh(); setName(''); setDescription(''); setPrice(''); setQuantity(''); setReason(''); }); }}><div className={marketStyles.formGrid}><label className={styles.field}>物品名称<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label><label className={styles.field}>装饰类型<select value={appearance} onChange={(event) => setAppearance(event.target.value as ItemTemplateDto['appearance'])}>{Object.entries(appearances).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><label className={styles.field}>物品说明<textarea required maxLength={2000} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label><div className={marketStyles.formGrid}><PointField name="template_price" label="物品单价" value={price} onChange={setPrice} positive /><CountField label="供应总量（件）" value={quantity} onChange={setQuantity} /></div><ReasonField value={reason} onChange={setReason} /><button disabled={command.pending || !name.trim() || !description.trim() || !price || !quantity || !reason.trim()}>发布物品模板</button><CommandNotice command={command} /></form></section>;
}
function TemplateSupply({ template }: { template: ItemTemplateDto }) {
  const [status, setStatus] = useState(template.status), [quantity, setQuantity] = useState('0'), [reason, setReason] = useState('');
  const command = useCommand(), refresh = useRefreshMarket();
  return <article className={marketStyles.batchRow}><div className={styles.sectionHeading}><h3>{template.name}</h3><Badge status={template.status} /></div><p className={marketStyles.text}>{template.description}</p><p className={styles.hint}>单价 {points(template.points_price)} 积分 · 已售 {template.issued_quantity} / 总量 {template.total_quantity} 件 · 剩余 {template.remaining_quantity} 件</p><form onSubmit={(event) => { event.preventDefault(); void command.run(`/admin/market/templates/${template.id}`, 'PATCH', { version: template.version, status, add_quantity: quantity, reason: reason.trim() }, refresh); }}><div className={marketStyles.formGrid}><label className={styles.field}>销售状态<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="active">销售中</option><option value="paused">暂停销售</option></select></label><CountField label="追加供应（件）" value={quantity} onChange={setQuantity} /></div><ReasonField value={reason} onChange={setReason} /><button className={styles.secondary} disabled={command.pending || !reason.trim()}>更新模板供应</button><CommandNotice command={command} /></form></article>;
}
