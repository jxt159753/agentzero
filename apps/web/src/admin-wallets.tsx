import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminUserWalletsDto, AdminWalletAdjustmentInput } from '@agentzero/contracts';
import { api, ApiError, points, useCommand } from './api';
import { Badge, CommandNotice, ErrorNotice, Loading, PointField } from './components';
import styles from './style.module.css';

export function UserWalletAdmin({ userId }: { userId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(`user:${userId}`);
  const [direction, setDirection] = useState<AdminWalletAdjustmentInput['direction']>('add');
  const [amount, setAmount] = useState(''), [reason, setReason] = useState('');
  const [businessId, setBusinessId] = useState(() => crypto.randomUUID());
  const command = useCommand(), client = useQueryClient();
  const wallets = useQuery({ queryKey: ['admin-user-wallets', userId], queryFn: () => api<AdminUserWalletsDto>(`/admin/users/${userId}/wallets`), enabled: expanded });
  const wallet = wallets.data?.wallets.find(value => `${value.type}:${value.id}` === selected);
  const uncertain = command.error instanceof ApiError && command.error.uncertain;
  const validAmount = /^[1-9][0-9]*$/.test(amount) && BigInt(amount) <= 9_223_372_036_854_775_807n;
  const source = direction === 'add' ? wallets.data?.reward_pool_points : wallet?.available;
  const insufficient = validAmount && source !== undefined && BigInt(amount) > BigInt(source);
  const disabled = !wallet || Boolean(wallet.deleted_at) || !validAmount || insufficient || !reason.trim();

  return <details onToggle={(event) => setExpanded(event.currentTarget.open)}><summary>调整积分</summary>
    <section aria-label="管理员积分调整"><p className={styles.hint}>添加积分从平台奖励池划转；移除积分进入系统回收账户。冻结积分保持不变。</p>
      <ErrorNotice error={wallets.error} />{wallets.isPending ? <Loading /> : wallets.data && <>
        <div className={styles.sectionHeading}><p>平台奖励池可用 <strong>{points(wallets.data.reward_pool_points)}</strong> 积分</p><button type="button" className={styles.secondary} onClick={() => void wallets.refetch()}>刷新余额</button></div>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!wallet || (!uncertain && disabled)) return;
          void command.run('/admin/wallet-adjustments', 'POST', {
            wallet: { type: wallet.type, id: wallet.id }, direction, amount, reason: reason.trim(), business_id: businessId,
          } satisfies AdminWalletAdjustmentInput, async () => {
            await Promise.all([
              client.invalidateQueries({ queryKey: ['admin-user-wallets', userId] }), client.invalidateQueries({ queryKey: ['economy'] }),
              client.invalidateQueries({ queryKey: ['user-wallet'] }), client.invalidateQueries({ queryKey: ['user-transactions'] }),
              client.invalidateQueries({ queryKey: ['wallet'] }), client.invalidateQueries({ queryKey: ['transactions'] }),
              client.invalidateQueries({ queryKey: ['admin-records'] }),
            ]);
            setAmount(''); setReason(''); setBusinessId(crypto.randomUUID());
          });
        }}>
          <fieldset disabled={command.pending || uncertain} style={{ border: 0, padding: 0, margin: 0 }}>
            <label className={styles.field}>调整钱包<select value={selected} onChange={(event) => setSelected(event.target.value)}>{wallets.data.wallets.map(value =>
              <option key={`${value.type}:${value.id}`} value={`${value.type}:${value.id}`} disabled={Boolean(value.deleted_at)}>{value.type === 'user' ? '个人钱包' : `Agent · ${value.name}`}{value.deleted_at ? '（已删除）' : ''}</option>)}</select></label>
            {wallet && <p>可用 <strong>{points(wallet.available)}</strong> · 冻结 <strong>{points(wallet.reserved)}</strong> · <Badge status={wallet.deleted_at ? 'deleted' : wallet.status} /></p>}
            <label className={styles.field}>调整方式<select value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)}><option value="add">添加积分（来自奖励池）</option><option value="remove">移除积分（进入回收账户）</option></select></label>
            <PointField name="adjustment_amount" label="调整积分数量" value={amount} onChange={setAmount} positive />
            <label className={styles.field}>调整原因<textarea required maxLength={500} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="记录奖励依据或扣除原因，用户可在流水中查看" /></label>
          </fieldset>
          {insufficient && !uncertain && <p role="alert">{direction === 'add' ? '奖励池可用积分不足，请先配置发行或回流资金。' : '目标钱包可用积分不足，冻结积分不能移除。'}</p>}
          <div className={styles.formFooter}><span style={{ overflowWrap: 'anywhere' }}>业务编号 <code>{businessId}</code></span><button disabled={command.pending || (!uncertain && disabled)}>{command.pending ? '正在调整…' : uncertain ? '按原请求重试' : direction === 'add' ? '确认添加积分' : '确认移除积分'}</button></div>
          <CommandNotice command={command} />
        </form>
      </>}
    </section>
  </details>;
}
