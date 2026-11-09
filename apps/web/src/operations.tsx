import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dateTime, monthNow, points, queryString, useCommand } from './api';
import { Badge, CommandNotice, Empty, ErrorNotice, Loading, Pagination, PointField, useCursor } from './components';
import type { IssuancePeriod, ListResult, Transaction, User } from './types';
import { RepositoriesPanel } from './repositories';
import { RewardsAdminPanel } from './rewards';
import { ContributionsAdminPanel } from './contributions';
import { MarketAdminPanel } from './market';
import styles from './style.module.css';
import taskStyles from './tasks.module.css';

export function AdminPage() {
  const [tab, setTab] = useState<'users' | 'issuance' | 'repositories' | 'contributions' | 'rewards' | 'market' | 'records'>('users');
  return <><div className={styles.pageHeading}><div><div className={styles.eyebrow}>OPERATIONS</div><h1>运营管理</h1><p>管理内测准入与发行预算，核对每一笔真实记录。</p></div><span className={styles.adminMark}>管理员</span></div>
    <div className={`${styles.tabs} ${taskStyles.tabs}`} role="tablist" aria-label="运营管理">{([['users', '用户准入'], ['issuance', '发行管理'], ['repositories', '仓库准入'], ['contributions', 'GitHub 奖励'], ['rewards', '奖励管理'], ['market', '市场供应'], ['records', '账本与审计']] as const).map(([value, label]) => <button role="tab" aria-selected={tab === value} className={tab === value ? styles.tabActive : ''} key={value} onClick={() => setTab(value)}>{label}</button>)}</div>
    <div role="tabpanel">{tab === 'users' ? <UsersPanel /> : tab === 'issuance' ? <IssuancePanel /> : tab === 'repositories' ? <RepositoriesPanel /> : tab === 'contributions' ? <ContributionsAdminPanel /> : tab === 'rewards' ? <RewardsAdminPanel /> : tab === 'market' ? <MarketAdminPanel /> : <RecordsPanel />}</div>
  </>;
}

function UsersPanel() {
  const [status, setStatus] = useState('pending');
  const cursor = useCursor();
  const users = useQuery({ queryKey: ['admin-users', status, cursor.cursor], queryFn: () => api<ListResult<User>>(`/admin/users${queryString({ status, cursor: cursor.cursor })}`) });
  return <section className={styles.card}><div className={styles.sectionHeading}><div><h2>内测用户</h2><p>首次登录的用户需要明确准入。</p></div><label className={styles.compactField}>状态<select value={status} onChange={(event) => { setStatus(event.target.value); cursor.reset(); }}><option value="pending">待准入</option><option value="active">已启用</option><option value="suspended">已停用</option><option value="">全部用户</option></select></label></div><ErrorNotice error={users.error} />{users.isPending ? <Loading /> : users.data && <>{users.data.items.length ? <div className={styles.userList}>{users.data.items.map((user) => <UserRow key={`${user.id}-${user.status}`} user={user} />)}</div> : <Empty>当前没有符合条件的用户。</Empty>}<Pagination {...cursor} nextCursor={users.data.next_cursor} /></>}</section>;
}

function UserRow({ user }: { user: User }) {
  const [status, setStatus] = useState(user.status);
  const [reason, setReason] = useState('');
  const command = useCommand();
  const client = useQueryClient();
  return <article className={styles.userRow}><div className={styles.userIdentity}><span className={styles.avatar}>{(user.display_name || user.github_login).slice(0, 1)}</span><div><strong>{user.display_name || user.github_login}</strong><small>@{user.github_login} · {user.role}</small><small className={styles.mono}>{user.id}</small></div><Badge status={user.status} /></div><form className={styles.inlineForm} onSubmit={(event) => { event.preventDefault(); void command.run(`/admin/users/${user.id}`, 'PATCH', { status, reason: reason.trim() }, () => client.invalidateQueries({ queryKey: ['admin-users'] })); }}><label className={styles.field}>准入状态<select value={status} onChange={(event) => setStatus(event.target.value as User['status'])}><option value="pending">待准入</option><option value="active">已启用</option><option value="suspended">已停用</option></select></label><label className={styles.field}>处理理由<input required value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="记录本次处理依据" /></label><button disabled={command.pending || !reason.trim() || status === user.status}>保存状态</button></form><CommandNotice command={command} /></article>;
}

