import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RepositoryRequestDto } from '@agentzero/contracts';
import { api, ApiError, dateTime, queryString, useCommand } from './api';
import { CommandNotice, Empty, ErrorNotice, Loading, Pagination, useCursor } from './components';
import type { GithubInstallation, ListResult } from './types';
import styles from './style.module.css';
import taskStyles from './tasks.module.css';

const statuses = { pending: '待审核', approved: '已准入', rejected: '已拒绝' };
const installationUrl = 'https://github.com/apps/agentzero-jxt159753/installations/new';

function useRefreshRequests() {
  const client = useQueryClient();
  return async () => { await Promise.all(['repository-requests', 'admin-repository-requests', 'repositories'].map(key => client.invalidateQueries({ queryKey: [key] }))); };
}

export function RepositoryRequestsPanel() {
  const cursor = useCursor();
  const requests = useQuery({ queryKey: ['repository-requests', cursor.cursor], queryFn: () => api<ListResult<RepositoryRequestDto>>(`/repository-requests${queryString({ cursor: cursor.cursor })}`) });
  const [url, setUrl] = useState(''), [reason, setReason] = useState('');
  const command = useCommand(), refresh = useRefreshRequests();
  const uncertain = command.error instanceof ApiError && command.error.uncertain;
  return <section className={styles.card} aria-label="自己的仓库申请"><div className={styles.sectionHeading}><div><h2>接入自己的仓库</h2><p>先安装平台 GitHub App，再提交公开仓库，等待管理员审核。</p></div><a href={installationUrl} target="_blank" rel="noreferrer">安装 GitHub App ↗</a></div>
    <form onSubmit={event => { event.preventDefault(); void command.run('/repository-requests', 'POST', { repository_url: url.trim(), reason: reason.trim() }, async () => { setUrl(''); setReason(''); cursor.reset(); await refresh(); }); }}>
      <label className={styles.field}>仓库链接<input type="url" required maxLength={2000} value={url} onChange={event => setUrl(event.target.value)} disabled={command.pending || uncertain} placeholder="https://github.com/owner/repository" /></label>
      <label className={styles.field}>申请说明<textarea required maxLength={500} rows={2} value={reason} onChange={event => setReason(event.target.value)} disabled={command.pending || uncertain} placeholder="介绍仓库用途和希望开展的贡献" /></label>
      <div className={styles.formFooter}><span className={styles.hint}>批准准入后会自动补算历史 Commit、PR 和 Issue，奖励发给各贡献作者的自动收款 Agent。</span><button disabled={command.pending || !url.trim() || !reason.trim()}>{command.pending ? '正在提交…' : '提交仓库申请'}</button></div><CommandNotice command={command} />
    </form>
    <div className={styles.sectionHeading}><h3>我的申请</h3><button className={styles.textButton} onClick={() => void requests.refetch()}>刷新申请</button></div><ErrorNotice error={requests.error} />
    {requests.isPending ? <Loading /> : requests.data && <>{requests.data.items.length ? <div className={taskStyles.repositoryList}>{requests.data.items.map(request => <RequestDetails key={request.id} request={request} />)}</div> : <Empty>还没有仓库准入申请。</Empty>}<Pagination {...cursor} nextCursor={requests.data.next_cursor} /></>}
  </section>;
}

function RequestDetails({ request, showApplicant = false }: { request: RepositoryRequestDto; showApplicant?: boolean }) {
  return <div className={taskStyles.repositoryRow}><div className={taskStyles.repositoryIdentity}><div><strong><a href={request.repository_url} target="_blank" rel="noreferrer">{request.owner}/{request.name}</a></strong><small>{showApplicant && `申请人 @${request.applicant_login} · `}{dateTime(request.created_at)}</small></div><span className={`${styles.badge} ${request.status === 'approved' ? styles.active : styles.mutedBadge}`}>{statuses[request.status]}</span></div><p className={taskStyles.textBlock}>申请说明：{request.reason}</p>{request.review_reason && <p className={taskStyles.textBlock}>{request.status === 'rejected' ? '拒绝理由' : '审核说明'}：{request.review_reason}</p>}</div>;
}

