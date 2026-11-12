import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, dateTime, points, queryString, useCommand } from './api';
import { CommandNotice, Empty, ErrorNotice, Loading, Pagination, PointField, useCursor } from './components';
import type { Agent, ListResult, Transaction, User, UserWallet, Wallet } from './types';
import styles from './style.module.css';
import walletStyles from './wallet.module.css';

type WalletOwner = { type: 'user' | 'agent'; id: string };
type Recipient = WalletOwner & { name: string; github_login: string };
type Transfer = { transfer_id: string; from: WalletOwner; to: WalletOwner; amount: string; reason: string };
const ownerKey = (owner: WalletOwner) => `${owner.type}:${owner.id}`;
const ownerLabel = (owner: Recipient) => `${owner.type === 'user' ? '用户' : 'Agent'} · ${owner.name} · @${owner.github_login}`;

async function ownAgents() {
  const agents: Agent[] = [];
  let cursor: string | undefined;
  do {
    const page = await api<ListResult<Agent>>(`/agents${queryString({ cursor, limit: '100' })}`);
    agents.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return agents;
}

export function WalletPage({ user }: { user: User }) {
  const client = useQueryClient();
  const wallet = useQuery({ queryKey: ['user-wallet'], queryFn: () => api<UserWallet>('/wallet') });
  const agents = useQuery({ queryKey: ['agents', 'wallet-sources'], queryFn: ownAgents });
  const self: Recipient = { type: 'user', id: user.id, name: user.display_name || user.github_login, github_login: user.github_login };
  const ownWallets: Recipient[] = [self, ...(agents.data ?? []).map(agent => ({ type: 'agent' as const, id: agent.id, name: agent.name, github_login: user.github_login }))];
  return <>
    <div className={styles.pageHeading}><div><div className={styles.eyebrow}>YOUR WALLET</div><h1>我的钱包</h1><p>在用户与 Agent 之间转移积分。</p></div><button className={styles.secondary} onClick={() => void Promise.all([client.invalidateQueries({ queryKey: ['user-wallet'] }), client.invalidateQueries({ queryKey: ['user-transactions'] }), client.invalidateQueries({ queryKey: ['wallet'] })])}>刷新钱包</button></div>
    <ErrorNotice error={wallet.error} />
    {wallet.isPending ? <Loading /> : wallet.data && <section className={`${styles.balanceCard} ${styles.available} ${walletStyles.balance}`} aria-label="个人钱包"><span>我的可用积分</span><strong data-testid="user-available-balance">{points(wallet.data.available)}</strong><small>冻结积分 <span data-testid="user-reserved-balance">{points(wallet.data.reserved ?? '0')}</span> · 为进行中的对局保留</small><small>完成任务或有效贡献可获得积分，注册不自动赠币。</small>{wallet.data.initial_grant !== '0' && <small>历史初始资金 {points(wallet.data.initial_grant)} 积分已保留。</small>}<small>收款账号 @{user.github_login} · <span className={styles.mono}>{user.id}</span></small></section>}
    <TransferForm user={user} ownWallets={ownWallets} available={wallet.data?.available} agentsError={agents.error} />
    <UserTransactions />
  </>;
}

function TransferForm({ user, ownWallets, available, agentsError }: { user: User; ownWallets: Recipient[]; available?: string; agentsError: Error | null }) {
  const [params] = useSearchParams();
  const [source, setSource] = useState(params.get('from') ?? `user:${user.id}`);
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [search, setSearch] = useState(''), [query, setQuery] = useState('');
  const [amount, setAmount] = useState(''), [reason, setReason] = useState('');
  const [completed, setCompleted] = useState('');
  const pendingTransfer = useRef<Transfer | null>(null);
  const command = useCommand(), client = useQueryClient();
  const uncertain = command.error instanceof ApiError && command.error.uncertain;
  const locked = command.pending || uncertain;
  const from = ownWallets.find(owner => ownerKey(owner) === source);
  const sourceWallet = useQuery({ queryKey: ['wallet', from?.id], queryFn: () => api<Wallet>(`/agents/${from!.id}/wallet`), enabled: from?.type === 'agent' });
  const sourceBalance = from?.type === 'agent' ? sourceWallet.data?.available : available;
  const results = useQuery({ queryKey: ['wallet-recipients', query], queryFn: () => api<{ items: Recipient[] }>(`/wallet/recipients${queryString({ q: query, limit: '20' })}`), enabled: Boolean(query) });
  const recipients = [...new Map([...ownWallets, ...(results.data?.items ?? []), ...(recipient ? [recipient] : [])].map(owner => [ownerKey(owner), owner])).values()];
  const validAmount = /^[1-9][0-9]*$/.test(amount) && BigInt(amount) <= 9_223_372_036_854_775_807n;
  const insufficient = validAmount && sourceBalance !== undefined && BigInt(amount) > BigInt(sourceBalance);
  const sameWallet = Boolean(from && recipient && ownerKey(from) === ownerKey(recipient));
  const canSubmit = Boolean(from && recipient && validAmount && !insufficient && !sameWallet);

  async function submit() {
    if (!uncertain) {
      if (!from || !recipient || !canSubmit) return;
      pendingTransfer.current = { transfer_id: crypto.randomUUID(), from: { type: from.type, id: from.id }, to: { type: recipient.type, id: recipient.id }, amount, reason: reason.trim() };
    }
    const payload = pendingTransfer.current;
    if (!payload) return;
    await command.run('/wallet/transfers', 'POST', payload, async () => {
      setCompleted(`已向 ${recipient ? ownerLabel(recipient) : '收款钱包'} 转账 ${points(payload.amount)} 积分。`);
      setAmount(''); setReason(''); setRecipient(null); pendingTransfer.current = null;
      await Promise.all([
        client.invalidateQueries({ queryKey: ['user-wallet'] }), client.invalidateQueries({ queryKey: ['user-transactions'] }),
        client.invalidateQueries({ queryKey: ['wallet'] }), client.invalidateQueries({ queryKey: ['transactions'] }),
      ]);
    });
  }

  return <section className={styles.card} aria-label="积分转账"><div className={styles.sectionHeading}><div><h2>转账</h2><p>从自己的钱包或自己的 Agent 转出，收款方可以是用户或 Agent。</p></div></div>
    <ErrorNotice error={agentsError} />
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset className={walletStyles.fields} disabled={locked}>
        <label className={styles.field}>转出钱包<select value={source} onChange={event => { setSource(event.target.value); setCompleted(''); }}>{ownWallets.map(owner => <option key={ownerKey(owner)} value={ownerKey(owner)}>{owner.type === 'user' ? '我的钱包' : `Agent · ${owner.name}`}</option>)}</select></label>
        {sourceBalance !== undefined && <p className={styles.hint}>转出钱包可用 {points(sourceBalance)} 积分</p>}
        {from?.type === 'agent' && <ErrorNotice error={sourceWallet.error} />}
        <div className={styles.inlineForm}><label className={styles.field}>搜索收款方<input value={search} maxLength={80} onChange={event => setSearch(event.target.value)} placeholder="GitHub 账号、用户或 Agent 名称、编号" /></label><button type="button" className={styles.secondary} disabled={!search.trim() || results.isFetching} onClick={() => { setQuery(search.trim()); if (query === search.trim()) void results.refetch(); }}>搜索</button></div>
        <ErrorNotice error={results.error} />
        {query && results.isFetching && <p className={styles.hint} role="status">正在查找收款方…</p>}
        {query && results.data?.items.length === 0 && <p className={styles.hint}>没有找到匹配的收款方，请检查账号或编号。</p>}
        <label className={styles.field}>收款钱包<select value={recipient ? ownerKey(recipient) : ''} required onChange={event => { setRecipient(recipients.find(owner => ownerKey(owner) === event.target.value) ?? null); setCompleted(''); }}><option value="">请选择收款方</option>{recipients.map(owner => <option key={ownerKey(owner)} value={ownerKey(owner)}>{ownerLabel(owner)}</option>)}</select></label>
        {recipient && <p className={styles.hint}>收款编号：<span className={styles.mono}>{recipient.id}</span></p>}
        <div className={styles.formGrid}><PointField name="transfer_amount" label="转账金额" value={amount} onChange={value => { setAmount(value); setCompleted(''); }} positive /><label className={styles.field}>备注（选填）<input value={reason} maxLength={200} onChange={event => setReason(event.target.value)} placeholder="例如：给研究助手补充积分" /></label></div>
      </fieldset>
      {sameWallet && <p className={styles.hint}>请选择不同的转出与收款钱包。</p>}
      {insufficient && !uncertain && <p className={styles.hint}>转出钱包余额不足。</p>}
      {from && recipient && validAmount && !sameWallet && <p className={walletStyles.summary}>{ownerLabel(from)} <span aria-hidden>→</span> {ownerLabel(recipient)}<strong>{points(amount)} 积分</strong></p>}
      {uncertain && <p className={styles.hint}>请重试确认这笔转账，当前收款方和金额已保留。</p>}
      <div className={styles.formFooter}><small>转账即时到账，并记录双方流水。</small><button disabled={command.pending || (!uncertain && !canSubmit)}>{command.pending ? '正在转账…' : uncertain ? '重试确认转账' : '确认转账'}</button></div>
      {completed && <p role="status" className={styles.success}>{completed}</p>}
      <CommandNotice command={command} />
    </form>
  </section>;
}

function UserTransactions() {
  const cursor = useCursor();
  const transactions = useQuery({ queryKey: ['user-transactions', cursor.cursor], queryFn: () => api<ListResult<Transaction>>(`/wallet/transactions${queryString({ cursor: cursor.cursor })}`) });
  const names: Record<string, string> = { INITIAL_GRANT: '初始资金', ADMIN_ADJUST: '管理员积分调整', TRANSFER: '转账', RESERVE: '冻结资金', ADJUST_HOLD: '调整冻结', FINALIZE_HOLD: '结算与退款' };
  return <section className={styles.card} aria-label="个人钱包流水"><div className={styles.sectionHeading}><div><h2>钱包流水</h2><p>初始资金、转入和转出均可在这里查询。</p></div></div><ErrorNotice error={transactions.error} />{transactions.isPending ? <Loading /> : transactions.data && <>{transactions.data.items.length === 0 ? <Empty>暂无积分流水。</Empty> : <div className={styles.tableScroll}><table className={walletStyles.transactions}><thead><tr><th>时间</th><th>业务</th><th>说明</th><th>变动积分</th></tr></thead><tbody>{transactions.data.items.map(transaction => <tr key={transaction.id}><td>{dateTime(transaction.created_at)}</td><td><strong>{names[transaction.kind] ?? transaction.kind}</strong><small className={styles.mono}>{transaction.business_key}</small></td><td>{transaction.reason}</td><td className={styles.numeric}>{transaction.entries?.length ? transaction.entries.map(entry => <small key={entry.bucket}>{entry.bucket === 'USER_RESERVED' ? '冻结 ' : '可用 '}{entry.side === 'credit' ? '−' : '+'}{points(entry.amount)}</small>) : transaction.amount ? `${transaction.side === 'credit' ? '−' : '+'}${points(transaction.amount)}` : '—'}</td></tr>)}</tbody></table></div>}<Pagination {...cursor} nextCursor={transactions.data.next_cursor} /></>}</section>;
}
