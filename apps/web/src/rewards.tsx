import { useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { RewardCatalogDto, RewardOfferDto, RewardPoolDto, RewardRedemptionDto } from '@agentzero/contracts';
import { api, dateTime, monthNow, points, queryString, useCommand } from './api';
import { Badge, CommandNotice, Empty, ErrorNotice, Loading, Pagination, PointField, useCursor } from './components';
import type { Agent, ListResult, Me } from './types';
import styles from './style.module.css';
import taskStyles from './tasks.module.css';
import rewardStyles from './rewards.module.css';

const statusLabels = { pending: '待领取', processing: '发放中', fulfilled: '已发放', cancelled: '已取消并退款' };
const qqPattern = '[1-9][0-9]{4,19}';

function RewardBadge({ status }: { status: RewardRedemptionDto['status'] }) {
  return <span className={`${rewardStyles.state} ${rewardStyles[status]}`}>{statusLabels[status]}</span>;
}

function CountField({ label, value, onChange, positive = false }: { label: string; value: string; onChange: (value: string) => void; positive?: boolean }) {
  return <label className={styles.field}>{label}<input required inputMode="numeric" pattern={positive ? '[1-9][0-9]*' : '(0|[1-9][0-9]*)'} maxLength={19} value={value} onChange={(event) => { if (/^\d*$/.test(event.target.value)) onChange(event.target.value); }} /></label>;
}

function useRefreshRewards() {
  const client = useQueryClient();
  return async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['rewards'] }),
      client.invalidateQueries({ queryKey: ['reward-redemptions'] }),
      client.invalidateQueries({ queryKey: ['reward-redemption'] }),
      client.invalidateQueries({ queryKey: ['admin-rewards'] }),
      client.invalidateQueries({ queryKey: ['wallet'] }),
      client.invalidateQueries({ queryKey: ['transactions'] }),
    ]);
  };
}

export function RewardsPage() {
  const catalog = useQuery({ queryKey: ['rewards'], queryFn: () => api<RewardCatalogDto>('/rewards') });
  const [selected, setSelected] = useState('');
  const offer = catalog.data?.offers.find((item) => item.id === selected);
  const refresh = useRefreshRewards();
  const pool = catalog.data?.pool;
  const remaining = catalog.data?.offers.filter((item) => item.status === 'active').reduce((sum, item) => sum + BigInt(item.remaining_quantity), 0n) ?? 0n;
  return <>
    <div className={styles.pageHeading}><div><div className={styles.eyebrow}>REWARD STATION</div><h1>奖励站</h1><p>用积分兑换奖励，凭领取编号通过 QQ 联系运营者。</p></div><button className={styles.secondary} onClick={() => void refresh()}>刷新奖励</button></div>
    <section className={styles.card}><h2>兑换与领取</h2><ol className={rewardStyles.steps}><li>选择奖励，用所属 Agent 的积分兑换领取凭证。</li><li>使用兑换时填写的 QQ，向运营者提供领取编号和 GitHub 账号。</li><li>运营者核对身份后线下发放，并在平台记录结果。</li></ol><p className={styles.hint}>每次兑换一份；用户月度限额由所有所属 Agent 共享。取消退款不恢复当月兑换次数。已兑换凭证跨月保留。</p></section>
    <ErrorNotice error={catalog.error} />
    {catalog.isPending ? <Loading /> : catalog.data && (pool ? <>
      <div className={styles.walletGrid}><div className={styles.balanceCard}><span>{pool.month.slice(0, 7)} · 可兑换库存</span><strong>{remaining.toString()}</strong><small>已上架奖励的剩余份数</small></div><div className={styles.balanceCard}><span>本月已兑换</span><strong>{catalog.data.redeemed_count}</strong><small>月度上限 {pool.user_monthly_limit} 份，含已取消记录</small></div><div className={`${styles.balanceCard} ${styles.available}`}><span>我还可兑换</span><strong>{catalog.data.remaining_count}</strong><small>实际兑换同时受库存与积分余额限制</small></div></div>
      <section className={styles.card}><div className={styles.sectionHeading}><h2>本月领取说明</h2><Badge status={pool.status} /></div><p>联系 QQ：<strong>{pool.contact_qq}</strong></p><p className={rewardStyles.text}>{pool.instructions}</p><p className={styles.hint}>新兑换在本月最后一天 24:00（北京时间）截止。待领取凭证不会因月底失效。</p>{pool.status === 'paused' && <p className={taskStyles.notice}>本月兑换已暂停，已有领取单仍可查询和处理。</p>}</section>
      <div className={rewardStyles.grid}>{catalog.data.offers.map((item) => <article className={`${styles.card} ${rewardStyles.offer}`} key={item.id}><div className={styles.sectionHeading}><h3>{item.title}</h3><Badge status={item.status} /></div><p className={rewardStyles.text}>{item.description}</p><small className={styles.hint}>剩余 {item.remaining_quantity} / {item.total_quantity} 份</small><div className={rewardStyles.offerFooter}><span className={rewardStyles.price}>{points(item.points_cost)}<small>积分 / 份</small></span><button disabled={pool.status !== 'active' || item.status !== 'active' || item.remaining_quantity === '0' || catalog.data.remaining_count === '0'} onClick={() => setSelected(item.id)}>{item.remaining_quantity === '0' ? '已兑完' : selected === item.id ? '已选择' : '选择兑换'}</button></div></article>)}</div>
      {!catalog.data.offers.length && <Empty>本月还没有奖励商品。</Empty>}
      {offer && <RedeemForm key={`${offer.id}-${offer.version}`} offer={offer} pool={pool} remainingCount={catalog.data.remaining_count} onClose={() => setSelected('')} />}
    </> : <section className={styles.card}><Empty>本月暂未发布奖励。已有领取凭证可在下方查看。</Empty></section>)}
    <MyRedemptions />
  </>;
}

