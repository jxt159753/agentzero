import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { api, dateTime, queryString, useCommand } from './api';
import { CommandNotice, ErrorNotice, Loading } from './components';
import type { Agent, ListResult, User } from './types';
import styles from './style.module.css';

const storageKey = 'agentzero.registration-return';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codePattern = /^[A-Za-z0-9_-]{43}$/;
type RegistrationLink = { id: string; code: string };
interface Registration {
  id: string;
  client: 'codex' | 'dsh';
  name: string;
  expires_at: string;
  status: 'pending' | 'approved';
  agent_id?: string;
}

function parseLink(search: string, hash: string): RegistrationLink | null {
  const id = new URLSearchParams(search).get('request') ?? '';
  const code = new URLSearchParams(hash.slice(1)).get('code') ?? '';
  return idPattern.test(id) && codePattern.test(code) ? { id, code } : null;
}

/** Keep only this short-lived approval link across the existing GitHub login redirect. */
export function useRegistrationReturn(): string | null {
  const location = useLocation();
  useEffect(() => {
    if (location.pathname !== '/connect') return;
    const link = parseLink(location.search, location.hash);
    if (link) sessionStorage.setItem(storageKey, JSON.stringify({ ...link, expires: Date.now() + 600_000 }));
    else sessionStorage.removeItem(storageKey);
  }, [location.pathname, location.search, location.hash]);
  if (location.pathname !== '/') return null;
  const saved = sessionStorage.getItem(storageKey);
  if (!saved) return null;
  try {
    const link = JSON.parse(saved) as Partial<RegistrationLink> & { expires?: number };
    if (typeof link.id === 'string' && typeof link.code === 'string' && typeof link.expires === 'number'
      && link.expires > Date.now() && idPattern.test(link.id) && codePattern.test(link.code)) {
      return `/connect?request=${link.id}#code=${link.code}`;
    }
  } catch { /* A stale or invalid browser value cannot select a return destination. */ }
  return null;
}

export function RegistrationPage({ user }: { user: User }) {
  const location = useLocation();
  const link = parseLink(location.search, location.hash);
  const request = useQuery({
    queryKey: ['agent-registration', link?.id, link?.code],
    queryFn: () => api<Registration>(`/agent-registrations/${link!.id}?code=${link!.code}`),
    enabled: Boolean(link), retry: false,
  });
  if (!link) return <section className={styles.stateCard}><h1>注册链接不完整</h1><p>请回到 Codex 或 DSH，重新发起“注册为 Agent”，再打开它提供的完整链接。</p><Link to="/agents">返回我的 Agent</Link></section>;
  if (request.isPending) return <Loading />;
  if (request.error) return <section className={styles.stateCard}><h1>暂时无法确认注册</h1><ErrorNotice error={request.error} /><p>链接过期或无效时，请回到客户端重新发起注册。</p><button className={styles.secondary} onClick={() => void request.refetch()}>重新读取</button><p><Link to="/agents">返回我的 Agent</Link></p></section>;
  return <RegistrationForm key={request.data.id} registration={request.data} code={link.code} user={user} />;
}

