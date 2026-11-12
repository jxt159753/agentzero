import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { WORLD_PLACES, WORLD_ROOM_DIMENSIONS, type WorldSelf, type PublicWorldWork, type WorldAgentProfile, type WorldLand, type WorldPublicationOptions, type WorldSnapshot, type WorldStreamMessage, type WorldStudio } from '@agentzero/contracts';
import { api, dateTime, measure, points, useCommand } from './api';
import { CommandNotice, Empty, ErrorNotice, Loading } from './components';
import { MovementOutbox, applyWorldDelta, houseEntrance, sceneBounds, type SceneCamera, type WorldPoint } from './world-scene';
import type { Me } from './types';
import { WorldBuilder, type BuilderSelection } from './world-builder';
import { ArcadeMachine } from './games';
import { LandShowcase } from './land-showcase';
import styles from './style.module.css';
import worldStyles from './world.module.css';
import builderStyles from './world-builder.module.css';

const WorldMap = lazy(() => import('./world-map'));
type Connection = 'connecting' | 'live' | 'reconnecting';

function useWorld() {
  const [world, setWorld] = useState<WorldSnapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<Error | null>(null);
  const [epoch, setEpoch] = useState(0);
  const transitioning = useRef(false), suspend = useRef<() => void>(() => {});
  const outbox = useRef(new MovementOutbox()), flush = useRef<() => void>(() => {});
  const move = useCallback((point: WorldPoint, moving = true) => {
    if (transitioning.current) return;
    outbox.current.move(point, moving);
    if (!moving) flush.current();
  }, []);
  useEffect(() => {
    let closed = false, socket: WebSocket | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    let received = false, lastFrame = Date.now(), attempts = 0, denied = false;
    setConnection('connecting'); setError(null);
    const sendMovement = () => {
      if (transitioning.current || !received || socket?.readyState !== WebSocket.OPEN) return;
      const command = outbox.current.next();
      if (command) socket.send(JSON.stringify(command));
    };
    flush.current = sendMovement;
    suspend.current = () => { clearTimeout(timer); received = false; const previous = socket; socket = null; previous?.close(); };
    const connect = () => {
      if (transitioning.current || closed || denied || !navigator.onLine || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
      clearTimeout(timer);
      const url = new URL('/api/v1/world/stream', window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('v', '2'); received = false; outbox.current.reconnect();
      const currentSocket = new WebSocket(url); socket = currentSocket;
      currentSocket.onopen = () => { if (!closed && socket === currentSocket) lastFrame = Date.now(); };
      currentSocket.onmessage = event => {
        if (transitioning.current || closed || socket !== currentSocket) return;
        try {
          const message = JSON.parse(String(event.data)) as WorldStreamMessage;
          lastFrame = Date.now();
          if (message.type === 'snapshot') {
            received = true; attempts = 0; setWorld(message.world); setConnection('live'); setError(null); sendMovement();
          } else if (message.type === 'delta' && received) setWorld(previous => previous ? applyWorldDelta(previous, message) : previous);
          // Ping and movement acknowledgements keep the connection fresh without repainting the UI.
        } catch { setError(new Error('小镇同步响应无效，正在重新连接。')); currentSocket.close(); }
      };
      currentSocket.onerror = () => { if (!closed && socket === currentSocket) currentSocket.close(); };
      currentSocket.onclose = event => {
        if (transitioning.current || closed || socket !== currentSocket) return;
        socket = null; received = false; setConnection('reconnecting');
        if (event.code === 1008 && event.reason !== 'WORLD_PRESENCE_EXPIRED') { denied = true; setError(new Error(event.reason === 'WORLD_USER_CONNECTION_LIMIT' ? '当前账号的小镇连接数已达上限，请关闭其他连接后重新同步。' : '小镇会话已失效，请重新登录或重新同步。')); return; }
        if (event.reason === 'WORLD_CAPACITY_REACHED') setError(new Error('小镇当前在线人数已满，正在等待空位并自动重连。'));
        if (navigator.onLine) timer = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10000) + Math.random() * 1000);
      };
    };
    const offline = () => { clearTimeout(timer); received = false; setConnection('reconnecting'); const previous = socket; socket = null; previous?.close(); };
    const online = () => { clearTimeout(timer); connect(); };
    window.addEventListener('offline', offline); window.addEventListener('online', online); connect();
    const movement = setInterval(sendMovement, 500);
    const heartbeat = setInterval(() => {
      if (received && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'heartbeat' }));
    }, 20000);
    const freshness = setInterval(() => { if (socket?.readyState === WebSocket.OPEN && Date.now() - lastFrame > 15000) { setConnection('reconnecting'); socket.close(); } }, 2000);
    return () => { closed = true; flush.current = () => {}; clearTimeout(timer); clearInterval(movement); clearInterval(heartbeat); clearInterval(freshness); socket?.close(); window.removeEventListener('offline', offline); window.removeEventListener('online', online); };
  }, [epoch]);
  const acceptSelf = (self: WorldSelf) => { outbox.current.clear(); setWorld(previous => previous ? { ...previous, self } : previous); };
  const beginTransition = () => { transitioning.current = true; outbox.current.clear(); suspend.current(); };
  const endTransition = () => { transitioning.current = false; setEpoch(value => value + 1); };
  return { world, connection, error, move, acceptSelf, beginTransition, endTransition, reconnect: () => setEpoch(value => value + 1) };
}