function RedeemForm({ offer, pool, remainingCount, onClose }: { offer: RewardOfferDto; pool: RewardPoolDto; remainingCount: string; onClose: () => void }) {
  const agents = useInfiniteQuery({ queryKey: ['agents', 'reward-options'], queryFn: ({ pageParam }) => api<ListResult<Agent>>(`/agents${queryString({ cursor: pageParam, limit: '100' })}`), initialPageParam: undefined as string | undefined, getNextPageParam: (last) => last.next_cursor ?? undefined });
  const [agentId, setAgentId] = useState('');
  const [qq, setQq] = useState('');
  const [accepted, setAccepted] = useState(false);
  const command = useCommand();
  const navigate = useNavigate();
  const refresh = useRefreshRewards();
  const ownAgents = agents.data?.pages.flatMap((page) => page.items).filter((agent) => agent.status === 'active') ?? [];
  const canRedeem = pool.status === 'active' && offer.status === 'active' && offer.remaining_quantity !== '0' && remainingCount !== '0';
  return <section className={styles.card}><div className={styles.sectionHeading}><h2>兑换：{offer.title}</h2><button className={styles.textButton} onClick={onClose} disabled={command.pending}>收起</button></div><p className={rewardStyles.text}>{offer.description}</p><p>需支付 <strong>{points(offer.points_cost)} 积分</strong>，兑换 1 份。联系 QQ：{pool.contact_qq}</p><ErrorNotice error={agents.error} />
    <form onSubmit={(event) => { event.preventDefault(); void command.run<RewardRedemptionDto>('/reward-redemptions', 'POST', { offer_id: offer.id, agent_id: agentId, claimant_qq: qq.trim() }, async (result) => { await refresh(); navigate(`/rewards/${result.id}`); }); }}>
      <div className={styles.formGrid}><label className={styles.field}>付款 Agent<select required value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">选择所属 Agent</option>{ownAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><label className={styles.field}>本人领取 QQ<input required inputMode="numeric" pattern={qqPattern} maxLength={20} value={qq} onChange={(event) => setQq(event.target.value)} placeholder="使用此 QQ 联系运营者" /></label></div>
      {agents.hasNextPage && <button type="button" className={styles.textButton} disabled={agents.isFetchingNextPage} onClick={() => void agents.fetchNextPage()}>加载更多 Agent</button>}
      {!agents.isPending && !ownAgents.length && <p className={styles.hint}>需要一个已启用的 Agent。<Link to="/agents">前往我的 Agent</Link></p>}
      <p className={styles.hint}>付款 Agent 需开启“兑换奖励”权限，并具有足够积分和支出限额。待领取时可取消退回原钱包；进入发放中后由运营者核实处理。</p>
      <label className={rewardStyles.checkbox}><input type="checkbox" required checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />我已确认奖励内容、积分价格和领取说明，并确认填写的 QQ 属于本人。</label>
      <div className={styles.formFooter}><span /><button disabled={command.pending || !accepted || !agentId || !qq.trim() || !canRedeem}>{command.pending ? '正在兑换…' : `支付 ${points(offer.points_cost)} 积分兑换`}</button></div><CommandNotice command={command} />
    </form>
  </section>;
}

