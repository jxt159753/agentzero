import { useState, type ReactNode } from 'react';
import { ApiError, useCommand } from './api';
import styles from './style.module.css';

export function ErrorNotice({ error }: { error: Error | null | undefined }) {
  if (!error) return null;
  return <div className={styles.error} role="alert"><strong>{error.message}</strong>{error instanceof ApiError && error.requestId && <small>请求编号：{error.requestId}</small>}{error instanceof ApiError && error.code === 'UNAUTHENTICATED' && <a href="/api/v1/auth/github/start">重新登录</a>}</div>;
}
export function CommandNotice({ command }: { command: ReturnType<typeof useCommand> }) {
  return <><ErrorNotice error={command.error} />{command.error instanceof ApiError && command.error.uncertain && command.requestKey && <p className={styles.hint}>请求键：<code>{command.requestKey}</code>。再次提交相同内容会使用此键。</p>}{command.operationId && <p role="status" className={styles.success}>已保存 · 业务编号 <code>{command.operationId}</code></p>}</>;
}
export function Loading() { return <p className={styles.empty} role="status">正在读取最新数据…</p>; }
export function Empty({ children }: { children: ReactNode }) { return <div className={styles.empty}>{children}</div>; }
export function Badge({ status }: { status: string }) {
  const labels: Record<string, string> = { active: '已启用', paused: '已暂停', deleted: '已删除', pending: '待准入', suspended: '已停用', revoked: '已撤销', expired: '已过期' };
  return <span className={`${styles.badge} ${status === 'active' ? styles.active : styles.mutedBadge}`}>{labels[status] ?? status}</span>;
}
export function PointField({ name, label, value, onChange, positive = false }: { name: string; label: string; value: string; onChange: (value: string) => void; positive?: boolean }) {
  return <label className={styles.field}>{label}<span className={styles.inputUnit}><input name={name} aria-label={label} value={value} onChange={(event) => { const next = event.target.value; if (/^\d*$/.test(next)) onChange(next); }} inputMode="numeric" pattern={positive ? '[1-9][0-9]*' : '(0|[1-9][0-9]*)'} maxLength={19} required title={positive ? '请输入正整数积分' : '请输入非负整数积分'} /><span>积分</span></span></label>;
}
export function Pagination({ nextCursor, onNext, onBack, canBack }: { nextCursor: string | null | undefined; onNext: (cursor: string) => void; onBack: () => void; canBack: boolean }) {
  return <div className={styles.pagination}><button className={styles.secondary} disabled={!canBack} onClick={onBack}>上一页</button><button className={styles.secondary} disabled={!nextCursor} onClick={() => nextCursor && onNext(nextCursor)}>下一页</button></div>;
}
export function useCursor() {
  const [cursors, setCursors] = useState<string[]>([]);
  return { cursor: cursors.at(-1), canBack: cursors.length > 0, onNext: (cursor: string) => setCursors((items) => [...items, cursor]), onBack: () => setCursors((items) => items.slice(0, -1)), reset: () => setCursors([]) };
}