function ConnectionStatus({ connection }: { connection: Connection }) {
  return <span data-testid="world-connection" role="status" className={`${worldStyles.status} ${connection !== 'live' ? worldStyles.statusWaiting : ''}`}>{connection === 'live' ? '已同步' : connection === 'connecting' ? '正在连接小镇' : '连接中断，正在重连'}</span>;
}
function PublicPlaces() {
  const icons: Record<string, string> = { tasks: '◇', market: '▧', rewards: '✧' };
  return <nav className={worldStyles.places} aria-label="小镇公共区域">{WORLD_PLACES.map(place => <Link key={place.id} to={place.path}><span aria-hidden>{icons[place.id]}</span>{place.name}<small>公共设施 · 不可购买</small></Link>)}</nav>;
}

export function WorldPage({ overlay, view = 'town' }: { overlay?: ReactNode; view?: 'town' | 'studio' | 'agent' }) {
  const navigate = useNavigate(), location = useLocation(), live = useWorld(), roomCommand = useCommand();
  const roomChanging = useRef(false), [roomRequest, setRoomRequest] = useState<WorldPoint | null>(null);
  const [camera, setCamera] = useState<SceneCamera>({ x: 0, y: 0, zoom: 1, follow: true, revision: 0 });
  const [position, setPosition] = useState<WorldPoint | null>(null);
  const [directory, setDirectory] = useState(false);
  const [viewMode, setViewMode] = useState<'first-person' | 'overview'>('first-person');
  const [builderOpen, setBuilderOpen] = useState(false), [builderLocked, setBuilderLocked] = useState(false);
  const [builderSelection, setBuilderSelection] = useState<BuilderSelection>({ landId: '' });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const match = location.pathname.match(/^\/world\/(studios|agents)\/([^/]+)$/);
  const detailView = match?.[1] === 'studios' ? 'studio' : match?.[1] === 'agents' ? 'agent' : view;
  const id = match?.[2] ?? '', world = live.world, fresh = live.connection === 'live';
  const current = position && (position.room_id ?? null) === (world?.self.room_id ?? null) ? position : world?.self ?? { x: 0, y: 0 };
  const hasOverlay = Boolean(overlay) || detailView !== 'town';
  const editingLand = builderOpen && !hasOverlay ? world?.lands.find(land => land.id === builderSelection.landId && land.owner?.id === me.data?.user.id) : undefined;
  const focus = (point: WorldPoint, follow = false, zoom = 1) => setCamera(previous => ({ ...point, zoom, follow, revision: previous.revision + 1 }));
  const move = (point: WorldPoint, moving = true) => { setPosition(point); live.move(point, moving); };
  const openBuilder = (landId?: string) => {
    if (builderLocked) return;
    const land = world?.lands.find(item => item.owner?.id === me.data?.user.id && (!landId || item.id === landId));
    setBuilderSelection({ landId: land?.id ?? '', roomId: land?.models?.some(model => model.id === world?.self.room_id) ? world?.self.room_id : null }); setBuilderOpen(true); setDirectory(false);
    if (land) focus(world?.self.room_id && land.models?.some(model => model.id === world.self.room_id) ? { x: 0, y: 0 } : land, false, 1.2);
  };
  const pickPlacement = (point: WorldPoint) => {
    if (builderLocked || !fresh || !editingLand || editingLand.listing) return;
    setBuilderSelection(previous => previous.placement ? { ...previous, placement: { ...previous.placement,
      x: Math.round((point.x - (previous.roomId ? 0 : editingLand.x)) * 1000) / 1000, y: Math.round((point.y - (previous.roomId ? 0 : editingLand.y)) * 1000) / 1000 } } : previous);
  };
  const changeRoom = async (roomId: string | null, retry?: WorldPoint) => {
    if (!world || roomChanging.current) return;
    const houseId = roomId ?? world.self.room_id;
    const land = world.lands.find(item => item.models?.some(model => model.id === houseId)), house = land?.models?.find(model => model.id === houseId);
    if (!retry && (!land || !house)) return;
    const point: WorldPoint = retry ?? (roomId ? { x: 0, y: WORLD_ROOM_DIMENSIONS.height / 2 - 0.25, room_id: roomId } : { ...houseEntrance(land!, house!), room_id: null });
    setRoomRequest(point); roomChanging.current = true; live.beginTransition();
    try { await roomCommand.run<{ self: WorldSelf }>('/world/presence', 'POST', point, result => { live.acceptSelf(result.self); setPosition(result.self); focus(result.self, true); setRoomRequest(null); }); }
    finally { roomChanging.current = false; live.endTransition(); }
  };
  const close = () => navigate('/world');
  useEffect(() => { if (hasOverlay) setDirectory(false); }, [hasOverlay]);
  return <div className={worldStyles.town}>
    <section className={worldStyles.mapCard} aria-label="小镇地图" inert={hasOverlay} aria-hidden={hasOverlay || undefined}>
      {world ? <Suspense fallback={<div className={worldStyles.mapOverlay}><Loading /></div>}><WorldMap world={world} camera={camera} disabled={hasOverlay || !fresh || Boolean(live.error) || roomCommand.pending} onMove={move} onLand={landId => navigate(`/world/studios/${landId}`)} onAgent={agentId => navigate(`/world/agents/${agentId}`)} onPlace={path => navigate(path)}
        onRoom={roomId => void changeRoom(roomId)} renderArcade={(selection, onPlayingChange) => <ArcadeMachine {...selection} userId={me.data?.user.id} onPlayingChange={onPlayingChange} />}
        editingRoomId={builderSelection.roomId} onViewChange={setViewMode} editingLandId={editingLand?.id} placement={editingLand ? builderSelection.placement : undefined} onPlacementPoint={pickPlacement} /></Suspense>
        : <div className={worldStyles.mapOverlay}><Loading /><p>正在打开你的小镇…</p></div>}
    </section>
    {!hasOverlay && <>
      <div className={worldStyles.townTitle}><span className={worldStyles.overline}>A PLACE TO BUILD TOGETHER</span><h1>我们的 Agent 小镇<span>01</span></h1><div className={worldStyles.titleMeta}><ConnectionStatus connection={live.connection} />{world && <span>{world.visitors.length} 位访客 · {world.agents.filter(agent => agent.online).length} 个 Agent 在线</span>}</div></div>
      <button className={worldStyles.directoryToggle} aria-expanded={directory} disabled={builderLocked} onClick={() => { setBuilderOpen(false); setDirectory(value => !value); }}><span aria-hidden>▦</span>小镇目录{directory ? ' −' : ' ＋'}</button>
      <button className={worldStyles.gamesToggle} onClick={() => navigate('/games')}>游戏工坊</button>
      <button className={builderStyles.toggle} aria-expanded={builderOpen} disabled={!fresh || !me.data || builderLocked} onClick={() => builderOpen ? setBuilderOpen(false) : openBuilder()}>布置模型</button>
      {!builderOpen && <><div className={worldStyles.mapTools}>{viewMode === 'overview' && <><button aria-label="缩小地图" disabled={camera.zoom <= 0.25} onClick={() => setCamera(value => ({ ...value, zoom: Math.max(0.25, value.zoom - 0.15) }))}>−</button><span>{Math.round(camera.zoom * 100)}%</span><button aria-label="放大地图" disabled={camera.zoom >= 1.8} onClick={() => setCamera(value => ({ ...value, zoom: Math.min(1.8, value.zoom + 0.15) }))}>＋</button><span className={worldStyles.toolDivider} /></>}<button onClick={() => focus(current, true)}>定位我</button><button onClick={() => focus({ x: 0, y: 0 })}>广场</button><button onClick={() => focus({ x: 0, y: 0 }, false, 0.25)}>全景</button></div>
      <section className={worldStyles.walkHud} aria-label="我的访客角色"><div><strong>{viewMode === 'first-person' ? '第一人称漫步' : '俯瞰小镇'}</strong><span>当前位置 ({Number(current.x.toFixed(2))}, {Number(current.y.toFixed(2))})</span><small>{viewMode === 'first-person' ? 'WASD 行走 · Shift 跑动 · 空格跳跃' : '方向键 / WASD · 点击行走 · 拖动查看'}</small></div></section>
      <div className={worldStyles.legend}><span><i className={worldStyles.visitorDot} />访客</span><span><i className={worldStyles.agentDot} />Agent</span><span>公共区域不可购买</span><span>非公共用地默认开放购买</span></div></>}
    </>}
    {!fresh && !hasOverlay && <div className={worldStyles.connectionNotice} role="status"><button onClick={live.reconnect}>重新连接</button><span>产权报价以恢复连接后的数据为准</span></div>}
    {roomCommand.error && !hasOverlay && <div className={worldStyles.connectionNotice} role="status"><CommandNotice command={roomCommand} />{roomRequest && <button disabled={roomCommand.pending} onClick={() => void changeRoom(roomRequest.room_id ?? null, roomRequest)}>重试进出房屋</button>}</div>}
    {live.error && !hasOverlay && <div className={worldStyles.connectionNotice}><ErrorNotice error={live.error} /><button onClick={live.reconnect}>重新同步</button></div>}
    {directory && !hasOverlay && <aside className={worldStyles.directoryDrawer} aria-label="小镇目录"><div className={worldStyles.drawerHeading}><h2>探索小镇</h2><button aria-label="关闭小镇目录" onClick={() => setDirectory(false)}>×</button></div><PublicPlaces /><p className={worldStyles.directoryNote}>公共广场、道路与设施属于所有人。默认地图内其余用地均开放购买，同面积越靠近中央广场，默认地价越高；购买后可装修或挂牌交易。</p>{fresh && world ? <>
      <section aria-label="工作室目录"><div className={worldStyles.panelHeader}><h2>土地与工作室</h2><span>{world.lands.length} 块</span></div>{world.lands.map(land => <article className={worldStyles.landRow} data-testid={`world-land-${land.id}`} key={land.id}><span className={worldStyles.residentBadge} aria-hidden>⌂</span><div><strong>{land.owner_agent_id ? land.name : land.code}</strong><small>{land.code} · {land.owner ? `产权人 @${land.owner.github_login}` : land.purchasable ? '系统待售' : '公共土地'}{land.owner_name ? ` · 管理 Agent：${land.owner_name}` : ''}{land.listing ? ' · 挂牌中' : ''}</small><div className={worldStyles.rowActions}><button onClick={() => { focus(land); setDirectory(false); }}>定位</button><Link to={`/world/studios/${land.id}`} aria-label={`进入 ${land.owner_agent_id ? land.name : land.code}`}>查看地块 →</Link></div></div></article>)}{!world.lands.length && <Empty>土地供应正在准备中，你可以先自由探索小镇。</Empty>}</section>
      <section aria-label="小镇 Agent"><div className={worldStyles.panelHeader}><h2>小镇里的 Agent</h2><span>{world.agents.length}</span></div><ul className={worldStyles.residentList}>{world.agents.map(agent => <li key={agent.id} data-testid={`world-agent-${agent.id}`}><Link className={worldStyles.resident} to={`/world/agents/${agent.id}`}><span className={worldStyles.residentBadge}>◈</span><span className={worldStyles.residentText}><strong>{agent.name}</strong><small>@{agent.owner.github_login}</small></span><span className={`${worldStyles.onlineLabel} ${agent.online ? '' : worldStyles.offlineLabel}`}>{agent.online ? '在线' : agent.status === 'paused' ? '已暂停 · 离线' : '离线 · 模拟活动'}</span></Link></li>)}</ul></section>
      <section aria-label="在线访客"><div className={worldStyles.panelHeader}><h2>此刻在小镇</h2><span>{world.visitors.length}</span></div><ul className={worldStyles.residentList}>{world.visitors.map(visitor => <li key={visitor.id} data-testid={`world-visitor-${visitor.id}`}><div className={worldStyles.resident}><span className={`${worldStyles.residentBadge} ${worldStyles.visitorBadge}`}>○</span><span className={worldStyles.residentText}><strong>{visitor.name}{visitor.id === world.self.id ? ' · 你' : ''}</strong><small>@{visitor.github_login} · 用户访客</small></span></div></li>)}</ul></section><p className={worldStyles.footerNote}>地图范围 {sceneBounds(world).max_x - sceneBounds(world).min_x} × {sceneBounds(world).max_y - sceneBounds(world).min_y} · 上次同步 {dateTime(world.server_time)}</p>
    </> : <p>连接恢复后显示最新土地归属。</p>}</aside>}
    {builderOpen && world && <WorldBuilder lands={world.lands} userId={me.data?.user.id} selection={builderSelection} connected={fresh && !live.error} hidden={hasOverlay}
      onChange={setBuilderSelection} onClose={() => setBuilderOpen(false)} onFocus={point => focus(point, false, 1.2)} onLockedChange={setBuilderLocked} />}
    {hasOverlay && <div className={`${worldStyles.featureOverlay} ${location.pathname.startsWith('/messages') ? worldStyles.chatOverlay : ''}`} role="region" aria-label={detailView === 'town' ? '功能面板' : '小镇详情'}><div className={worldStyles.overlayHeading}><Link to="/world">← 回到小镇</Link><button aria-label="关闭功能面板" onClick={close}>×</button></div><div className={worldStyles.overlayContent}>{overlay ?? (fresh && world ? detailView === 'studio' ? <StudioDetail id={id} world={world} userId={me.data?.user.id} onBuild={landId => { openBuilder(landId); navigate('/world'); }} /> : <AgentProfile id={id} userId={me.data?.user.id} /> : <p>连接恢复后显示最新产权与公开成果。</p>)}</div></div>}
  </div>;
}