function MyRedemptions() {
  const cursor = useCursor();
  const records = useQuery({ queryKey: ['reward-redemptions', cursor.cursor], queryFn: () => api<ListResult<RewardRedemptionDto>>(`/reward-redemptions${queryString({ cursor: cursor.cursor })}`) });
  return <section className={styles.card}><div className={styles.sectionHeading}><h2>我的领取凭证</h2><button className={styles.textButton} onClick={() => void records.refetch()}>刷新凭证</button></div><ErrorNotice error={records.error} />{records.isPending ? <Loading /> : records.data && <>{records.data.items.length ? <div className={rewardStyles.receiptList}>{records.data.items.map((record) => <Link to={`/rewards/${record.id}`} key={record.id} className={rewardStyles.receipt}><div className={rewardStyles.receiptHeading}><strong>{record.title}</strong><RewardBadge status={record.status} /></div><code>{record.claim_code}</code><div><small>{record.agent_name} · {points(record.points_cost)} 积分 · {dateTime(record.created_at)}</small></div></Link>)}</div> : <Empty>还没有兑换记录。</Empty>}<Pagination {...cursor} nextCursor={records.data.next_cursor} /></>}</section>;
}

export function RewardRedemptionPage() {
  const { id = '' } = useParams();
  const record = useQuery({ queryKey: ['reward-redemption', id], queryFn: () => api<RewardRedemptionDto>(`/reward-redemptions/${id}`) });
  return <><Link to="/rewards" className={styles.back}>← 奖励站</Link><div className={styles.pageHeading}><div><div className={styles.eyebrow}>CLAIM RECEIPT</div><h1>奖励领取凭证</h1><p>联系运营者核对身份并领取奖励。</p></div><button className={styles.secondary} onClick={() => void record.refetch()}>刷新状态</button></div><ErrorNotice error={record.error} />{record.isPending ? <Loading /> : record.data && <><section className={`${styles.card} ${rewardStyles.receiptCard}`}><ReceiptDetails record={record.data} /><ClaimCopy key={record.data.id} record={record.data} /></section>{record.data.status === 'pending' && <CancelRedemption key={`${record.data.id}-${record.data.version}`} record={record.data} />}</>}</>;
}

function ReceiptDetails({ record }: { record: RewardRedemptionDto }) {
  return <><div className={styles.sectionHeading}><h2>{record.title}</h2><RewardBadge status={record.status} /></div><p className={rewardStyles.text}>{record.description}</p><span className={rewardStyles.code}>{record.claim_code}</span><dl className={taskStyles.facts}><div><dt>领取人 GitHub</dt><dd>@{record.github_login}</dd></div><div><dt>本人领取 QQ</dt><dd>{record.claimant_qq}</dd></div><div><dt>联系运营者 QQ</dt><dd>{record.contact_qq}</dd></div><div><dt>付款 Agent / 积分</dt><dd>{record.agent_name} · {points(record.points_cost)} 积分</dd></div><div><dt>兑换时间</dt><dd>{dateTime(record.created_at)}</dd></div><div><dt>最新处理时间</dt><dd>{dateTime(record.updated_at)}</dd></div></dl><h3 className={taskStyles.sectionLabel}>兑换时的领取说明</h3><p className={rewardStyles.text}>{record.instructions}</p><p className={styles.hint}>领取编号用于核对记录，奖励仅属于上述用户。已兑换凭证跨月保留。</p>
    {record.status === 'processing' && <p className={taskStyles.notice}>运营者正在处理发放，暂不能自行取消。支付结果尚未确认时，保持此状态并联系运营者核对。</p>}
    {record.status === 'fulfilled' && <p className={styles.success}>已登记发放{record.fulfilled_at ? ` · ${dateTime(record.fulfilled_at)}` : ''}。发放凭据：{record.fulfillment_reference}</p>}
    {record.status === 'cancelled' && <p className={styles.hint}>已取消，{points(record.points_cost)} 积分已退回原付款 Agent。当月兑换累计不恢复。</p>}
    {record.admin_note && <><h3 className={taskStyles.sectionLabel}>处理说明</h3><p className={rewardStyles.text}>{record.admin_note}</p></>}
  </>;
}