function RegistrationForm({ registration, code, user }: { registration: Registration; code: string; user: User }) {
  const [name, setName] = useState(registration.name);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [agentId, setAgentId] = useState('');
  const [approvedAgentId, setApprovedAgentId] = useState(registration.status === 'approved' ? registration.agent_id : undefined);
  const command = useCommand();
  const client = useQueryClient();
  const agents = useInfiniteQuery({
    queryKey: ['registration-agents'], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<ListResult<Agent>>(`/agents${queryString({ cursor: pageParam, limit: '100' })}`),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: mode === 'existing' && !approvedAgentId,
  });
  const clientName = registration.client === 'codex' ? 'Codex' : 'DSH';
  useEffect(() => {
    if (approvedAgentId) sessionStorage.removeItem(storageKey);
  }, [approvedAgentId]);
  if (approvedAgentId) return <section className={styles.stateCard}><div className={styles.eyebrow}>AGENT CONNECTED</div><h1>已确认注册</h1><p>{clientName} 已获准连接你的 Agent。请回到客户端说“继续完成 Agent 注册”，由插件自动保存连接。</p><p>无需复制或发送访问凭证。</p><Link className={styles.primaryLink} to={`/agents/${approvedAgentId}`}>查看 Agent 与权限</Link></section>;
  const expired = new Date(registration.expires_at).getTime() <= Date.now();
  return <>
    <div className={styles.pageHeading}><div><div className={styles.eyebrow}>CONNECT YOUR CLIENT</div><h1>将 {clientName} 注册为 Agent</h1><p>确认一次，客户端即可自动保存连接。</p></div></div>
    <section className={styles.card}>
      <h2>确认属于你的客户端</h2>
      <p>当前账号：<strong>@{user.github_login}</strong>。请确认这次请求来自你正在使用的 {clientName}。</p>
      <p className={styles.hint}>链接有效至 {dateTime(registration.expires_at)}（北京时间）。</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        void command.run<Registration>(`/agent-registrations/${registration.id}/approve`, 'POST', {
          verification_code: code, ...(mode === 'new' ? { name: name.trim() } : { agent_id: agentId }),
        }, async (result) => {
          setApprovedAgentId(result.agent_id);
          await client.invalidateQueries({ queryKey: ['agents'] });
          await client.invalidateQueries({ queryKey: ['agent-registration', registration.id] });
        });
      }}>
        <label className={styles.field}>注册方式<select value={mode} onChange={(event) => setMode(event.target.value as 'new' | 'existing')}><option value="new">创建新 Agent</option><option value="existing">连接已有 Agent</option></select></label>
        {mode === 'new' ? <><label className={styles.field}>Agent 名称<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label><p className={styles.hint}>新 Agent 的余额为 0，任务、协作、交易和兑换权限默认关闭。注册后可在 Agent 页面授权。</p></> : <>
          <ErrorNotice error={agents.error} />
          {agents.isPending ? <Loading /> : <label className={styles.field}>选择你的 Agent<select required value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">请选择</option>{agents.data?.pages.flatMap((page) => page.items).filter((agent) => agent.status === 'active').map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.id.slice(0, 8)}</option>)}</select></label>}
          {agents.hasNextPage && <button type="button" className={styles.secondary} disabled={agents.isFetchingNextPage} onClick={() => void agents.fetchNextPage()}>加载更多 Agent</button>}
          <p className={styles.hint}>客户端将使用所选 Agent 已有的身份、钱包与权限。暂停的 Agent 需先恢复。</p>
        </>}
        {expired && <p role="alert" className={styles.error}>注册链接已过期，请回到客户端重新发起注册。</p>}
        <div className={styles.formFooter}><Link to="/agents" onClick={() => sessionStorage.removeItem(storageKey)}>暂不连接</Link><button disabled={command.pending || expired || (mode === 'new' ? !name.trim() : !agentId)}>{command.pending ? '正在确认…' : '确认注册并连接'}</button></div>
        <CommandNotice command={command} />
      </form>
    </section>
  </>;
}

export function QuickRegistration() {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const prompt = `把你注册为我的 Agent，平台地址是 ${window.location.origin}`;
  return <section className={styles.card}><div className={styles.sectionHeading}><div><h2>直接接入 Codex / DSH</h2><p>安装 AgentZero 插件后，对客户端说下面这句话，再打开它提供的链接确认即可。</p></div></div><label className={styles.field}>发送给客户端<textarea readOnly rows={2} value={prompt} onFocus={(event) => event.target.select()} /></label><button className={styles.secondary} onClick={() => {
    if (!navigator.clipboard) { setCopyError(true); return; }
    void navigator.clipboard.writeText(prompt).then(() => { setCopied(true); setCopyError(false); }, () => setCopyError(true));
  }}>{copied ? '已复制' : '复制注册指令'}</button>{copyError && <p role="status" className={styles.hint}>请选中上方文字，手动复制到客户端。</p>}<p className={styles.hint}>注册会自动创建身份并保存连接，无需手动生成或复制凭证；也可以连接已有 Agent。</p></section>;
}
