import { useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ContributionKindValue, ContributionRewardDto, ContributionRewardPreferenceDto, ContributionRewardSettingsDto, ContributionRewardsPageDto } from '@agentzero/contracts';
import { api, ApiError, dateTime, points, queryString, useCommand } from './api';
import { CommandNotice, Empty, ErrorNotice, Loading, Pagination, PointField, useCursor } from './components';
import { RepositoryRequestsPanel } from './repository-requests';
import type { Agent, ListResult } from './types';
import styles from './style.module.css';
import taskStyles from './tasks.module.css';

const kinds: { kind: ContributionKindValue; label: string; field: 'commit_points' | 'pull_request_points' | 'issue_points' }[] = [
  { kind: 'commit', label: 'Commit', field: 'commit_points' },
  { kind: 'pull_request', label: 'Pull Request', field: 'pull_request_points' },
  { kind: 'issue', label: 'Issue', field: 'issue_points' },
];

function useRefreshContributions() {
  const client = useQueryClient();
  return async () => { await Promise.all(['contributions', 'repository-requests', 'admin-contribution-rewards', 'wallet', 'transactions'].map(key => client.invalidateQueries({ queryKey: [key] }))); };
}

export function ContributionsPage() {
  const cursor = useCursor();
  const contributions = useQuery({ queryKey: ['contributions', cursor.cursor], queryFn: () => api<ContributionRewardsPageDto>(`/contributions${queryString({ cursor: cursor.cursor })}`) });
  const refresh = useRefreshContributions();
  const data = contributions.data;
  return <>
    <div className={styles.pageHeading}><div><div className={styles.eyebrow}>GITHUB CONTRIBUTIONS</div><h1>GitHub 贡献</h1><p>提交 Commit、Pull Request 或 Issue，获得对应的积分奖励。</p></div><button className={styles.secondary} onClick={() => void refresh()}>刷新贡献</button></div>
    <ErrorNotice error={contributions.error} />
    {contributions.isPending ? <Loading /> : data && <>
      <div className={styles.walletGrid}>{kinds.map(({ kind, label, field }) => <div className={styles.balanceCard} key={kind}><span>{label}</span><strong>{points(data.settings[field])}<small> 积分 / 个</small></strong><small>{data.settings[field] === '0' ? '暂未开启' : '每个对象奖励一次'}</small></div>)}</div>
      <p className={styles.hint}>仓库准入后会自动补算现存各分支的历史 Commit，以及所有状态的 PR、Issue。奖励归贡献作者，PR 无需合并；历史补算、实时到账和链接补领共用一次奖励。</p>
      <div className={styles.detailGrid}><PreferenceForm key={data.preference.version} preference={data.preference} /><ClaimForm settings={data.settings} /></div>
      <RepositoryRequestsPanel />
      <section className={styles.card} aria-label="积分到账记录"><div className={styles.sectionHeading}><h2>积分到账记录</h2><span className={styles.hint}>按到账时间排序</span></div>
        {data.items.length ? <div className={styles.tableScroll}><table><thead><tr><th>贡献</th><th>积分</th><th>收款 Agent</th><th>到账时间</th></tr></thead><tbody>{data.items.map(record => <tr key={record.id}><td><a href={record.url} target="_blank" rel="noreferrer">{record.title || record.object_id}</a><small>{kinds.find(item => item.kind === record.kind)?.label} · {record.kind === 'commit' ? record.object_id.slice(0, 12) : `#${record.object_id}`}</small></td><td className={styles.numeric}>+{points(record.points)}</td><td><Link to={`/agents/${record.agent_id}`}>查看收款钱包</Link><small className={taskStyles.sha}>{record.agent_id}</small></td><td>{dateTime(record.created_at)}</td></tr>)}</tbody></table></div> : <Empty>还没有积分到账记录。设置自动收款后，获准仓库的历史贡献会在后台陆续补算，也可通过链接补领。</Empty>}
        <Pagination {...cursor} nextCursor={data.next_cursor} />
      </section>
    </>}
  </>;
}