function ClaimCopy({ record }: { record: RewardRedemptionDto }) {
  const [notice, setNotice] = useState('');
  if (record.status === 'cancelled') return null;
  const text = `奖励领取\n领取编号：${record.claim_code}\nGitHub：${record.github_login}\n本人领取 QQ：${record.claimant_qq}\n奖励：${record.title}\n联系运营者 QQ：${record.contact_qq}`;
  async function copy() {
    try { await navigator.clipboard.writeText(text); setNotice('领取信息已复制，请使用本人领取 QQ 联系运营者。'); }
    catch { setNotice('未能自动复制，请选择上方领取信息手动复制。'); }
  }
  return <div className={rewardStyles.details}><label className={styles.field}>领取信息<textarea readOnly rows={6} value={text} /></label><button className={styles.secondary} onClick={() => void copy()}>复制领取信息</button>{notice && <p className={styles.hint} role="status">{notice}</p>}</div>;
}

function CancelRedemption({ record }: { record: RewardRedemptionDto }) {
  const [reason, setReason] = useState('');
  const command = useCommand();
  const refresh = useRefreshRewards();
  return <section className={styles.card}><h2>取消未领取奖励</h2><p className={styles.hint}>仅待领取状态可取消。积分退回原付款 Agent，月度兑换次数不恢复。</p><form onSubmit={(event) => { event.preventDefault(); void command.run(`/reward-redemptions/${record.id}/cancel`, 'POST', { version: record.version, reason: reason.trim() }, refresh); }}><label className={styles.field}>取消理由<textarea required rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button className={`${styles.secondary} ${taskStyles.dangerAction}`} disabled={command.pending || !reason.trim()}>取消并退回积分</button><CommandNotice command={command} /></form></section>;
}

export function RewardsAdminPanel() {
  const [tab, setTab] = useState<'claims' | 'catalog'>('claims');
  return <><div className={taskStyles.actions} style={{ marginBottom: 22 }}><button className={tab === 'claims' ? '' : styles.secondary} aria-pressed={tab === 'claims'} onClick={() => setTab('claims')}>领取单管理</button><button className={tab === 'catalog' ? '' : styles.secondary} aria-pressed={tab === 'catalog'} onClick={() => setTab('catalog')}>月度奖励配置</button></div>{tab === 'claims' ? <AdminRedemptions /> : <AdminCatalog />}</>;
}

function AdminCatalog() {
  const [month, setMonth] = useState(monthNow());
  const period = `${month}-01`;
  const catalog = useQuery({ queryKey: ['admin-rewards', 'catalog', period], queryFn: () => api<RewardCatalogDto>(`/admin/reward-pools/${period}`), enabled: /^20\d{2}-(0[1-9]|1[0-2])-01$/.test(period) });
  return <><div className={`${styles.monthPicker} ${rewardStyles.monthPicker}`}><label className={styles.compactField}>奖励月份<input type="month" required min="2000-01" max="2099-12" value={month} onChange={(event) => setMonth(event.target.value)} /></label><span>按北京时间自然月开放兑换</span></div><ErrorNotice error={catalog.error} />{catalog.isPending ? <Loading /> : catalog.data && <><PoolForm key={`${period}-${catalog.data.pool?.version ?? '0'}`} month={period} pool={catalog.data.pool} />{catalog.data.pool && <><div className={styles.detailGrid}><NewOfferForm pool={catalog.data.pool} /><section className={styles.card}><h2>本月奖励商品</h2><p className={styles.hint}>已配置 {catalog.data.pool.allocated_quantity} / {catalog.data.pool.total_quantity} 份。价格和奖励内容固定，调整时新建商品；旧订单保持兑换时条款。</p>{catalog.data.offers.length ? catalog.data.offers.map((offer) => <AdminOffer key={`${offer.id}-${offer.version}`} offer={offer} />) : <Empty>保存月度预算后，在左侧发布奖励商品。</Empty>}</section></div></>}</>}</>;
}

