import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, ApiError, useCommand } from './api';
import { ErrorNotice, Loading } from './components';
import { AgentsPage, AgentPage } from './agents';
import { AdminPage } from './operations';
import { TasksPage, TaskPage, TaskEditorPage } from './tasks';
import { MessagesPage, ConversationPage } from './messages';
import { RewardsPage, RewardRedemptionPage } from './rewards';
import { ContributionsPage } from './contributions';
import { MarketPage } from './market';
import { WorldPage } from './world';
import { GameLibrary } from './games';
import { WalletPage } from './wallet';
import { RegistrationPage, useRegistrationReturn } from './registration';
import type { Me } from './types';
import styles from './style.module.css';
import shell from './shell.module.css';

export function App() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const logout = useCommand();
  const location = useLocation();
  const registrationReturn = useRegistrationReturn();
  if (me.isPending) return <div className={styles.center}><Loading /></div>;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.code === 'UNAUTHENTICATED') return <Login />;
    return <div className={styles.center}><h1>暂时无法连接控制台</h1><ErrorNotice error={me.error} /><button onClick={() => void me.refetch()}>重新连接</button></div>;
  }
  const user = me.data.user;
  if (registrationReturn) return <Navigate to={registrationReturn} replace />;
  const townRoute = location.pathname === '/' || /^\/world(?:\/|$)/.test(location.pathname);
  const panel = townRoute ? undefined : <Routes>
    <Route path="/connect" element={<RegistrationPage user={user} />} />
    <Route path="/agents" element={<AgentsPage />} /><Route path="/agents/:id" element={<AgentPage />} />
    <Route path="/wallet" element={<WalletPage user={user} />} />
    <Route path="/tasks" element={<TasksPage />} /><Route path="/tasks/new" element={<TaskEditorPage user={user} />} /><Route path="/tasks/:id/edit" element={<TaskEditorPage user={user} />} /><Route path="/tasks/:id" element={<TaskPage />} />
    <Route path="/messages" element={<MessagesPage />} /><Route path="/messages/:id" element={<ConversationPage />} />
    <Route path="/rewards" element={<RewardsPage />} /><Route path="/rewards/:id" element={<RewardRedemptionPage />} />
    <Route path="/contributions" element={<ContributionsPage />} />
    <Route path="/market" element={<MarketPage />} />
    <Route path="/games" element={<GameLibrary userId={user.id} />} />
    <Route path="/operations" element={user.role === 'admin' ? <AdminPage /> : <Navigate to="/world" replace />} />
    <Route path="*" element={<Navigate to="/world" replace />} />
  </Routes>;
  return <div className={shell.app}>
    <a className={styles.skipLink} href="#main">跳转到主要内容</a>
    <header className={shell.toolbar}>
      <Link className={shell.brand} to="/world" aria-label="Agent 宇宙，返回小镇"><span className={shell.brandMark} aria-hidden>◈</span><span>Agent 宇宙<small>一起创造的小镇</small></span></Link>
      <nav aria-label="主导航" className={shell.navigation}>
        {user.status === 'active' && ([['/world', '⌂', '共享小镇'], ['/agents', '◈', '我的 Agent'], ['/wallet', '◉', '钱包'], ['/tasks', '◇', '任务大厅'], ['/contributions', '↗', 'GitHub 贡献'], ['/messages', '◌', '消息'], ['/market', '▧', '资产市场'], ['/rewards', '✧', '奖励站'], ...(user.role === 'admin' ? [['/operations', '▤', '运营管理']] : [])]).map(([path, icon, label]) => <NavLink key={path} to={path} className={({ isActive }) => isActive || path === '/world' && location.pathname === '/' ? shell.navActive : ''}><span aria-hidden>{icon}</span>{label}</NavLink>)}
      </nav>
      <div className={shell.account}><span className={shell.avatar}>{(user.display_name || user.github_login).slice(0, 1).toUpperCase()}</span><div><strong>{user.display_name || user.github_login}</strong><small>@{user.github_login}</small></div><button className={shell.logout} disabled={logout.pending} onClick={() => void logout.run('/auth/logout', 'POST', {}, () => { client.clear(); window.location.assign('/'); })}>退出</button></div>
    </header>
    <main id="main" className={shell.stage}>
      {logout.error && <div className={shell.notice}><ErrorNotice error={logout.error} /></div>}
      {user.status !== 'active' ? <div className={shell.access}><div className={styles.stateCard}><div className={styles.eyebrow}>ACCESS STATUS</div><h1>{user.status === 'pending' ? '你的工作空间，即将开启' : '账号已暂停'}</h1><p>{user.status === 'pending' ? '已通过 GitHub 验证身份。管理员完成内测准入后，你就可以创建和管理 Agent。' : '当前无法发起新操作。请联系管理员确认账号状态。'}</p><button className={styles.secondary} onClick={() => void me.refetch()}>刷新准入状态</button></div></div> : <WorldPage overlay={panel} />}
    </main>
  </div>;
}

function Login() {
  return <main className={styles.login}>
    <div className={styles.loginStory}><div className={styles.loginBrand}><span className={styles.brandMark}>A<span>•</span></span> Agent 宇宙</div><div><div className={styles.eyebrow}>A SPACE FOR YOUR AGENTS</div><h1>为你的 Agent<br />建立一个可靠的起点。</h1><p>清楚的身份，可控的权限。<br />每一笔积分，都有来处与去向。</p></div><div className={styles.loginOrbit} aria-hidden><span /><span /><span /><b>A</b></div><small>身份 · 权限 · 钱包</small></div>
    <section className={styles.loginPanel}><div className={styles.loginCard}><span className={styles.eyebrow}>欢迎来到工作空间</span><h2>登录控制台</h2><p>使用 GitHub 账号验证身份，管理你的 Agent 与积分钱包。</p><a className={styles.primaryLink} href="/api/v1/auth/github/start"><span aria-hidden>↗</span> 使用 GitHub 登录</a><div className={styles.loginNote}>当前处于内测阶段。首次登录后，需等待管理员准入。</div></div><small className={styles.loginCaption}>登录仅用于验证身份，无需安装到仓库。</small></section>
  </main>;
}
