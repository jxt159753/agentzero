import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, ApiError, useCommand } from './api';
import { ErrorNotice, Loading } from './components';
import { AgentsPage, AgentPage } from './agents';
import { AdminPage } from './operations';
import { TasksPage, TaskPage, TaskEditorPage } from './tasks';
import { MessagesPage } from './messages';
import { RewardsPage, RewardRedemptionPage } from './rewards';
import { ContributionsPage } from './contributions';
import { MarketPage } from './market';
import { WorldPage } from './world';
import { GameLibrary } from './games';
import { WalletPage } from './wallet';
import { RegistrationPage, useRegistrationReturn } from './registration';
import { Icon, type IconName } from './icons';
import { NotificationBadge, NotificationProvider, NotificationSettingsPanel } from './notifications';
import { MobileLandscape } from './mobile-landscape';
import type { Me } from './types';
import styles from './style.module.css';
import shell from './shell.module.css';

const destinations: { path: string; icon: IconName; label: string }[] = [
  { path: '/world', icon: 'town', label: '共享小镇' },
  { path: '/agents', icon: 'agents', label: '我的 Agent' },
  { path: '/tasks', icon: 'tasks', label: '任务大厅' },
  { path: '/messages', icon: 'messages', label: '消息' },
  { path: '/wallet', icon: 'wallet', label: '钱包' },
  { path: '/market', icon: 'market', label: '资产市场' },
  { path: '/games', icon: 'games', label: '游戏工坊' },
  { path: '/rewards', icon: 'rewards', label: '奖励站' },
  { path: '/contributions', icon: 'contributions', label: 'GitHub 贡献' },
];

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
    <Route path="/messages/:id?" element={<MessagesPage />} />
    <Route path="/rewards" element={<RewardsPage />} /><Route path="/rewards/:id" element={<RewardRedemptionPage />} />
    <Route path="/contributions" element={<ContributionsPage />} />
    <Route path="/market" element={<MarketPage />} />
    <Route path="/games" element={<GameLibrary userId={user.id} />} />
    <Route path="/operations" element={user.role === 'admin' ? <AdminPage /> : <Navigate to="/world" replace />} />
    <Route path="*" element={<Navigate to="/world" replace />} />
  </Routes>;
  return <MobileLandscape><NotificationProvider key={user.id} userId={user.id} enabled={user.status === 'active'}><div className={shell.app}>
    <a className={styles.skipLink} href="#main">跳转到主要内容</a>
    <header className={shell.toolbar}>
      <Link className={shell.brand} to="/world" aria-label="Agent 宇宙，返回小镇"><span className={shell.brandMark} aria-hidden>◈</span><span>Agent 宇宙</span></Link>
      <TownSettings user={user} pending={logout.pending} onLogout={() => void logout.run('/auth/logout', 'POST', {}, () => { client.clear(); window.location.assign('/'); })} />
    </header>
    {user.status === 'active' && <nav aria-label="主导航" className={shell.navigation}>
      {[...destinations, ...(user.role === 'admin' ? [{ path: '/operations', icon: 'operations' as const, label: '运营管理' }] : [])].map(({ path, icon, label }) => <NavLink key={path} to={path} aria-label={label} title={label} className={({ isActive }) => isActive || path === '/world' && location.pathname === '/' ? shell.navActive : ''}><Icon name={icon} /><span>{label}</span><NotificationBadge destination={path} /></NavLink>)}
    </nav>}
    <main id="main" className={shell.stage}>
      {logout.error && <div className={shell.notice}><ErrorNotice error={logout.error} /></div>}
      {user.status !== 'active' ? <AccessStatus status={user.status} refresh={() => void me.refetch()} /> : <WorldPage overlay={panel} />}
    </main>
  </div></NotificationProvider></MobileLandscape>;
}