function PoolForm({ month, pool }: { month: string; pool: RewardPoolDto | null }) {
  const [quantity, setQuantity] = useState(pool?.total_quantity ?? '0');
  const [limit, setLimit] = useState(pool?.user_monthly_limit ?? '0');
  const [qq, setQq] = useState(pool?.contact_qq ?? '');
  const [instructions, setInstructions] = useState(pool?.instructions ?? '');
  const [status, setStatus] = useState(pool?.status ?? 'paused');
  const [reason, setReason] = useState('');
  const command = useCommand();
  const refresh = useRefreshRewards();
  return <section className={styles.card}><h2>月度奖励预算</h2><p className={styles.hint}>预算以奖励份数计量，不涉及在线支付。未配置月份不开放兑换；降低预算不能少于已配置商品份数。</p><form onSubmit={(event) => { event.preventDefault(); void command.run(`/admin/reward-pools/${month}`, 'PUT', { version: pool?.version ?? '0', total_quantity: quantity, user_monthly_limit: limit, contact_qq: qq.trim(), instructions: instructions.trim(), status, reason: reason.trim() }, refresh); }}>
    <div className={styles.formGrid}><CountField label="月度奖励总份数" value={quantity} onChange={setQuantity} /><CountField label="每用户月度兑换上限（份）" value={limit} onChange={setLimit} /><label className={styles.field}>运营者联系 QQ<input required inputMode="numeric" pattern={qqPattern} maxLength={20} value={qq} onChange={(event) => setQq(event.target.value)} /></label><label className={styles.field}>兑换状态<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="paused">暂停新兑换</option><option value="active">开放本月兑换</option></select></label></div>
    <label className={styles.field}>领取说明<textarea required rows={3} maxLength={2000} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="说明奖励内容的领取方式、身份核对和预计处理时间" /></label><label className={styles.field}>配置理由<input required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label><div className={styles.formFooter}><small>联系方式与领取说明会保存在每笔订单中。</small><button disabled={command.pending || !reason.trim() || !instructions.trim()}>保存月度配置</button></div><CommandNotice command={command} />
  </form></section>;
}

function NewOfferForm({ pool }: { pool: RewardPoolDto }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [cost, setCost] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const command = useCommand();
  const refresh = useRefreshRewards();
  return <section className={styles.card}><h2>发布奖励商品</h2><form onSubmit={(event) => { event.preventDefault(); void command.run('/admin/reward-offers', 'POST', { pool_id: pool.id, title: title.trim(), description: description.trim(), points_cost: cost, total_quantity: quantity, reason: reason.trim() }, async () => { await refresh(); setTitle(''); setDescription(''); setCost(''); setQuantity(''); setReason(''); }); }}>
    <label className={styles.field}>奖励名称<input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label className={styles.field}>奖励内容<textarea required rows={3} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="明确说明一份奖励包含什么，由你在线下发放" /></label><PointField name="points_cost" label="每份兑换积分" value={cost} onChange={setCost} positive /><CountField label="商品总份数" value={quantity} onChange={setQuantity} positive /><label className={styles.field}>发布理由<input required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label><div className={styles.formFooter}><small>可配置份数 {points((BigInt(pool.total_quantity) - BigInt(pool.allocated_quantity)).toString())}</small><button disabled={command.pending || !title.trim() || !description.trim() || !cost || !quantity || !reason.trim()}>发布奖励商品</button></div><CommandNotice command={command} />
  </form></section>;
}

function AdminOffer({ offer }: { offer: RewardOfferDto }) {
  const [status, setStatus] = useState(offer.status);
  const [quantity, setQuantity] = useState('0');
  const [reason, setReason] = useState('');
  const command = useCommand();
  const refresh = useRefreshRewards();
  return <article className={rewardStyles.adminOffer}><div className={styles.sectionHeading}><h3>{offer.title}</h3><Badge status={offer.status} /></div><p className={rewardStyles.text}>{offer.description}</p><p className={styles.hint}>{points(offer.points_cost)} 积分 / 份 · 剩余 {offer.remaining_quantity} / {offer.total_quantity} 份</p><details><summary>上下架或补充库存</summary><form onSubmit={(event) => { event.preventDefault(); void command.run(`/admin/reward-offers/${offer.id}`, 'PATCH', { version: offer.version, status, add_quantity: quantity, reason: reason.trim() }, refresh); }}><div className={styles.formGrid}><label className={styles.field}>商品状态<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="active">上架</option><option value="paused">下架</option></select></label><CountField label="追加份数" value={quantity} onChange={setQuantity} /></div><label className={styles.field}>调整理由<input required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button className={styles.secondary} disabled={command.pending || !reason.trim()}>保存商品调整</button><CommandNotice command={command} /></form></details></article>;
}

