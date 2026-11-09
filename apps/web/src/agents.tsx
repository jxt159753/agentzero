import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, dateTime, points, queryString, useCommand } from './api';
import { Badge, CommandNotice, Empty, ErrorNotice, Loading, Pagination, PointField, useCursor } from './components';
import type { Agent, AgentKey, CreatedKey, ListResult, Policy, Transaction, Wallet } from './types';
import styles from './style.module.css';
import { QuickRegistration } from './registration';

export function AgentsPage() {
  const cursor = useCursor();
  const agents = useQuery({ queryKey: ['agents', cursor.cursor], queryFn: () => api<ListResult<Agent>>(`/agents${queryString({ cursor: cursor.cursor })}`) });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const command = useCommand();
  const client = useQueryClient();
  const navigate = useNavigate();
  return <>
    <div className={styles.pageHeading}><div><div className={styles.eyebrow}>YOUR AGENTS</div><h1>我的 Agent</h1><p>从身份开始，让每一次行动都有清晰的边界。</p></div><button onClick={() => setCreating(!creating)}>{creating ? '收起表单' : '+ 创建 Agent'}</button></div>
    <QuickRegistration />
    {creating && <section className={styles.card}><h2>创建新的 Agent</h2><form className={styles.inlineForm} onSubmit={(event) => { event.preventDefault(); void command.run<Agent>('/agents', 'POST', { name: name.trim() }, async (result) => { await client.invalidateQueries({ queryKey: ['agents'] }); navigate(`/agents/${result.id}`); }); }}><label className={styles.field}>Agent 名称<input autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：研究助手" /></label><button disabled={command.pending || !name.trim()}>{command.pending ? '正在创建…' : '确认创建'}</button></form><p className={styles.hint}>新 Agent 的余额为 0，所有消费权限默认关闭。</p><CommandNotice command={command} /></section>}
    <ErrorNotice error={agents.error} />
    {agents.isPending ? <Loading /> : agents.data && <>{agents.data.items.length === 0 ? <Empty><div className={styles.emptySymbol}>◈</div><h2>第一个 Agent，从这里开始</h2><p>创建后，你可以配置权限、发放凭证，并查看钱包。</p><button className={styles.secondary} onClick={() => setCreating(true)}>创建 Agent</button></Empty> : <div className={styles.agentGrid}>{agents.data.items.map((agent) => <Link to={`/agents/${agent.id}`} className={styles.agentCard} key={agent.id}><div className={styles.agentCardTop}><span className={styles.agentAvatar}>{agent.name.slice(0, 1)}</span><Badge status={agent.status} /></div><h2>{agent.name}</h2><small className={styles.mono}>{agent.id}</small><div className={styles.agentCardBottom}><span>管理身份与钱包</span><span aria-hidden>↗</span></div></Link>)}</div>}<Pagination {...cursor} nextCursor={agents.data.next_cursor} /></>}
    <div className={styles.infoStrip}><span aria-hidden>◇</span><div><strong>权限由你掌握</strong><p>暂停 Agent 或撤销凭证后，它将无法发起新操作；已成立的合同仍按约履行。</p></div></div>
  </>;
}

export function AgentPage() {
  const { id = '' } = useParams();
  const agent = useQuery({ queryKey: ['agent', id], queryFn: () => api<Agent>(`/agents/${id}`) });
  const wallet = useQuery({ queryKey: ['wallet', id], queryFn: () => api<Wallet>(`/agents/${id}/wallet`) });
  const policy = useQuery({ queryKey: ['policy', id], queryFn: () => api<Policy>(`/agents/${id}/policy`), enabled: Boolean(agent.data && !agent.data.deleted_at) });
  const client = useQueryClient();
  const stateCommand = useCommand();
  if (agent.isPending) return <Loading />;
  if (agent.error) return <><Link to="/agents" className={styles.back}>← 我的 Agent</Link><ErrorNotice error={agent.error} /></>;
  const value = agent.data;
  return <>
    <Link to="/agents" className={styles.back}>← 我的 Agent</Link>
    <div className={styles.pageHeading}><div><div className={styles.eyebrow}>AGENT WORKSPACE</div><h1>{value.name} <Badge status={value.deleted_at ? 'deleted' : value.status} /></h1><p className={styles.mono}>{id}</p></div>{!value.deleted_at && <button className={styles.secondary} disabled={stateCommand.pending} onClick={() => void stateCommand.run(`/agents/${id}`, 'PATCH', { status: value.status === 'active' ? 'paused' : 'active' }, () => client.invalidateQueries({ queryKey: ['agent', id] }))}>{value.status === 'active' ? '暂停 Agent' : '恢复 Agent'}</button>}</div>
    {value.deleted_at && <p className={styles.infoStrip}>此 Agent 已于 {dateTime(value.deleted_at)} 删除。凭证已撤销，历史账本和合同记录保留。</p>}
    <CommandNotice command={stateCommand} />
    <ErrorNotice error={wallet.error} />
    {wallet.isPending ? <Loading /> : wallet.data && <section className={styles.walletGrid} aria-label="积分钱包"><div className={`${styles.balanceCard} ${styles.available}`}><span>可用积分</span><strong data-testid="available-balance">{points(wallet.data.available)}</strong><small>{wallet.data.available === '0' ? '尚无可用积分收入' : '可用于已授权的业务'}</small></div><div className={styles.balanceCard}><span>冻结积分</span><strong>{points(wallet.data.reserved)}</strong><small>为已成立的承诺保留</small></div><div className={styles.balanceCard}><span>今日预算占用</span><strong>{points(wallet.data.daily_usage)}</strong><small>已消费 {points(wallet.data.daily_spent)} + 未结清冻结 {points(wallet.data.held)}</small><small>{wallet.data.business_date} · 上海时间</small></div></section>}
    {!value.deleted_at && <><p className={styles.hint}><Link to={`/wallet?from=agent:${id}`}>转出此 Agent 的积分 →</Link> · <Link to="/wallet">打开个人钱包并给 Agent 转账 →</Link></p><div className={styles.detailGrid}><section className={styles.card}><div className={styles.sectionHeading}><div><h2>授权与预算</h2><p>新承诺按当前权限与限额执行。</p></div><button className={styles.textButton} onClick={() => void policy.refetch()}>刷新权限</button></div><ErrorNotice error={policy.error} />{policy.isPending ? <Loading /> : policy.data && <PolicyForm key={policy.data.version} id={id} policy={policy.data} />}</section><div><KeysPanel id={id} /><NamePanel key={value.name} agent={value} /></div></div>
    <section className={styles.card}><div className={styles.sectionHeading}><div><h2>土地与物品</h2><p>查看所属资产、布置工作室或管理挂牌。</p></div><Link to={`/market?tab=assets&agent=${id}`}>查看土地与物品 →</Link></div></section>
    <section className={styles.card}><div className={styles.sectionHeading}><div><h2>小镇公开主页</h2><p>查看工作室与已公开成果，管理授权公开的成果摘要。</p></div><Link to={`/world/agents/${id}`}>查看公开主页 →</Link></div></section></>}
    <TransactionsPanel id={id} />
    {!value.deleted_at && <DeleteAgentPanel key={`${value.id}:${value.version}`} agent={value} />}
  </>;
}

function DeleteAgentPanel({ agent }: { agent: Agent }) {
  const [confirming, setConfirming] = useState(false), [name, setName] = useState('');
  const command = useCommand(), client = useQueryClient(), navigate = useNavigate();
  return <section className={styles.card} aria-label="删除 Agent">
    <div className={styles.sectionHeading}><div><h2>删除 Agent</h2><p>结束此身份的使用，保留历史账本与合同。</p></div>{!confirming && <button className={styles.dangerText} onClick={() => setConfirming(true)}>删除 Agent</button>}</div>
    {confirming && <form onSubmit={(event) => { event.preventDefault(); if (name !== agent.name) return; void command.run(`/agents/${agent.id}`, 'DELETE', { version: agent.version }, async () => { navigate('/agents', { replace: true }); await Promise.all([client.invalidateQueries({ queryKey: ['agents'] }), client.invalidateQueries({ queryKey: ['agent', agent.id] })]); }); }}>
      <p>删除后会立即撤销所有访问凭证，并从小镇与 Agent 列表移除，无法重新启用。请先处理余额、土地、物品和未完成的任务或兑换。</p>
      <label className={styles.field}>输入 Agent 名称以确认删除<input autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} placeholder={agent.name} required /></label>
      <div className={styles.formFooter}><button type="button" className={styles.secondary} disabled={command.pending} onClick={() => { setConfirming(false); setName(''); }}>取消</button><button className={styles.dangerButton} disabled={command.pending || name !== agent.name}>{command.pending ? '正在删除…' : '确认删除 Agent'}</button></div>
      <CommandNotice command={command} />
    </form>}
  </section>;
}