function IssuancePanel() {
  const [month, setMonth] = useState(monthNow());
  const period = `${month}-01`;
  const budget = useQuery({ queryKey: ['issuance-period', period], queryFn: () => api<IssuancePeriod>(`/admin/issuance-periods/${period}`), enabled: /^\d{4}-\d{2}-01$/.test(period) });
  return <><div className={styles.monthPicker}><label className={styles.compactField}>发行月份<input type="month" required value={month} onChange={(event) => setMonth(event.target.value)} /></label><span>自然月按 Asia/Shanghai 计算</span></div><ErrorNotice error={budget.error} />{budget.isPending ? <Loading /> : budget.data && <><div className={styles.walletGrid}><div className={styles.balanceCard}><span>月发行上限</span><strong>{points(budget.data.limit_points)}</strong></div><div className={styles.balanceCard}><span>已发行积分</span><strong>{points(budget.data.issued_points)}</strong></div><div className={`${styles.balanceCard} ${styles.available}`}><span>剩余预算</span><strong>{points((BigInt(budget.data.limit_points) - BigInt(budget.data.issued_points)).toString())}</strong></div></div><div className={styles.detailGrid}><BudgetForm key={`${period}-${budget.data.limit_points}`} period={period} budget={budget.data} /><IssueForm key={period} period={period} /></div></>}</>;
}

function BudgetForm({ period, budget }: { period: string; budget: IssuancePeriod }) {
  const [limit, setLimit] = useState(budget.limit_points);
  const [reason, setReason] = useState('');
  const command = useCommand();
  const client = useQueryClient();
  return <section className={styles.card}><h2>设置发行上限</h2><p className={styles.hint}>未配置月份的预算为 0。上限不得低于已发行量。</p><form onSubmit={(event) => { event.preventDefault(); void command.run(`/admin/issuance-periods/${period}`, 'PUT', { limit_points: limit, reason: reason.trim() }, () => client.invalidateQueries({ queryKey: ['issuance-period', period] })); }}><PointField name="limit_points" label="月发行上限" value={limit} onChange={setLimit} /><label className={styles.field}>预算调整理由<textarea required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} rows={3} /></label><div className={styles.formFooter}><span /><button disabled={command.pending || !reason.trim()}>保存预算</button></div><CommandNotice command={command} /></form></section>;
}

function IssueForm({ period }: { period: string }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [businessId, setBusinessId] = useState(() => crypto.randomUUID());
  const command = useCommand();
  const client = useQueryClient();
  return <section className={styles.card}><h2>发行到平台奖励池</h2><p className={styles.hint}>仅发行到平台奖励池，受当月剩余预算约束。</p><form onSubmit={(event) => { event.preventDefault(); void command.run('/admin/issuances', 'POST', { month: period, amount, reason: reason.trim(), business_id: businessId }, async () => { await client.invalidateQueries({ queryKey: ['issuance-period', period] }); setBusinessId(crypto.randomUUID()); setAmount(''); setReason(''); }); }}><PointField name="amount" label="本次发行积分" value={amount} onChange={setAmount} positive /><label className={styles.field}>发行理由<textarea required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} rows={3} /></label><p className={styles.hint}>业务编号 <code>{businessId}</code></p><div className={styles.formFooter}><span /><button disabled={command.pending || !amount || !reason.trim()}>{command.pending ? '正在发行…' : '确认发行'}</button></div><CommandNotice command={command} /></form></section>;
}