function AdminRedemptions() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const [status, setStatus] = useState('pending');
  const [code, setCode] = useState('');
  const [lookup, setLookup] = useState('');
  const cursor = useCursor();
  const records = useQuery({ queryKey: ['admin-rewards', 'claims', status, lookup, cursor.cursor], queryFn: () => api<ListResult<RewardRedemptionDto>>(`/admin/reward-redemptions${queryString({ status, claim_code: lookup, cursor: cursor.cursor })}`) });
  return <section className={styles.card}><div className={styles.sectionHeading}><div><h2>人工奖励发放</h2><p>支付前先进入发放中；核对领取人后线下支付，再记录结果。</p></div><button className={styles.textButton} onClick={() => void records.refetch()}>刷新领取单</button></div><form className={styles.filters} onSubmit={(event) => { event.preventDefault(); setLookup(code.trim().toUpperCase()); cursor.reset(); }}><label className={styles.field}>领取状态<select value={status} onChange={(event) => { setStatus(event.target.value); cursor.reset(); }}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className={styles.field}>领取编号<input maxLength={36} value={code} onChange={(event) => setCode(event.target.value)} placeholder="RWD-…" /></label><button className={styles.secondary}>查询领取单</button></form><p className={taskStyles.notice}>用户提供领取编号后，请同时核对其 GitHub 账号和登记的 QQ。支付结果未知时保持“发放中”；只有确认未支付，才能取消并退款。</p><ErrorNotice error={records.error ?? me.error} />{records.isPending ? <Loading /> : records.data && <>{records.data.items.length ? <div className={rewardStyles.receiptList}>{records.data.items.map((record) => <AdminRedemption key={`${record.id}-${record.version}`} record={record} currentUserId={me.data?.user.id} />)}</div> : <Empty>没有符合条件的领取单。</Empty>}<Pagination {...cursor} nextCursor={records.data.next_cursor} /></>}</section>;
}

function AdminRedemption({ record, currentUserId }: { record: RewardRedemptionDto; currentUserId: string | undefined }) {
  const [action, setAction] = useState(record.status === 'pending' ? 'process' : 'fulfill');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const command = useCommand();
  const refresh = useRefreshRewards();
  const otherProcessor = record.status === 'processing' && record.processed_by !== currentUserId;
  const actionable = Boolean(currentUserId) && (record.status === 'pending' || (record.status === 'processing' && !otherProcessor));
  return <article className={rewardStyles.receipt}><ReceiptDetails record={record} />{otherProcessor && <p className={taskStyles.notice}>该领取单由其他管理员发放中，请由原处理人核对支付结果并完成登记。</p>}{actionable && <form className={rewardStyles.details} onSubmit={(event) => { event.preventDefault(); void command.run(`/admin/reward-redemptions/${record.id}/${action}`, 'POST', { version: record.version, reason: reason.trim(), ...(action === 'fulfill' ? { fulfillment_reference: reference.trim() } : {}) }, refresh); }}>
    <label className={styles.field}>处理动作<select value={action} onChange={(event) => { setAction(event.target.value); setConfirmed(false); }}>{record.status === 'pending' ? <option value="process">锁定领取单，开始发放</option> : <option value="fulfill">登记已完成线下发放</option>}<option value="cancel">确认未支付，取消并退款</option></select></label>
    {action === 'fulfill' && <label className={styles.field}>发放凭据<input required maxLength={500} value={reference} onChange={(event) => setReference(event.target.value)} placeholder="填写可核对的线下支付记录编号或发放说明" /></label>}
    <label className={styles.field}>处理说明<textarea required maxLength={500} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
    {action !== 'process' && <label className={rewardStyles.checkbox}><input required type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{action === 'fulfill' ? '我已核对领取人，并确认该奖励已经线下发放。' : '我已核对并确认没有支付该奖励，同意取消并退回积分。'}</label>}
    <button className={action === 'cancel' ? `${styles.secondary} ${taskStyles.dangerAction}` : ''} disabled={command.pending || !reason.trim() || (action !== 'process' && !confirmed) || (action === 'fulfill' && !reference.trim())}>{command.pending ? '正在保存…' : action === 'process' ? '标记发放中' : action === 'fulfill' ? '确认已发放' : '确认未支付并退款'}</button><CommandNotice command={command} />
  </form>}</article>;
}
