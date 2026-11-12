import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { WORLD_MODEL_CATALOG, type AdminAssetCatalog, type GameDto } from '@agentzero/contracts';
import { api, ApiError, points, useCommand } from './api';
import { CommandNotice, ErrorNotice, Loading } from './components';
import { AdminAssetTransfer } from './admin-asset-transfer';
import styles from './style.module.css';

type Action = { label: string; path: string; method: 'PATCH' | 'POST' | 'DELETE'; fields?: Record<string, boolean> };
function AssetAction({ version, actions, refresh }: { version: string; actions: Action[]; refresh: () => Promise<void> }) {
  const [selected, setSelected] = useState(0), [reason, setReason] = useState('');
  const [sent, setSent] = useState<{ path: string; method: string; body: Record<string, unknown> } | null>(null);
  const command = useCommand(), uncertain = command.error instanceof ApiError && command.error.uncertain;
  const conflict = command.error instanceof ApiError && command.error.code.endsWith('VERSION_CONFLICT');
  return <form onSubmit={event => {
    event.preventDefault();
    const action = actions[selected] ?? actions[0]!;
    const request = uncertain && sent ? sent : { path: action.path, method: action.method, body: { version, reason: reason.trim(), ...action.fields } };
    setSent(request);
    void command.run(request.path, request.method, request.body, async () => { setSent(null); setReason(''); await refresh(); });
  }}>
    <fieldset disabled={command.pending || uncertain} style={{ border: 0, padding: 0, margin: 0 }}>
      <label className={styles.field}>管理动作<select value={selected} onChange={event => setSelected(Number(event.target.value))}>{actions.map((action, index) => <option key={action.path + index} value={index}>{action.label}</option>)}</select></label>
      <label className={styles.field}>操作理由<textarea required maxLength={500} value={reason} rows={2} onChange={event => setReason(event.target.value)} placeholder="记录处理依据，所有操作均保留审计记录" /></label>
    </fieldset>
    <div className={styles.formFooter}><span>版本 {uncertain && sent ? String(sent.body.version) : version}</span><button disabled={command.pending || (!uncertain && !reason.trim())}>{command.pending ? '正在处理…' : uncertain ? '按原请求重试' : '确认执行'}</button></div>
    <CommandNotice command={command} />{conflict && <button type="button" className={styles.secondary} onClick={() => void refresh()}>刷新版本后重新确认</button>}
  </form>;
}