interface AuditEvent { id: string; action: string; actor_type: string; actor_user_id: string | null; actor_agent_id: string | null; business_key: string | null; target_type: string; target_id: string; created_at: string; details: Record<string, unknown> }
function RecordsPanel() {
  const [kind, setKind] = useState<'ledger' | 'audit-events'>('ledger');
  const [fields, setFields] = useState({ account_id: '', agent_id: '', user_id: '', business_key: '' });
  const [filters, setFilters] = useState(fields);
  const cursor = useCursor();
  const records = useQuery({ queryKey: ['admin-records', kind, filters, cursor.cursor], queryFn: () => api<ListResult<Transaction | AuditEvent>>(`/admin/${kind}${queryString({ ...filters, cursor: cursor.cursor })}`) });
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const reconciliation = useCommand();
  const [operationId, setOperationId] = useState('');
  const [lookup, setLookup] = useState('');
  const operation = useQuery({ queryKey: ['operation', lookup], queryFn: () => api<Record<string, unknown>>(`/operations/${encodeURIComponent(lookup)}`), enabled: Boolean(lookup) });
  return <><section className={styles.card}><div className={styles.sectionHeading}><h2>运营记录</h2><select aria-label="记录类型" value={kind} onChange={(event) => { setKind(event.target.value as typeof kind); cursor.reset(); }}><option value="ledger">账本流水</option><option value="audit-events">操作审计</option></select></div><form className={styles.filters} onSubmit={(event) => { event.preventDefault(); setFilters(fields); cursor.reset(); }}>{(['account_id', 'agent_id', 'user_id', 'business_key'] as const).map((field) => <label className={styles.field} key={field}>{({ account_id: '账户 ID', agent_id: 'Agent ID', user_id: '用户 ID', business_key: '业务键' })[field]}<input value={fields[field]} onChange={(event) => setFields({ ...fields, [field]: event.target.value })} /></label>)}<button className={styles.secondary}>查询记录</button></form><ErrorNotice error={records.error} />{records.isPending ? <Loading /> : records.data && <>{records.data.items.length ? <div className={styles.tableScroll}><table><thead><tr><th>时间</th><th>操作 / 类型</th><th>业务 / 目标</th><th>详情</th></tr></thead><tbody>{records.data.items.map((record) => <tr key={record.id}><td>{dateTime(record.created_at)}</td><td>{'action' in record ? <>{record.action}<small>{record.actor_type} · {record.actor_user_id ?? record.actor_agent_id ?? 'system'}</small></> : record.kind}</td><td className={styles.mono}>{record.business_key ?? ('target_id' in record ? `${record.target_type}:${record.target_id}` : '—')}</td><td>{'details' in record ? <details><summary>查看详情</summary><pre className={styles.json}>{JSON.stringify(record.details, null, 2)}</pre></details> : record.reason}</td></tr>)}</tbody></table></div> : <Empty>没有符合条件的记录。</Empty>}<Pagination {...cursor} nextCursor={records.data.next_cursor} /></>}</section>
    <div className={styles.detailGrid}><section className={styles.card}><div className={styles.sectionHeading}><div><h2>账本对账</h2><p>核验余额、冻结与累计发行的一致性。</p></div><button className={styles.secondary} disabled={reconciliation.pending} onClick={() => void reconciliation.run<Record<string, unknown>>('/admin/reconciliation', 'POST', {}, setReport)}>{reconciliation.pending ? '正在核验…' : '生成对账报告'}</button></div><CommandNotice command={reconciliation} />{report && <pre className={styles.json} aria-label="对账报告">{JSON.stringify(report, null, 2)}</pre>}<p className={styles.hint}>发现差异时暂停受影响的资金写入，并保留历史记录。</p></section>
    <section className={styles.card}><h2>查询业务结果</h2><p className={styles.hint}>使用响应中保存的业务编号查询已提交结果。</p><form className={styles.inlineForm} onSubmit={(event) => { event.preventDefault(); if (lookup === operationId.trim()) void operation.refetch(); else setLookup(operationId.trim()); }}><label className={styles.field}>业务编号<input required value={operationId} onChange={(event) => setOperationId(event.target.value)} /></label><button className={styles.secondary}>查询</button></form><ErrorNotice error={operation.error} />{lookup && operation.isPending && <Loading />}{operation.data && <pre className={styles.json}>{JSON.stringify(operation.data, null, 2)}</pre>}</section></div>
  </>;
}