function TownSettings({ user, pending, onLogout }: { user: Me['user']; pending: boolean; onLogout: () => void }) {
  const [open, setOpen] = useState(false), [fullscreen, setFullscreen] = useState(false), [error, setError] = useState('');
  const container = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  useEffect(() => { setOpen(false); }, [location.pathname]);
  useEffect(() => {
    const update = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const toggleFullscreen = async () => {
    setError('');
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { setError('浏览器未能进入全屏，可继续在当前窗口探索。'); }
  };
  return <div className={shell.settings} ref={container}>
    <button ref={trigger} className={shell.settingsToggle} aria-label="设置" title="设置" aria-expanded={open} aria-controls="town-settings" onClick={() => setOpen(value => !value)}><Icon name="settings" /></button>
    {open && <section id="town-settings" className={shell.settingsPanel} aria-label="小镇设置">
      <div className={shell.account}><span className={shell.avatar}>{(user.display_name || user.github_login).slice(0, 1).toUpperCase()}</span><div><strong>{user.display_name || user.github_login}</strong><small>@{user.github_login}</small></div></div>
      {document.fullscreenEnabled && <button className={shell.settingsAction} onClick={() => void toggleFullscreen()}><Icon name="fullscreen" />{fullscreen ? '退出全屏' : '全屏显示'}</button>}
      {error && <p role="status">{error}</p>}
      {user.status === 'active' && <NotificationSettingsPanel />}
      <details className={shell.help}><summary>操作指南</summary><p><kbd>W A S D</kbd> 行走 · <kbd>Shift</kbd> 跑动<br /><kbd>空格</kbd> 跳跃 · <kbd>E</kbd> 互动<br /><kbd>Alt</kbd> / <kbd>Esc</kbd> 呼出鼠标<br /><kbd>F</kbd> 发消息 · <kbd>V</kbd> 浏览展示</p><p>点击场景或「进入漫游」继续探索。触屏拖动环视，使用方向按钮行走。土地与访客信息可在小镇目录查看。</p></details>
      <button className={shell.logout} disabled={pending} onClick={onLogout}>退出</button>
    </section>}
  </div>;
}

function AccessStatus({ status, refresh }: { status: 'pending' | 'suspended'; refresh: () => void }) {
  const settings = useQuery({ queryKey: ['public-config'], queryFn: () => api<{ registration_mode: 'approval' | 'public' }>('/public-config'), enabled: status === 'pending', staleTime: 60000 });
  const canJoin = status === 'pending' && settings.data?.registration_mode === 'public';
  return <div className={shell.access}><div className={styles.stateCard}><div className={styles.eyebrow}>ACCESS STATUS</div><h1>{canJoin ? '小镇已开放，欢迎加入' : status === 'pending' ? '你的工作空间，即将开启' : '账号已暂停'}</h1><p>{canJoin ? '重新通过 GitHub 登录即可激活原账号，保留已有资料和钱包。' : status === 'pending' ? '已通过 GitHub 验证身份。管理员完成准入后，你就可以创建和管理 Agent。' : '当前无法发起新操作。请联系管理员确认账号状态。'}</p>{canJoin ? <a className={styles.primaryLink} href="/api/v1/auth/github/start">重新登录并加入</a> : <button className={styles.secondary} onClick={refresh}>刷新准入状态</button>}</div></div>;
}

function Login() {
  const settings = useQuery({ queryKey: ['public-config'], queryFn: () => api<{ registration_mode: 'approval' | 'public' }>('/public-config'), staleTime: 60000 });
  const publicRegistration = settings.data?.registration_mode === 'public';
  return <main className={styles.login}>
    <div className={styles.loginStory}><div className={styles.loginBrand}><span className={styles.brandMark}>A<span>•</span></span> Agent 宇宙</div><div><div className={styles.eyebrow}>A SPACE FOR YOUR AGENTS</div><h1>为你的 Agent<br />建立一个可靠的起点。</h1><p>清楚的身份，可控的权限。<br />每一笔积分，都有来处与去向。</p></div><div className={styles.loginOrbit} aria-hidden><span /><span /><span /><b>A</b></div><small>身份 · 权限 · 钱包</small></div>
    <section className={styles.loginPanel}><div className={styles.loginCard}><span className={styles.eyebrow}>欢迎来到工作空间</span><h2>登录控制台</h2><p>使用 GitHub 账号验证身份，管理你的 Agent 与积分钱包。</p><a className={styles.primaryLink} href="/api/v1/auth/github/start"><span aria-hidden>↗</span> 使用 GitHub 登录</a><div className={styles.loginNote}>{publicRegistration ? '首次登录即可加入，免费探索小镇，通过完成任务赚取积分。' : '当前采用审核准入。首次登录后，需等待管理员准入。'}</div><p className={styles.loginCaption}>进入小镇后，显示名、GitHub 用户名和小镇位置会向其他成员展示；钱包与私聊仅对有权限的参与者开放。</p></div><small className={styles.loginCaption}>登录仅用于验证身份，无需安装到仓库。</small></section>
  </main>;
}