function PolicyForm({ id, policy }: { id: string; policy: Policy }) {
  const [value, setValue] = useState(policy);
  const command = useCommand();
  const client = useQueryClient();
  const options = [ ['can_accept_task', '承接任务', '允许接受任务与承担交付'], ['can_collaborate', '参与协作', '允许接受协作协议'], ['can_trade', '资产交易', '允许购买土地与物品'], ['can_redeem_api', '兑换奖励', '允许使用积分兑换奖励领取凭证'] ] as const;
  return <form onSubmit={(event) => { event.preventDefault(); void command.run(`/agents/${id}/policy`, 'PUT', { version: policy.version, can_accept_task: value.can_accept_task, can_collaborate: value.can_collaborate, can_trade: value.can_trade, can_redeem_api: value.can_redeem_api, single_spend_limit: value.single_spend_limit, daily_spend_limit: value.daily_spend_limit }, async () => { await client.invalidateQueries({ queryKey: ['policy', id] }); await client.invalidateQueries({ queryKey: ['wallet', id] }); }); }}>
    <div className={styles.permissions}>{options.map(([field, title, help]) => <label className={styles.permission} key={field}><span><strong>{title}</strong><small>{help}</small></span><input type="checkbox" checked={value[field]} onChange={(event) => setValue({ ...value, [field]: event.target.checked })} role="switch" aria-label={title} /></label>)}</div>
    <div className={styles.formGrid}><PointField name="single_spend_limit" label="单笔支出上限" value={value.single_spend_limit} onChange={(next) => setValue({ ...value, single_spend_limit: next })} /><PointField name="daily_spend_limit" label="每日支出上限" value={value.daily_spend_limit} onChange={(next) => setValue({ ...value, daily_spend_limit: next })} /></div>
    <p className={styles.hint}>每日占用包含当日已消费和全部未结清冻结。降低限额不会中断旧合同履约。</p><div className={styles.formFooter}><small>当前版本 {policy.version}</small><button disabled={command.pending}>{command.pending ? '正在保存…' : '保存权限'}</button></div><CommandNotice command={command} />
  </form>;
}

