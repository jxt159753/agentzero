import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dateTime, useCommand } from './api';
import { CommandNotice, Empty, ErrorNotice, Loading } from './components';
import { AdminRepositoryRequestsPanel } from './repository-requests';
import type { GithubInstallation, Repository } from './types';
import styles from './style.module.css';
import taskStyles from './tasks.module.css';

export function RepositoriesPanel() {
  const repositories = useQuery({ queryKey: ['repositories'], queryFn: () => api<{ items: Repository[] }>('/repositories') });
  const installations = useQuery({ queryKey: ['github-installations'], queryFn: () => api<{ items: GithubInstallation[] }>('/admin/github/installations') });
  const [installationId, setInstallationId] = useState('');
  const [repositoryInstallation, setRepositoryInstallation] = useState('');
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const installationCommand = useCommand();
  const repositoryCommand = useCommand();
  const client = useQueryClient();
  return <>
    <AdminRepositoryRequestsPanel installations={installations.data?.items ?? []} />
    <section className={styles.card}>
      <div className={styles.sectionHeading}><div><h2>GitHub App 安装</h2><p>核验已安装的 GitHub App，建立仓库访问授权。</p></div></div>
      <form className={styles.inlineForm} onSubmit={(event) => { event.preventDefault(); void installationCommand.run('/admin/github/installations', 'POST', { installation_id: installationId }, async () => { await client.invalidateQueries({ queryKey: ['github-installations'] }); setRepositoryInstallation(installationId); setInstallationId(''); }); }}>
        <label className={styles.field}>安装 ID<input inputMode="numeric" pattern="[1-9][0-9]*" required maxLength={20} value={installationId} onChange={(event) => setInstallationId(event.target.value)} placeholder="GitHub App 安装页面中的数字 ID" /></label>
        <button disabled={installationCommand.pending || !installationId}>{installationCommand.pending ? '正在核验…' : '核验并保存安装'}</button>
      </form>
      <CommandNotice command={installationCommand} /><ErrorNotice error={installations.error} />
      {installations.isPending ? <Loading /> : installations.data && (installations.data.items.length ? <div className={styles.tableScroll}><table><thead><tr><th>所属账号</th><th>安装 ID</th><th>状态</th><th>最近更新</th></tr></thead><tbody>{installations.data.items.map((installation) => <tr key={installation.installation_id}><td>{installation.account_login}</td><td className={styles.mono}>{installation.installation_id}</td><td>{({ active: '可访问', suspended: '已暂停', deleted: '已撤销' })[installation.status]}</td><td>{dateTime(installation.updated_at)}</td></tr>)}</tbody></table></div> : <Empty>尚未保存 GitHub App 安装。完成仓库安装后，在这里核验。</Empty>)}
    </section>
    <section className={styles.card}>
      <div className={styles.sectionHeading}><div><h2>仓库准入</h2><p>准入后可关联任务，并自动补算历史贡献奖励。停用仓库后暂停贡献发奖、新的交付核验与验收。</p></div></div>
      <form onSubmit={(event) => { event.preventDefault(); void repositoryCommand.run('/admin/repositories', 'POST', { installation_id: repositoryInstallation, owner: owner.trim(), name: name.trim() }, async () => { await client.invalidateQueries({ queryKey: ['repositories'] }); setOwner(''); setName(''); }); }}>
        <div className={taskStyles.threeFields}>
          <label className={styles.field}>使用的安装<select required value={repositoryInstallation} onChange={(event) => setRepositoryInstallation(event.target.value)}><option value="">选择可访问的安装</option>{installations.data?.items.filter((installation) => installation.status === 'active').map((installation) => <option value={installation.installation_id} key={installation.installation_id}>{installation.account_login} · {installation.installation_id}</option>)}</select></label>
          <label className={styles.field}>仓库所有者<input required maxLength={100} value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="组织或用户名" /></label>
          <label className={styles.field}>仓库名称<input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="repository-name" /></label>
        </div>
        <div className={styles.formFooter}><small>由 GitHub 核验仓库身份和安装权限。</small><button disabled={repositoryCommand.pending || !repositoryInstallation || !owner.trim() || !name.trim()}>{repositoryCommand.pending ? '正在核验…' : '批准仓库准入'}</button></div>
      </form>
      <CommandNotice command={repositoryCommand} /><ErrorNotice error={repositories.error} />
      {repositories.isPending ? <Loading /> : repositories.data && (repositories.data.items.length ? <div className={taskStyles.repositoryList}>{repositories.data.items.map((repository) => <RepositoryRow key={`${repository.id}-${repository.status}`} repository={repository} />)}</div> : <Empty>尚无获准仓库。先添加 GitHub App 安装，再批准仓库。</Empty>)}
    </section>
  </>;
}

function RepositoryRow({ repository }: { repository: Repository }) {
  const command = useCommand();
  const client = useQueryClient();
  return <article className={taskStyles.repositoryRow}>
    <div className={taskStyles.repositoryIdentity}><div><strong>{repository.full_name}</strong><small>GitHub ID {repository.github_id} · 安装 {repository.installation_id}</small></div><span className={`${styles.badge} ${repository.status === 'approved' ? styles.active : styles.mutedBadge}`}>{repository.status === 'approved' ? '已准入' : '已停用'}</span><button className={styles.secondary} disabled={command.pending} onClick={() => void command.run(`/admin/repositories/${repository.id}`, 'PATCH', { status: repository.status === 'approved' ? 'disabled' : 'approved' }, () => client.invalidateQueries({ queryKey: ['repositories'] }))}>{repository.status === 'approved' ? '停用仓库' : '恢复准入'}</button></div>
    <CommandNotice command={command} />
  </article>;
}