export function AdminRepositoryRequestsPanel({ installations }: { installations: GithubInstallation[] }) {
  const [status, setStatus] = useState('pending');
  const cursor = useCursor();
  const requests = useQuery({ queryKey: ['admin-repository-requests', status, cursor.cursor], queryFn: () => api<ListResult<RepositoryRequestDto>>(`/admin/repository-requests${queryString({ status, cursor: cursor.cursor })}`) });
  return <section className={styles.card} aria-label="仓库申请审核"><div className={styles.sectionHeading}><div><h2>仓库准入申请</h2><p>核对仓库与 App 安装后决定是否准入。批准后会自动补算历史贡献，并按发奖时的奖励配置从平台奖池付款。</p></div><label className={styles.compactField}>申请状态<select value={status} onChange={event => { setStatus(event.target.value); cursor.reset(); }}><option value="pending">待审核</option><option value="approved">已准入</option><option value="rejected">已拒绝</option><option value="">全部申请</option></select></label><button className={styles.textButton} onClick={() => void requests.refetch()}>刷新审核列表</button></div><ErrorNotice error={requests.error} />
    {requests.isPending ? <Loading /> : requests.data && <>{requests.data.items.length ? requests.data.items.map(request => <article key={`${request.id}-${request.version}`} aria-label={`审核 ${request.owner}/${request.name}`}><RequestDetails request={request} showApplicant />{request.status === 'pending' && <ReviewForm request={request} installations={installations} />}</article>) : <Empty>当前没有符合条件的申请。</Empty>}<Pagination {...cursor} nextCursor={requests.data.next_cursor} /></>}
  </section>;
}

function ReviewForm({ request, installations }: { request: RepositoryRequestDto; installations: GithubInstallation[] }) {
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  const [installationId, setInstallationId] = useState(''), [reason, setReason] = useState('');
  const command = useCommand(), refresh = useRefreshRequests();
  const uncertain = command.error instanceof ApiError && command.error.uncertain;
  const active = installations.filter(installation => installation.status === 'active');
  return <form onSubmit={event => { event.preventDefault(); void command.run(`/admin/repository-requests/${request.id}/review`, 'POST', { version: request.version, decision, reason: reason.trim(), ...(decision === 'approve' ? { installation_id: installationId } : {}) }, refresh); }}>
    <div className={styles.formGrid}><label className={styles.field}>审核决定<select value={decision} onChange={event => setDecision(event.target.value as 'approve' | 'reject')} disabled={command.pending || uncertain}><option value="approve">批准准入</option><option value="reject">拒绝申请</option></select></label>
      {decision === 'approve' && <label className={styles.field}>申请使用的安装<select required value={installationId} onChange={event => setInstallationId(event.target.value)} disabled={command.pending || uncertain}><option value="">选择可访问的安装</option>{active.map(installation => <option key={installation.installation_id} value={installation.installation_id}>{installation.account_login} · {installation.installation_id}</option>)}</select></label>}
    </div>
    {decision === 'approve' && !active.length && <p className={styles.hint}>请先在下方核验并保存该仓库的 GitHub App 安装。</p>}
    <label className={styles.field}>{decision === 'reject' ? '拒绝理由' : '审核说明'}<textarea required maxLength={500} rows={2} value={reason} onChange={event => setReason(event.target.value)} disabled={command.pending || uncertain} /></label>
    <button disabled={command.pending || !reason.trim() || (decision === 'approve' && !installationId)}>{command.pending ? '正在审核…' : decision === 'approve' ? '批准此申请' : '拒绝此申请'}</button><CommandNotice command={command} />
  </form>;
}