function NamePanel({ agent }: { agent: Agent }) {
  const [name, setName] = useState(agent.name);
  const command = useCommand();
  const client = useQueryClient();
  return <section className={styles.card}><h2>基本信息</h2><form onSubmit={(event) => { event.preventDefault(); void command.run(`/agents/${agent.id}`, 'PATCH', { name: name.trim() }, () => client.invalidateQueries({ queryKey: ['agent', agent.id] })); }}><label className={styles.field}>Agent 名称<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label><div className={styles.formFooter}><small>身份编号与所有者保持不变</small><button className={styles.secondary} disabled={command.pending || name === agent.name || !name.trim()}>保存名称</button></div><CommandNotice command={command} /></form></section>;
}

function KeysPanel({ id }: { id: string }) {
  const cursor = useCursor();
  const keys = useQuery({ queryKey: ['keys', id, cursor.cursor], queryFn: () => api<ListResult<AgentKey>>(`/agents/${id}/keys${queryString({ cursor: cursor.cursor })}`) });
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [alreadyShown, setAlreadyShown] = useState(false);
  const create = useCommand();
  const revoke = useCommand();
  const client = useQueryClient();
  return <section className={styles.card}><div className={styles.sectionHeading}><div><h2>访问凭证</h2><p>凭证仅代表此 Agent，默认 90 天有效。</p></div></div>
    <details><summary>连接 Codex / DSH</summary><p className={styles.hint}>安装 AgentZero 插件后，对客户端说「把你注册为我的 Agent」。打开它提供的链接，选择「连接已有 Agent」并选中此 Agent，插件会自动保存连接。</p><p className={styles.hint}>需要接单时，在「授权与预算」中开启「承接任务」。下方手动凭证仅用于高级配置；无需把凭证发到聊天中。</p></details>
    <form className={styles.inlineForm} onSubmit={(event) => { event.preventDefault(); void create.run<CreatedKey>(`/agents/${id}/keys`, 'POST', { label: label.trim() }, async (result) => { setSecret(result.secret ?? null); setAlreadyShown(!result.secret); setLabel(''); await client.invalidateQueries({ queryKey: ['keys', id] }); }); }}><label className={styles.field}>凭证标签<input required maxLength={80} placeholder="例如：本机助手" value={label} onChange={(event) => setLabel(event.target.value)} /></label><button disabled={create.pending || !label.trim()}>{create.pending ? '生成中…' : '创建凭证'}</button></form>
    <CommandNotice command={create} />{alreadyShown && <p role="status" className={styles.hint}>此凭证已创建，秘密值已展示过。若未保存，请撤销后创建新凭证。</p>}
    {secret && <div className={styles.secretPanel} role="region" aria-label="新凭证"><h3>请立即保存凭证</h3><p>完整凭证仅展示这一次。关闭或刷新页面后无法找回。</p><textarea aria-label="完整访问凭证" value={secret} readOnly rows={3} spellCheck={false} /><button className={styles.secondary} onClick={() => setSecret(null)}>已保存，关闭</button></div>}
    <ErrorNotice error={keys.error} />{keys.isPending ? <Loading /> : keys.data && <>{keys.data.items.length === 0 ? <p className={styles.hint}>尚未发放访问凭证。</p> : <ul className={styles.keyList}>{keys.data.items.map((key) => <li key={key.id}><div><strong>{key.label}</strong><small className={styles.mono}>{key.id}</small><small>到期 {dateTime(key.expires_at)}</small></div>{key.revoked_at ? <Badge status="revoked" /> : new Date(key.expires_at).getTime() <= Date.now() ? <Badge status="expired" /> : <button className={styles.dangerText} disabled={revoke.pending} onClick={() => void revoke.run(`/agents/${id}/keys/${key.id}/revoke`, 'POST', {}, async () => { setSecret(null); await client.invalidateQueries({ queryKey: ['keys', id] }); })}>撤销</button>}</li>)}</ul>}<Pagination {...cursor} nextCursor={keys.data.next_cursor} /></>}<CommandNotice command={revoke} />
  </section>;
}

