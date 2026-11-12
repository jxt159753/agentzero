import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AdminAssetTransferInput, AdminUserWalletsDto } from '@agentzero/contracts';
import { api, ApiError, queryString, useCommand } from './api';
import { CommandNotice, ErrorNotice, Loading } from './components';
import type { ListResult, Me, User } from './types';
import styles from './style.module.css';
import marketStyles from './market.module.css';

type Props = { kind: 'lands' | 'items'; id: string; version: string; ownerAgentId: string | null; ownerName: string; refresh: () => Promise<void>; setLocked: (id: string, locked: boolean) => void };

export function AdminAssetTransfer({ kind, id, version, ownerAgentId, ownerName, refresh, setLocked }: Props) {
  const [expanded, setExpanded] = useState(false), [mode, setMode] = useState<AdminAssetTransferInput['mode']>('transfer');
  const [search, setSearch] = useState(''), [query, setQuery] = useState<string | null>(null), [userId, setUserId] = useState('');
  const [targetId, setTargetId] = useState(''), [reason, setReason] = useState('');
  const [ownershipConfirmed, setOwnershipConfirmed] = useState(''), [cleanupConfirmed, setCleanupConfirmed] = useState('');
  const [sent, setSent] = useState<{ body: AdminAssetTransferInput; ownerName: string; targetName: string } | null>(null);
  const command = useCommand(), uncertain = command.error instanceof ApiError && command.error.uncertain;
  useEffect(() => { setLocked(id, command.pending || uncertain); }, [id, command.pending, uncertain, setLocked]);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me'), enabled: expanded && mode === 'recover' });
  const users = useQuery({ queryKey: ['admin-asset-transfer-users', query],
    queryFn: () => api<ListResult<User>>(`/admin/users${queryString({ status: 'active', q: query ?? '' })}`), enabled: expanded && mode === 'transfer' && query !== null });
  const targetUserId = mode === 'recover' ? me.data?.user.id : userId;
  const wallets = useQuery({ queryKey: ['admin-user-wallets', targetUserId],
    queryFn: () => api<AdminUserWalletsDto>(`/admin/users/${targetUserId}/wallets`), enabled: expanded && Boolean(targetUserId) });
  const agents = wallets.data?.wallets.filter(wallet => wallet.type === 'agent' && wallet.status === 'active' && !wallet.deleted_at && wallet.id !== ownerAgentId) ?? [];
  const target = agents.find(agent => agent.id === targetId);
  const quote = uncertain && sent ? sent.body : { version, expected_owner_agent_id: ownerAgentId, mode, target_agent_id: targetId };
  const confirmation = JSON.stringify([id, quote.version, quote.expected_owner_agent_id, quote.mode, quote.target_agent_id]);
  const valid = Boolean(target && reason.trim() && ownershipConfirmed === confirmation && (kind !== 'lands' || cleanupConfirmed === confirmation) && (mode !== 'recover' || ownerAgentId));
  const resetConfirmation = () => { setOwnershipConfirmed(''); setCleanupConfirmed(''); };
  const conflict = command.error instanceof ApiError && (command.error.code.endsWith('VERSION_CONFLICT') || command.error.code === 'ASSET_OWNER_CONFLICT');
  const quotedOwner = uncertain && sent ? sent.body.expected_owner_agent_id : ownerAgentId;
  return <details onToggle={event => setExpanded(event.currentTarget.open)} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <summary>改归属或回收资产</summary>
    <section aria-label="资产产权管理">
      <p>原主：{uncertain && sent ? sent.ownerName : ownerName} · Agent ID：{quotedOwner ?? '无（系统未售）'}</p>
      <p className={styles.hint}>{kind === 'lands'
        ? '土地变更归属会撤销挂牌、将付费装饰退回原主库存、清除免费模型和展示内容，并将室内访客迁到室外。'
        : '物品变更归属会撤销相关挂牌、从原地块取下，再放入目标 Agent 库存。'}交易冻结与展示屏蔽状态保留，不自动补偿或划转积分。回收会转入当前管理员指定的托管 Agent，资产不会销毁。</p>
      <form onSubmit={event => {
        event.preventDefault();
        if (!uncertain && !valid) return;
        const request = uncertain && sent ? sent : { body: { mode, version, expected_owner_agent_id: ownerAgentId, target_agent_id: targetId, reason: reason.trim() }, ownerName, targetName: target!.name };
        setSent(request); setLocked(id, true);
        void command.run(`/admin/assets/${kind}/${id}/transfer`, 'POST', request.body, async () => {
          setSent(null); setReason(''); resetConfirmation(); await refresh();
        });
      }}>
        <fieldset disabled={command.pending || uncertain} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <label className={styles.field}>产权处理方式<select value={mode} onChange={event => { setMode(event.target.value as typeof mode); setTargetId(''); resetConfirmation(); }}><option value="transfer">改为指定 Agent 所有</option><option value="recover" disabled={!ownerAgentId}>回收到我的托管 Agent</option></select></label>
          {mode === 'transfer' ? <>
            <label className={styles.field}>查找目标用户<input value={search} maxLength={100} onChange={event => setSearch(event.target.value)} placeholder="GitHub 用户名、显示名或用户 ID" /></label>
            <button type="button" className={styles.secondary} disabled={!search.trim() || users.isFetching} onClick={() => { setQuery(search.trim()); setUserId(''); setTargetId(''); resetConfirmation(); }}>搜索目标用户</button>
            <ErrorNotice error={users.error} />{users.isFetching && <Loading />}
            {users.data && <label className={styles.field}>目标用户<select value={userId} onChange={event => { setUserId(event.target.value); setTargetId(''); resetConfirmation(); }}><option value="">选择已启用的用户</option>{users.data.items.filter(user => user.status === 'active').map(user => <option key={user.id} value={user.id}>{user.display_name} · @{user.github_login}</option>)}</select></label>}
            {users.data?.items.length === 0 && <p>未找到符合条件的用户，请调整搜索词。</p>}
            {users.data?.next_cursor && <p>仅显示首批匹配用户，请使用更完整的用户名或用户 ID 缩小范围。</p>}
          </> : <><p>托管用户：{me.data?.user.display_name ?? '正在读取'} · @{me.data?.user.github_login}</p><ErrorNotice error={me.error} /></>}
          {targetUserId && <><ErrorNotice error={wallets.error} />{wallets.isPending ? <Loading /> : <>
            <label className={styles.field}>{mode === 'recover' ? '托管 Agent' : '目标 Agent'}<select value={targetId} onChange={event => { setTargetId(event.target.value); resetConfirmation(); }}><option value="">选择活跃 Agent</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.id}</option>)}</select></label>
            {!agents.length && <p>该用户没有可接收此资产的活跃 Agent。</p>}
          </>}</>}
          {(target || uncertain && sent) && <p>接收 Agent：{uncertain && sent ? sent.targetName : target?.name} · {uncertain && sent ? sent.body.target_agent_id : targetId}</p>}
          <label className={styles.field}>产权处理理由<textarea rows={3} required maxLength={500} value={reason} onChange={event => { setReason(event.target.value); resetConfirmation(); }} /></label>
          <label className={marketStyles.checkbox}><input type="checkbox" checked={ownershipConfirmed === confirmation} onChange={event => setOwnershipConfirmed(event.target.checked ? confirmation : '')} />已核对原主与接收 Agent，确认变更这项资产的所有权。</label>
          {kind === 'lands' && <label className={marketStyles.checkbox}><input type="checkbox" checked={cleanupConfirmed === confirmation} onChange={event => setCleanupConfirmed(event.target.checked ? confirmation : '')} />确认撤销土地挂牌、退回付费装饰、清除免费模型与展示，并迁出室内访客。</label>}
        </fieldset>
        <div className={styles.formFooter}><span>资产版本 {uncertain && sent ? sent.body.version : version}</span><button disabled={command.pending || (!uncertain && !valid)}>{command.pending ? '正在变更产权…' : uncertain ? '按原产权请求重试' : mode === 'recover' ? '确认回收到托管 Agent' : '确认变更资产归属'}</button></div>
        <CommandNotice command={command} />
        {conflict && <button type="button" className={styles.secondary} onClick={() => { resetConfirmation(); void refresh(); }}>刷新原主与版本后重新确认</button>}
      </form>
    </section>
  </details>;
}