function AgentPicker({ label, value, onChange, disabled, optional = false }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean; optional?: boolean }) {
  const agents = useInfiniteQuery({ queryKey: ['agents', 'contribution-options'], queryFn: ({ pageParam }) => api<ListResult<Agent>>(`/agents${queryString({ cursor: pageParam, limit: '100' })}`), initialPageParam: undefined as string | undefined, getNextPageParam: last => last.next_cursor ?? undefined });
  const available = agents.data?.pages.flatMap(page => page.items).filter(agent => agent.status === 'active') ?? [];
  return <><ErrorNotice error={agents.error} /><label className={styles.field}>{label}<select required={!optional} disabled={disabled || agents.isPending} value={value} onChange={event => onChange(event.target.value)}><option value="">{optional ? '关闭自动收款' : '选择所属 Agent'}</option>{value && !available.some(agent => agent.id === value) && <option value={value} disabled>{value}（当前不可选）</option>}{available.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
    {agents.hasNextPage && <button type="button" className={styles.textButton} disabled={disabled || agents.isFetchingNextPage} onClick={() => void agents.fetchNextPage()}>加载更多 Agent</button>}
    {!agents.isPending && !available.length && <p className={styles.hint}>需要一个已启用的 Agent。<Link to="/agents">前往我的 Agent</Link></p>}
  </>;
}

function PreferenceForm({ preference }: { preference: ContributionRewardPreferenceDto }) {
  const [agentId, setAgentId] = useState(preference.agent_id ?? '');
  const command = useCommand(), refresh = useRefreshContributions();
  const uncertain = command.error instanceof ApiError && command.error.uncertain;
  return <section className={styles.card}><h2>自动收款</h2><p className={styles.hint}>选择一个所属 Agent，历史补算和新贡献的奖励会在核验通过后进入它的钱包。也可在仓库接入后再设置，待处理的历史贡献会自动重试，无需逐条提交链接。</p>
    <form onSubmit={event => { event.preventDefault(); void command.run('/contributions/preference', 'PUT', { agent_id: agentId || null, version: preference.version }, refresh); }}>
      <AgentPicker label="自动收款 Agent" value={agentId} onChange={setAgentId} disabled={command.pending || uncertain} optional />
      <button disabled={command.pending || (!uncertain && agentId === (preference.agent_id ?? ''))}>{command.pending ? '正在保存…' : '保存自动收款'}</button><CommandNotice command={command} />
    </form>
  </section>;
}

function ClaimForm({ settings }: { settings: ContributionRewardSettingsDto }) {
  const [agentId, setAgentId] = useState(''), [url, setUrl] = useState('');
  const [receipt, setReceipt] = useState<ContributionRewardDto | null>(null);
  const payload = useRef<{ agent_id: string; url: string; version: string } | null>(null);
  const command = useCommand(), refresh = useRefreshContributions();
  const uncertain = command.error instanceof ApiError && command.error.uncertain;
  const enabled = kinds.some(item => settings[item.field] !== '0');
  return <section className={styles.card}><h2>链接补领</h2><p className={styles.hint}>填写本人提交的 GitHub Commit、PR 或 Issue 链接，核验通过后按当前奖励金额到账。</p>
    <form onSubmit={event => {
      event.preventDefault();
      if (!uncertain || !payload.current) payload.current = { agent_id: agentId, url: url.trim(), version: settings.version };
      setReceipt(null);
      void command.run<ContributionRewardDto>('/contributions/claim', 'POST', payload.current, async result => { setReceipt(result); await refresh(); });
    }}>
      <AgentPicker label="补领收款 Agent" value={agentId} onChange={setAgentId} disabled={command.pending || uncertain} />
      <label className={styles.field}>GitHub 贡献链接<input type="url" required maxLength={2000} value={url} onChange={event => setUrl(event.target.value)} disabled={command.pending || uncertain} placeholder="https://github.com/owner/repo/pull/123" /></label>
      {!enabled && <p className={styles.hint}>当前三类奖励均未开启，等待管理员配置金额。</p>}
      <button disabled={command.pending || !agentId || !url.trim() || (!enabled && !uncertain)}>{command.pending ? '正在核验…' : '核验并领取积分'}</button><CommandNotice command={command} />
      {receipt && <p role="status" className={styles.success}>此贡献已到账 {points(receipt.points)} 积分。<Link to={`/agents/${receipt.agent_id}`}>查看收款钱包</Link></p>}
    </form>
  </section>;
}

export function ContributionsAdminPanel() {
  const settings = useQuery({ queryKey: ['admin-contribution-rewards'], queryFn: () => api<ContributionRewardSettingsDto>('/admin/contribution-rewards') });
  return <section className={styles.card}><div className={styles.sectionHeading}><div><h2>GitHub 提交奖励</h2><p>设置每个 Commit、Pull Request 和 Issue 的积分。0 表示关闭该类奖励。</p></div><button className={styles.secondary} onClick={() => void settings.refetch()}>刷新奖励配置</button></div><p className={styles.hint}>自动到账与链接补领使用同一组金额，积分从平台奖励池支付。修改金额只影响后续发奖，已到账记录保持原金额。</p><ErrorNotice error={settings.error} />{settings.isPending ? <Loading /> : settings.data && <SettingsForm key={settings.data.version} settings={settings.data} />}</section>;
}

function SettingsForm({ settings }: { settings: ContributionRewardSettingsDto }) {
  const [amounts, setAmounts] = useState({ commit_points: settings.commit_points, pull_request_points: settings.pull_request_points, issue_points: settings.issue_points });
  const [reason, setReason] = useState('');
  const command = useCommand(), refresh = useRefreshContributions();
  const uncertain = command.error instanceof ApiError && command.error.uncertain;
  return <form onSubmit={event => { event.preventDefault(); void command.run('/admin/contribution-rewards', 'PUT', { version: settings.version, ...amounts, reason: reason.trim() }, refresh); }}>
    <fieldset disabled={command.pending || uncertain} style={{ border: 0, margin: 0, padding: 0 }}><div className={styles.formGrid}>{kinds.map(({ kind, label, field }) => <PointField key={kind} name={field} label={`${label} 奖励积分`} value={amounts[field]} onChange={value => setAmounts(previous => ({ ...previous, [field]: value }))} />)}</div><label className={styles.field}>配置理由<textarea required maxLength={500} rows={3} value={reason} onChange={event => setReason(event.target.value)} /></label></fieldset>
    <div className={styles.formFooter}><span className={styles.hint}>最近更新：{dateTime(settings.updated_at)}</span><button disabled={command.pending || !reason.trim() || kinds.some(item => amounts[item.field] === '')}>{command.pending ? '正在保存…' : '保存奖励配置'}</button></div><CommandNotice command={command} />
  </form>;
}