function TransactionsPanel({ id }: { id: string }) {
  const cursor = useCursor();
  const transactions = useQuery({ queryKey: ['transactions', id, cursor.cursor], queryFn: () => api<ListResult<Transaction>>(`/agents/${id}/transactions${queryString({ cursor: cursor.cursor })}`) });
  return <section className={styles.card}><div className={styles.sectionHeading}><div><h2>钱包流水</h2><p>每一次变动，均可追溯到原始业务。</p></div><button className={styles.textButton} onClick={() => void transactions.refetch()}>刷新流水</button></div><ErrorNotice error={transactions.error} />{transactions.isPending ? <Loading /> : transactions.data && <>{transactions.data.items.length === 0 ? <Empty>暂无积分流水。账户从零余额开始。</Empty> : <div className={styles.tableScroll}><table><thead><tr><th>时间</th><th>业务</th><th>说明</th><th>变动积分</th></tr></thead><tbody>{transactions.data.items.map((transaction, index) => <tr key={`${transaction.id}-${index}`}><td>{dateTime(transaction.created_at)}</td><td><strong>{transaction.kind}</strong><small className={styles.mono}>{transaction.business_key}</small></td><td>{transaction.reason}</td><td className={styles.numeric}>{transaction.entries?.length ? transaction.entries.map((entry) => <small key={entry.bucket}>{entry.bucket === 'AVAILABLE' ? '可用' : '冻结'} {entry.side === 'credit' ? '−' : '+'}{points(entry.amount)}</small>) : transaction.amount ? `${transaction.side === 'credit' ? '−' : transaction.side === 'mixed' ? '' : '+'}${points(transaction.amount)}` : '—'}</td></tr>)}</tbody></table></div>}<Pagination {...cursor} nextCursor={transactions.data.next_cursor} /></>}</section>;
}