function LandLinks({ land, owned, onBuild }: { land: WorldLand; owned: boolean; onBuild: (landId: string) => void }) {
  return <div className={worldStyles.detailLinks}>{land.owner_agent_id && <Link to={`/world/agents/${land.owner_agent_id}`}>查看 {land.owner_name} 的公开主页 →</Link>}{land.works_url && <a href={land.works_url} target="_blank" rel="noreferrer">访问公开作品 ↗</a>}{owned ? <><button type="button" disabled={Boolean(land.listing)} onClick={() => onBuild(land.id)}>免费模型布置</button><Link to={`/market?tab=assets&agent=${land.owner_agent_id}`}>编辑地块展示与管理挂牌 →</Link></> : land.tradeable && land.listing ? <Link to="/market?tab=resale">查看挂牌报价 · {points(land.listing.points_price)} 积分 →</Link> : land.purchasable ? <Link to={`/market?land=${land.id}`}>查看购地报价 · {points(land.points_price)} 积分 →</Link> : !land.tradeable ? <span>公共区域 · 不可购买或挂牌</span> : null}</div>;
}
function StudioDetail({ id, world, userId, onBuild }: { id: string; world: WorldSnapshot; userId?: string; onBuild: (landId: string) => void }) {
  const mountedAt = useRef(Date.now());
  const current = world.lands.find((land) => land.id === id);
  const detail = useQuery({ queryKey: ['world-studio', id, current?.version, current?.owner_agent_id], queryFn: () => api<WorldStudio>(`/world/studios/${id}`), refetchInterval: 2000, staleTime: 0, gcTime: 0 });
  const icons = { plant: '♣', lamp: '☼', bookshelf: '▥', banner: '⚑' };
  if (detail.isPending) return <Loading />;
  if (detail.error) return <ErrorNotice error={detail.error} />;
  if (detail.dataUpdatedAt < mountedAt.current || (current && (detail.data.land.version !== current.version || detail.data.land.owner_agent_id !== current.owner_agent_id))) return <Loading />;
  const { land, agent, works } = detail.data;
  return <section className={`${worldStyles.panel} ${worldStyles.profile}`} aria-label="工作室详情" data-testid="world-studio"><div className={styles.eyebrow}>OPEN STUDIO / {land.code}</div><h2>{land.name}</h2><div className={worldStyles.facts}><span>地块 {land.code} · ({measure(land.x, 4)}, {measure(land.y, 4)})</span><span>面积 {measure(land.area)} m²</span><span>产权人：{land.owner ? `@${land.owner.github_login}` : land.tradeable ? '系统待售' : '公共土地'}</span>{land.owner_name && <span>管理 Agent：{land.owner_name}</span>}{agent && <span>{agent.online ? 'Agent 在线' : 'Agent 离线'}{agent.status === 'paused' ? ' · 已暂停' : ''}</span>}</div><div className={worldStyles.studioPreview} aria-label="已放置装饰"><span className={worldStyles.house} aria-hidden>⌂</span>{land.decorations.map((item) => <div key={item.id} className={worldStyles.decoration}><span aria-hidden>{icons[item.appearance]}</span>{item.name}</div>)}{!land.decorations.length && <span className={styles.hint}>系统预制工作室 · 尚未布置装饰</span>}</div><p className={styles.hint}>土地产权归用户所有，Agent 负责代购、管理工作室与交易。</p><LandLinks land={land} owned={Boolean(land.owner && land.owner.id === userId)} onBuild={onBuild} />{land.tradeable && (land.listing || land.purchasable) && <p>交易包含地块和预制工作室，产权登记在买方主人名下，由买方 Agent 管理；卖方装饰物归还原 Agent 库存，个性化名称、作品链接与展示内容清除。</p>}{Boolean(land.showcase?.length) && <section aria-label="地块展示"><h2>地块展示</h2><LandShowcase items={land.showcase!} /></section>}<PublicWorks works={works} ownerId={agent?.owner.id} /></section>;
}
function AgentProfile({ id, userId }: { id: string; userId?: string }) {
  const mountedAt = useRef(Date.now());
  const detail = useQuery({ queryKey: ['world-agent', id], queryFn: () => api<WorldAgentProfile>(`/world/agents/${id}`), refetchInterval: 2000, staleTime: 0, gcTime: 0 });
  if (detail.isPending) return <Loading />;
  if (detail.error) return <ErrorNotice error={detail.error} />;
  if (detail.dataUpdatedAt < mountedAt.current) return <Loading />;
  const { agent, lands, works } = detail.data, own = agent.owner.id === userId;
  return <section className={`${worldStyles.panel} ${worldStyles.profile}`} aria-label="Agent 公开主页"><div className={styles.eyebrow}>AGENT / PUBLIC PROFILE</div><h2>{agent.name}</h2><div className={worldStyles.facts}><span>所有者 @{agent.owner.github_login}</span><span>{agent.online ? '在线' : '离线'}{agent.status === 'paused' ? ' · 已暂停' : ''}</span><span>管理 {lands.length} 间工作室 · 土地产权归主人</span></div>{own && <div className={worldStyles.detailLinks}><Link to={`/agents/${id}`}>管理身份、权限和钱包 →</Link></div>}<div className={worldStyles.detailLinks}>{lands.map((land) => <Link key={land.id} to={`/world/studios/${land.id}`}>⌂ {land.name} →</Link>)}</div><PublicWorks works={works} ownerId={agent.owner.id} />{own && <PublicationManager agentId={id} />}</section>;
}
function PublicWorks({ works, ownerId }: { works: PublicWorldWork[]; ownerId?: string }) {
  return <section aria-label="公开成果"><h2>已验收的公开成果</h2>{works.length ? works.map((work) => <article key={work.task_id} className={worldStyles.work}><h3>{work.summary}</h3><div className={worldStyles.facts}><span>{work.role === 'lead' ? '主承接 Agent' : '协作 Agent'}</span><span>已结算 · {dateTime(work.settled_at)}</span></div><p><a href={work.pr_url} target="_blank" rel="noreferrer">查看已验收 PR ↗</a></p>{work.collaborators.length > 0 && <p>已公开的协作成员：{work.collaborators.map((agent, index) => <span key={agent.id}>{index > 0 ? '、' : ''}<Link to={`/world/agents/${agent.id}`}>{agent.name}</Link>{agent.owner_user_id === ownerId ? '（共同所有者）' : ''}</span>)}</p>}</article>) : <p>尚未公开已验收成果。</p>}</section>;
}
function PublicationManager({ agentId }: { agentId: string }) {
  const options = useQuery({ queryKey: ['world-publication-options', agentId], queryFn: () => api<WorldPublicationOptions>(`/world/agents/${agentId}/publication-options`) });
  return <details className={worldStyles.work}><summary>管理公开成果（仅你可见）</summary><p className={styles.hint}>选择已结算的公开仓库成果，填写你授权公开的摘要。私有仓库成果不会进入小镇展示。</p><ErrorNotice error={options.error} />{options.isPending ? <Loading /> : options.data?.items.map((item) => <PublicationForm key={`${item.task_id}-${item.summary}`} agentId={agentId} item={item} />)}{options.data?.items.length === 0 && <p>尚无可以公开的已结算成果。</p>}</details>;
}
function PublicationForm({ agentId, item }: { agentId: string; item: WorldPublicationOptions['items'][number] }) {
  const [summary, setSummary] = useState(item.summary ?? '');
  const command = useCommand(), client = useQueryClient();
  const refresh = async () => { await Promise.all(['world-publication-options', 'world-agent', 'world-studio'].map((key) => client.invalidateQueries({ queryKey: [key] }))); };
  return <form className={worldStyles.work} onSubmit={(event) => { event.preventDefault(); void command.run(`/world/agents/${agentId}/works/${item.task_id}`, 'PUT', { summary: summary.trim() }, refresh); }}><h3>{item.title}</h3><p><a href={item.pr_url} target="_blank" rel="noreferrer">查看成果 PR ↗</a></p><label className={styles.field}>授权公开的成果摘要<textarea required maxLength={500} value={summary} onChange={(event) => setSummary(event.target.value)} rows={2} /></label><div className={worldStyles.detailLinks}><button disabled={command.pending || !summary.trim()}>{item.summary ? '更新公开摘要' : '公开此成果'}</button>{item.summary && <button type="button" className={styles.secondary} disabled={command.pending} onClick={() => void command.run(`/world/agents/${agentId}/works/${item.task_id}`, 'DELETE', {}, refresh)}>撤回公开</button>}</div><CommandNotice command={command} /></form>;
}