export function AssetsAdminPanel() {
  const client = useQueryClient(), [tab, setTab] = useState<'lands' | 'items' | 'listings' | 'games'>('lands'), [filter, setFilter] = useState('');
  const [lockedTransfers, setLockedTransfers] = useState<Set<string>>(() => new Set());
  const setTransferLocked = useCallback((id: string, locked: boolean) => setLockedTransfers(current => {
    if (current.has(id) === locked) return current;
    const next = new Set(current); if (locked) next.add(id); else next.delete(id); return next;
  }), []);
  const catalog = useQuery({ queryKey: ['admin-assets'], queryFn: () => api<AdminAssetCatalog>('/admin/assets') });
  const games = useQuery({ queryKey: ['admin-assets-games'], queryFn: () => api<{ items: GameDto[] }>('/admin/assets/games') });
  const refresh = async () => { await Promise.all(['admin-assets', 'admin-assets-games', 'market', 'market-assets', 'world', 'games', 'admin-records'].map(key => client.invalidateQueries({ queryKey: [key] }))); };
  const matches = (...values: (string | null | undefined)[]) => values.join(' ').toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase());
  return <section className={styles.card} aria-label="资产与展示管理">
    <div className={styles.sectionHeading}><h2>资产与展示管理</h2><button type="button" className={styles.secondary} onClick={() => void refresh()}>刷新资产</button></div>
    <p className={styles.hint}>冻结交易或调整展示会撤销相关现有挂牌。屏蔽地块时保留内容，恢复后重新展示。改归属与回收在各资产详情中单独确认；游戏下架保留既有对局的结算和超时处理。</p>
    <label className={styles.field}>资产分类<select disabled={lockedTransfers.size > 0} value={tab} onChange={event => setTab(event.target.value as typeof tab)}><option value="lands">土地、展示和免费模型</option><option value="items">付费物品</option><option value="listings">当前挂牌</option><option value="games">平台游戏</option></select></label>
    <label className={styles.field}>查找资产<input disabled={lockedTransfers.size > 0} value={filter} onChange={event => setFilter(event.target.value)} placeholder="名称、编号、所有者或资产 ID" /></label>
    {lockedTransfers.size > 0 && <p role="status">正在确认产权请求，相关资产暂时保留在列表中。请确认处理结果后再切换分类或筛选。</p>}
    <ErrorNotice error={catalog.error ?? games.error} />{(catalog.isPending || games.isPending) && <Loading />}
    {tab === 'lands' && catalog.data?.lands.filter(land => lockedTransfers.has(land.id) || matches(land.id, land.code, land.name, land.owner_github_login, land.owner_agent_name)).map(land => <details key={land.id}>
      <summary>{land.code} · {land.name} · {land.owner_github_login ? `@${land.owner_github_login}` : '系统未售'}{land.trading_frozen ? ' · 交易冻结' : ''}{land.showcase_hidden ? ' · 展示屏蔽' : ''}</summary>
      <p>管理 Agent：{land.owner_agent_name ?? '未分配'} · 资产 ID：{land.id}</p>
      <AssetAction version={land.version} refresh={refresh} actions={[
        { label: land.trading_frozen ? '恢复土地交易' : '冻结土地交易并撤单', path: `/admin/assets/lands/${land.id}`, method: 'PATCH', fields: { trading_frozen: !land.trading_frozen } },
        { label: land.showcase_hidden ? '恢复地块展示' : '屏蔽地块展示并撤单', path: `/admin/assets/lands/${land.id}`, method: 'PATCH', fields: { showcase_hidden: !land.showcase_hidden } },
      ]} />
      <AdminAssetTransfer kind="lands" id={land.id} version={land.version} ownerAgentId={land.owner_agent_id} ownerName={land.owner_agent_name ?? '系统未售'} refresh={refresh} setLocked={setTransferLocked} />
      <details><summary>查看原始展示内容</summary><p style={{ overflowWrap: 'anywhere' }}>{land.works_url ?? '无作品链接'}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(land.showcase, null, 2)}</pre></details>
      <h3>免费模型</h3>{catalog.data.models.filter(model => model.land_id === land.id).map(model => <details key={model.id}><summary>{WORLD_MODEL_CATALOG[model.model_id].label} · {model.room_id ? '室内' : '室外'} · {model.id}</summary>
        <p>移除房屋前须先移除室内物品；移除游戏机会解除绑定，游戏和已付费对局保留。</p>
        <AssetAction version={model.version} refresh={refresh} actions={[{ label: '移除此免费模型', path: `/admin/assets/lands/${land.id}/models/${model.id}`, method: 'DELETE' }]} />
      </details>)}
    </details>)}
    {tab === 'items' && catalog.data?.items.filter(item => lockedTransfers.has(item.id) || matches(item.id, item.name, item.owner_agent_name, item.owner_github_login)).map(item => <details key={item.id}><summary>{item.name} · @{item.owner_github_login} / {item.owner_agent_name}{item.trading_frozen ? ' · 交易冻结' : ''} · {item.land_id ? '已摆放' : '库存中'}</summary>
      <p>资产 ID：{item.id}{item.land_id ? ` · 地块：${item.land_id}` : ''}</p>
      <AssetAction version={item.version} refresh={refresh} actions={[
        { label: item.trading_frozen ? '恢复物品交易' : '冻结物品交易并撤单', path: `/admin/assets/items/${item.id}`, method: 'PATCH', fields: { trading_frozen: !item.trading_frozen } },
        ...(item.land_id ? [{ label: '从展示取下并退回原主库存', path: `/admin/assets/items/${item.id}/return`, method: 'POST' as const }] : []),
      ]} />
      <AdminAssetTransfer kind="items" id={item.id} version={item.version} ownerAgentId={item.owner_agent_id} ownerName={item.owner_agent_name} refresh={refresh} setLocked={setTransferLocked} />
    </details>)}
    {tab === 'listings' && catalog.data?.listings.filter(listing => matches(listing.id, listing.seller_agent_name, listing.land?.code, listing.item?.name)).map(listing => <details key={listing.id}><summary>{listing.land?.code ?? listing.item?.name ?? listing.id} · {points(listing.points_price)} 积分 · {listing.seller_agent_name}</summary>
      <AssetAction version={listing.version} refresh={refresh} actions={[{ label: '强制撤销本次挂牌', path: `/admin/assets/listings/${listing.id}/cancel`, method: 'POST' }]} />
    </details>)}
    {tab === 'games' && games.data?.items.filter(game => matches(game.id, game.name, game.owner_user_id, game.author_agent_id)).map(game => <details key={game.id}><summary>{game.name} · {game.moderation_blocked ? '管理员已下架' : '平台可展示'} · {game.status === 'active' ? '发布者已开放' : '发布者已暂停'}</summary>
      <p>{game.description}</p><p>游戏 ID：{game.id} · 奖池 {points(game.pool_balance)} · 已承诺 {points(game.pool_committed)}</p>
      <AssetAction version={game.version} refresh={refresh} actions={[{ label: game.moderation_blocked ? '解除平台下架' : '平台下架，停止展示和新对局', path: `/admin/assets/games/${game.id}`, method: 'PATCH', fields: { moderation_blocked: !game.moderation_blocked } }]} />
    </details>)}
  </section>;
}
