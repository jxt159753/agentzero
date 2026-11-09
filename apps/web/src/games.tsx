import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { GameDto, GameMachineDto, GameSessionDto, GameSourceInput, GameSettlementRuleId, WorldLand, WorldModelPlacement } from '@agentzero/contracts';
import { api, ApiError, dateTime, points, useCommand } from './api';
import { CommandNotice, ErrorNotice, Loading, PointField } from './components';
import type { Agent, ListResult, UserWallet, Wallet } from './types';
import { GAME_PROTOCOL, gameMessage, readGameFiles } from './game-bridge';
import common from './style.module.css';
import styles from './games.module.css';

type Items<T> = { items: T[] };
const statusLabel = { playing: '游戏中', submitted: '等待发布者结算', settled: '已结算', refunded: '已退款' };
function useGameCommand() {
  const command = useCommand(), busy = useRef(false);
  const previous = useRef<(() => Promise<unknown>) | null>(null);
  const uncertain = command.error instanceof ApiError && command.error.uncertain;
  async function run<T>(path: string, method: string, body: unknown, success?: (data: T) => void | Promise<void>) {
    if (busy.current || uncertain) return;
    const execute = async () => {
      if (busy.current) return;
      busy.current = true;
      try { return await command.run<T>(path, method, body, success); } finally { busy.current = false; }
    };
    previous.current = execute;
    return execute();
  }
  return { command, run, locked: command.pending || uncertain, uncertain, retry: () => previous.current?.() };
}
function GameNotice({ action }: { action: ReturnType<typeof useGameCommand> }) {
  return <><CommandNotice command={action.command} />{action.uncertain && <button type="button" disabled={action.command.pending} onClick={() => void action.retry()}>核对并重试原操作</button>}</>;
}
function useAgents() {
  return useQuery({ queryKey: ['game-agents'], queryFn: async () => {
    const items: Agent[] = []; let cursor: string | null = null;
    do { const page: ListResult<Agent> = await api(`/agents?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); items.push(...page.items); cursor = page.next_cursor; } while (cursor);
    return items.filter(agent => agent.status === 'active' && !agent.deleted_at);
  } });
}
function AgentSelect({ value, onChange, agents, personal = false }: { value: string; onChange: (id: string) => void; agents: Agent[]; personal?: boolean }) {
  return <label className={common.field}>积分账户<select aria-label="游戏积分账户" required={!personal} value={value} onChange={event => onChange(event.target.value)}><option value="">{personal ? '我的钱包' : '选择自己的 Agent 钱包'}</option>{agents.map(agent => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>;
}
function gameAvailability(game: GameDto) {
  return game.status === 'paused' ? '发布者已暂停' : game.accepting_players ? '营业中' : '奖池不足 · 暂停接待';
}

function GameFrame({ game, session, onSubmitted, compact = false }: { game: GameDto; session?: GameSessionDto; onSubmitted?: (session: GameSessionDto) => void; compact?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null), busy = useRef(false);
  const [error, setError] = useState<Error | null>(null);
  const pending = useRef<{ score: string; reward_requested: string; request_id: string } | null>(null);
  const [retry, setRetry] = useState(false);
  const callback = useRef(onSubmitted); callback.current = onSubmitted;
  const sessionRef = useRef(session); sessionRef.current = session;
  const init = () => frame.current?.contentWindow?.postMessage({ protocol: GAME_PROTOCOL, type: 'init', mode: session ? 'play' : 'preview', session_id: session?.id ?? null, entry_fee: session?.entry_fee ?? game.entry_fee, max_reward: session?.max_reward ?? game.max_reward, settlement_rule: session?.settlement_rule ?? game.settlement_rule ?? 'manual' }, '*');
  const submitRef = useRef<() => Promise<void>>(async () => {});
  submitRef.current = async () => {
    const input = pending.current, current = sessionRef.current;
    if (!input || !current || busy.current) return;
    busy.current = true; setError(null);
    try {
      const result = await api<GameSessionDto>(`/games/sessions/${current.id}/score`, { method: 'POST', key: `game-result:${current.id}`, body: { score: input.score, reward_requested: input.reward_requested } });
      frame.current?.contentWindow?.postMessage({ protocol: GAME_PROTOCOL, type: 'result', request_id: input.request_id, ok: true, session: result }, '*');
      setRetry(false); callback.current?.(result);
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error('提交失败'); setError(failure);
      const uncertain = cause instanceof ApiError && cause.uncertain; setRetry(uncertain);
      frame.current?.contentWindow?.postMessage({ protocol: GAME_PROTOCOL, type: 'result', request_id: input.request_id, ok: false, error: failure.message }, '*');
      if (!uncertain) pending.current = null;
    } finally { busy.current = false; }
  };
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const message = gameMessage(event, frame.current?.contentWindow ?? null);
      if (!message) return;
      if (message.type === 'ready') { init(); return; }
      const current = sessionRef.current;
      if (!current || current.status !== 'playing') {
        frame.current?.contentWindow?.postMessage({ protocol: GAME_PROTOCOL, type: 'result', request_id: message.request_id, ok: false, error: current ? 'SESSION_CLOSED' : 'PREVIEW_ONLY' }, '*'); return;
      }
      if (pending.current || busy.current) return;
      pending.current = { score: message.score!, reward_requested: message.reward_requested!, request_id: message.request_id };
      void submitRef.current();
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
    // The frame is keyed by game/session, and the mutable session is read through its ref.
  }, [game.id, session?.id]);
  return <><iframe ref={frame} className={compact ? styles.preview : styles.screen} title={`${game.name} · ${session ? '游戏' : '预览'}`} src={game.entry_url} sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={init} /><ErrorNotice error={error} />{retry && <button type="button" onClick={() => void submitRef.current()}>重试本局分数提交</button>}</>;
}

function GamePlayer({ game, onClose, initialSession, initialPreview = false }: { game: GameDto; onClose: () => void; initialSession?: GameSessionDto; initialPreview?: boolean }) {
  const accounts = useAgents(), action = useGameCommand(), client = useQueryClient();
  const [agentId, setAgentId] = useState(initialSession?.player_agent_id ?? ''), [session, setSession] = useState(initialSession), [activeGame, setActiveGame] = useState(game);
  const [preview, setPreview] = useState(initialPreview), [viewport, setViewport] = useState(false), [nativeFullscreen, setNativeFullscreen] = useState(false);
  const userWallet = useQuery({ queryKey: ['user-wallet'], queryFn: () => api<UserWallet>('/wallet'), enabled: !preview && !agentId });
  const agentWallet = useQuery({ queryKey: ['wallet', agentId], queryFn: () => api<Wallet>(`/agents/${agentId}/wallet`), enabled: !preview && Boolean(agentId) });
  const paymentWallet = agentId ? agentWallet : userWallet, balance = paymentWallet.data?.available;
  const insufficient = balance !== undefined && BigInt(balance) < BigInt(game.entry_fee);
  const walletReady = balance !== undefined && !paymentWallet.isError;
  const [fullscreenError, setFullscreenError] = useState<Error | null>(null);
  const dialog = useRef<HTMLDivElement>(null), closer = useRef<HTMLButtonElement>(null);
  const fullscreen = viewport || nativeFullscreen, expanded = useRef(fullscreen); expanded.current = fullscreen;
  const exitFullscreen = useRef(() => {});
  exitFullscreen.current = () => {
    setViewport(false); setFullscreenError(null);
    if (document.fullscreenElement && dialog.current?.contains(document.fullscreenElement)) {
      void document.exitFullscreen().catch(() => setFullscreenError(new Error('暂时无法退出全屏，请使用浏览器的退出全屏按钮。')));
    }
  };
  const toggleFullscreen = async () => {
    if (fullscreen) { exitFullscreen.current(); return; }
    const player = dialog.current;
    if (!player) return;
    setFullscreenError(null); setViewport(true);
    if (player.requestFullscreen && !document.fullscreenElement) {
      try { await player.requestFullscreen(); setViewport(false); }
      catch { /* Keep the viewport layout when native fullscreen is unavailable or denied. */ }
    }
  };
  const status = useQuery({ queryKey: ['game-session', session?.id], queryFn: () => api<GameSessionDto>(`/games/sessions/${session!.id}`), enabled: Boolean(session), refetchInterval: query => ['playing', 'submitted'].includes(query.state.data?.status ?? session?.status ?? '') ? 5000 : false });
  const current = status.data ?? session;
  const terminal = Boolean(current && ['settled', 'refunded'].includes(current.status));
  const nextGame = useQuery({ queryKey: ['games', 'next-session', game.id], queryFn: () => api<GameDto>(`/games/${game.id}`), enabled: terminal, refetchInterval: terminal ? 10000 : false });
  const nextInsufficient = balance !== undefined && nextGame.data !== undefined && BigInt(balance) < BigInt(nextGame.data.entry_fee);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, player = dialog.current, overflow = document.body.style.overflow;
    if (document.pointerLockElement) document.exitPointerLock();
    document.body.style.overflow = 'hidden';
    closer.current?.focus();
    const syncFullscreen = () => setNativeFullscreen(Boolean(document.fullscreenElement && player?.contains(document.fullscreenElement)));
    const trap = (event: KeyboardEvent) => {
      // Escape is reserved for leaving fullscreen; closing the game is an explicit action.
      if (event.key === 'Escape') { event.preventDefault(); if (expanded.current || document.fullscreenElement && player?.contains(document.fullscreenElement)) exitFullscreen.current(); return; }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),iframe') ?? []);
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => {
      document.removeEventListener('keydown', trap); document.removeEventListener('fullscreenchange', syncFullscreen);
      document.body.style.overflow = overflow;
      if (document.fullscreenElement && player?.contains(document.fullscreenElement)) void document.exitFullscreen().catch(() => {});
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (!current?.id || !current.status) return;
    void Promise.all(['user-wallet', 'user-transactions', 'wallet', 'transactions', 'games', 'game-machine', 'game-sessions'].map(key => client.invalidateQueries({ queryKey: [key] })));
  }, [client, current?.id, current?.status]);
  const update = (value: GameSessionDto) => {
    setSession(value); client.setQueryData(['game-session', value.id], value);
  };
  return createPortal(<div className={styles.veil} data-game-playing><div className={`${styles.player} ${fullscreen ? styles.fullscreen : ''}`} ref={dialog} role="dialog" aria-modal="true" aria-label={game.name}>
    <header><div><h2>{game.name}</h2>{!current && !preview && <p className={styles.hint}>确认本局费用后开始游戏</p>}</div><div className={styles.controls}><button type="button" aria-pressed={fullscreen} onClick={() => void toggleFullscreen()}>{fullscreen ? '退出全屏' : '全屏游玩'}</button><button ref={closer} onClick={onClose} aria-label="关闭游戏">×</button></div></header>
    <ErrorNotice error={fullscreenError} />
    {preview ? <><div className={styles.playfield}><GameFrame key={`preview:${game.id}`} game={game} /></div><div className={styles.sessionStatus} role="status"><strong>免费预览</strong><span>不扣费、不发奖</span><button disabled={!game.accepting_players} onClick={() => setPreview(false)}>查看费用并游玩</button></div></> : !current ? <><p>{game.description}</p><div className={styles.numbers}><span>每局 {points(game.entry_fee)} 积分</span><span>最高奖励 {points(game.max_reward)}</span><span>{gameAvailability(game)}</span></div>
      <p className={styles.hint}>{game.settlement_rule === 'starlight_slots_v1' ? '星光老虎机 v1：每局 1 积分、最高奖励 3 积分，服务端自动核验派奖；开局后即使未提交，到期仍按本局规则结算。' : '开局冻结本局费用，发布者结算后入账；奖励由发布者核验。30 分钟未结算自动退款。'}奖励和退款均回到本局所选钱包。</p>
      <form onSubmit={event => { event.preventDefault(); if (!walletReady || insufficient || !game.accepting_players) return; void action.run<GameSessionDto>(`/games/${game.id}/sessions`, 'POST', { ...(agentId ? { agent_id: agentId } : {}), game_version: game.version }, update); }}><fieldset disabled={action.locked}><AgentSelect personal value={agentId} onChange={setAgentId} agents={accounts.data ?? []} />
        {agentId && <p className={styles.hint}>所选 Agent 需开启资产交易权限并有足够额度。</p>}
        <div className={styles.row}><span>{paymentWallet.isPending ? '正在读取钱包…' : balance !== undefined ? `${agentId ? 'Agent 钱包' : '我的钱包'}可用 ${points(balance)} 积分` : '暂时无法读取钱包'}</span><button type="button" className={common.secondary} disabled={paymentWallet.isFetching} onClick={() => void paymentWallet.refetch()}>刷新余额</button></div>
        {insufficient && <p className={styles.hint}>所选钱包可用积分不足，请补充积分或选择其他钱包。</p>}
        <button disabled={!walletReady || insufficient || !game.accepting_players}>确认支付 {points(game.entry_fee)} 积分并开始</button></fieldset></form><ErrorNotice error={paymentWallet.error ?? (agentId ? accounts.error : null)} /><GameNotice action={action} /></>
      : <><div className={styles.playfield}><GameFrame key={current.id} game={activeGame} session={current} onSubmitted={value => void update(value)} /></div>
        <div className={`${styles.sessionStatus} ${terminal ? styles.finalStatus : ''}`} role="status" aria-live="polite" aria-atomic="true"><strong>{statusLabel[current.status]}</strong>{current.score !== null && <span>游戏分数：{current.score}</span>}{current.status === 'submitted' && <span>申请奖励 {points(current.reward_requested ?? '0')} 积分，等待发布者核验。</span>}{current.status === 'settled' && current.reward_points !== null && <span>实际奖励：{points(current.reward_points)} 积分（已入账）</span>}{current.status === 'refunded' && <span>本局费用 {points(current.entry_fee)} 积分已退回钱包。</span>}</div>
        {terminal && <div className={styles.nextRound}><button disabled={action.locked || !walletReady || nextInsufficient || nextGame.isFetching || nextGame.isError || !nextGame.data?.accepting_players} onClick={() => {
          const next = nextGame.data;
          if (!next?.accepting_players || nextGame.isFetching || action.locked || !walletReady || nextInsufficient) return;
          void action.run<GameSessionDto>(`/games/${game.id}/sessions`, 'POST', { ...(current.player_agent_id ? { agent_id: current.player_agent_id } : {}), game_version: next.version }, value => { setActiveGame(next); update(value); });
        }}>{action.command.pending ? '正在开局…' : `再来一局 · ${points(nextGame.data?.entry_fee ?? game.entry_fee)} 积分`}</button><span>沿用本局{current.player_agent_id ? ' Agent 积分账户' : '个人钱包'}{nextGame.data && !nextGame.data.accepting_players ? ` · ${gameAvailability(nextGame.data)}` : ''}</span>{nextGame.data && <span>下一局：{nextGame.data.settlement_rule === 'starlight_slots_v1' ? '平台自动结算' : '发布者核验结算'}</span>}{nextInsufficient && <span>钱包可用积分不足，请补充积分后刷新余额。</span>}<button type="button" className={common.secondary} disabled={paymentWallet.isFetching || action.locked} onClick={() => void paymentWallet.refetch()}>刷新余额</button><ErrorNotice error={nextGame.error ?? paymentWallet.error} /></div>}
        <details className={styles.sessionInfo}><summary>本局费用与结算说明</summary><div className={styles.numbers}><span>支付来源：{current.player_agent_id ? 'Agent 钱包' : '我的钱包'}</span><span>费用 {points(current.entry_fee)}</span><span>本局最高奖励 {points(current.max_reward)}</span><span>{current.settlement_rule === 'starlight_slots_v1' ? '星光老虎机 v1 · 平台自动结算' : '发布者核验结算'}</span><span>结算期限 {dateTime(current.expires_at)}</span></div><p className={styles.hint}>奖励和退款均回到本局所选钱包。关闭窗口不会再次扣费。可在游戏工坊的“我的对局”恢复游戏或查看结算。最终到账以此处状态为准。</p></details>
        {['playing', 'submitted'].includes(current.status) && new Date(current.expires_at).getTime() <= Date.now() && <button disabled={action.locked} onClick={() => void action.run<GameSessionDto>(`/games/sessions/${current.id}/refund`, 'POST', {}, update)}>{current.settlement_rule === 'starlight_slots_v1' ? '完成超时结算' : '领取超时退款'}</button>}
        <GameNotice action={action} /><ErrorNotice error={status.error} /></>}
  </div></div>, document.body);
}

export function ArcadeMachine({ land, placement, userId, onPlayingChange }: { land: WorldLand; placement: WorldModelPlacement; userId?: string; onPlayingChange?: (active: boolean) => void }) {
  const client = useQueryClient(), action = useGameCommand();
  const machine = useQuery({ queryKey: ['game-machine', placement.id, land.version], queryFn: () => api<GameMachineDto>(`/games/machines/${placement.id}`), refetchInterval: 10000 });
  const owner = land.owner?.id === userId, [editing, setEditing] = useState(false), [selected, setSelected] = useState(''), [playing, setPlaying] = useState(false), [previewing, setPreviewing] = useState(false);
  const library = useQuery({ queryKey: ['games'], queryFn: () => api<Items<GameDto>>('/games'), enabled: owner && editing });
  const pinned = useRef<GameDto | null>(null);
  useEffect(() => () => onPlayingChange?.(false), [onPlayingChange]);
  const play = (preview = false) => { if (!machine.data?.game) return; pinned.current = machine.data.game; setPreviewing(preview); setPlaying(true); onPlayingChange?.(true); };
  const close = () => { setPlaying(false); onPlayingChange?.(false); pinned.current = null; };
  const game = machine.data?.game;
  return <div className={styles.machine}><h3>{game?.name ?? '游戏机'}</h3><ErrorNotice error={machine.error} />
    {game ? <><p>{game.description}</p><span className={styles.badge}>{gameAvailability(game)}</span>{!playing && <GameFrame key={game.id} compact game={game} />}<p>每局 {points(game.entry_fee)} 积分 · 最高奖励 {points(game.max_reward)}</p><div className={styles.controls}><button className={common.secondary} onClick={() => play(true)}>放大免费预览</button><button onClick={() => play()} disabled={!game.accepting_players}>查看费用并游玩</button></div></> : <p>{machine.isPending ? '正在连接游戏机…' : '还没有装入游戏。'}</p>}
    {owner && !playing && <><button className={common.secondary} disabled={Boolean(land.listing)} onClick={() => setEditing(value => !value)}>{editing ? '收起设置' : '设置游戏'}</button>{editing && <form onSubmit={event => { event.preventDefault(); void action.run<GameMachineDto>(`/games/machines/${placement.id}`, 'PUT', { game_id: selected || null }, async () => { await client.invalidateQueries({ queryKey: ['game-machine', placement.id] }); setEditing(false); }); }}><fieldset disabled={action.locked}><label className={common.field}>装入游戏<select aria-label="装入游戏" value={selected} onChange={event => setSelected(event.target.value)}><option value="">取出当前游戏</option>{library.data?.items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button>保存游戏机设置</button></fieldset><GameNotice action={action} /><ErrorNotice error={library.error} /><Link to="/games">到游戏工坊发布游戏 →</Link></form>}</>}
    {playing && pinned.current && <GamePlayer game={pinned.current} initialPreview={previewing} onClose={close} />}
  </div>;
}

function GamePublisher({ onCreated }: { onCreated: () => void }) {
  const accounts = useAgents(), action = useGameCommand(), client = useQueryClient();
  const [agentId, setAgentId] = useState(''), [name, setName] = useState(''), [description, setDescription] = useState('');
  const [entryFee, setEntryFee] = useState('1'), [maxReward, setMaxReward] = useState('10'), [minimumPool, setMinimumPool] = useState('10');
  const [settlementRule, setSettlementRule] = useState<GameSettlementRuleId>('manual');
  const [kind, setKind] = useState<'url' | 'bundle'>('url'), [url, setUrl] = useState(''), [entry, setEntry] = useState('index.html');
  const [files, setFiles] = useState<Extract<GameSourceInput, { type: 'bundle' }>['files']>([]), [fileError, setFileError] = useState<Error | null>(null), [reading, setReading] = useState(false);
  const folder = useRef<HTMLInputElement>(null);
  useEffect(() => { folder.current?.setAttribute('webkitdirectory', ''); }, [kind]);
  const load = async (selected: FileList | null) => {
    if (!selected) return; setReading(true); setFileError(null);
    try { const content = await readGameFiles(Array.from(selected)); setFiles(content); setEntry(content.some(file => file.path === 'index.html') ? 'index.html' : content.find(file => file.mime === 'text/html')?.path ?? ''); }
    catch (cause) { setFiles([]); setFileError(cause instanceof Error ? cause : new Error('读取失败')); }
    finally { setReading(false); }
  };
  return <section className={styles.card} aria-label="发布游戏"><h2>发布你的游戏</h2><form onSubmit={event => { event.preventDefault();
    const source = kind === 'url' ? { type: 'url' as const, url } : { type: 'bundle' as const, entry, files };
    void action.run<GameDto>('/games', 'POST', { agent_id: agentId, name: name.trim(), description: description.trim(), entry_fee: entryFee, max_reward: maxReward, minimum_pool: minimumPool, settlement_rule: settlementRule, source }, async () => { await client.invalidateQueries({ queryKey: ['games'] }); onCreated(); });
  }}><fieldset disabled={action.locked || reading}><AgentSelect value={agentId} onChange={setAgentId} agents={accounts.data ?? []} />
    <label className={common.field}>游戏名称<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label><label className={common.field}>游戏说明<textarea maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} placeholder="说明玩法、获奖条件及发布者如何核验结果" /></label>
    <label className={common.field}>结算方式<select value={settlementRule} onChange={event => { const rule = event.target.value as GameSettlementRuleId; setSettlementRule(rule); if (rule === 'starlight_slots_v1') { setEntryFee('1'); setMaxReward('3'); } }}><option value="manual">发布者核验结算</option><option value="starlight_slots_v1">星光老虎机 v1 · 平台自动结算</option></select></label>
    <div className={styles.row}>{settlementRule === 'starlight_slots_v1' ? <p>每局固定 1 积分，最高奖励 3 积分；平台计算结果并自动派奖，超时也按规则结算。</p> : <><PointField name="entry_fee" label="单局费用" positive value={entryFee} onChange={setEntryFee} /><PointField name="max_reward" label="单局最高奖励" positive value={maxReward} onChange={setMaxReward} /></>}<PointField name="minimum_pool" label="奖池开放门槛" positive value={minimumPool} onChange={setMinimumPool} /></div>
    <p className={styles.hint}>游玩收入进入此 Agent 钱包，奖励从其游戏奖池支出。开放门槛不能低于单局最高奖励；扣除在玩对局承诺后，余额低于门槛会自动停售，补足后恢复。</p>
    <label className={common.field}>游戏来源<select value={kind} onChange={event => setKind(event.target.value as 'url' | 'bundle')}><option value="url">HTTPS 网页</option><option value="bundle">HTML / JS / WASM 游戏包</option></select></label>
    {kind === 'url' ? <label className={common.field}>游戏网址<input type="url" required pattern="https://.*" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/game" /></label> : <><p className={styles.hint}>选择导出的网页游戏目录，或单个自包含 HTML 文件。最多 128 个文件，共 2 MB。</p><label className={common.field}>上传游戏目录<input type="file" ref={folder} multiple onChange={event => void load(event.target.files)} /></label><label className={common.field}>上传单个 HTML<input type="file" accept=".html,.htm" onChange={event => void load(event.target.files)} /></label><label className={common.field}>入口文件<select value={entry} onChange={event => setEntry(event.target.value)} required><option value="">选择 HTML 入口</option>{files.filter(file => file.mime === 'text/html').map(file => <option key={file.path}>{file.path}</option>)}</select></label><p className={styles.hint}>{files.length} 个文件已读取</p></>}
    <p className={styles.hint}>游戏创建后先暂停。存入奖池并启用后，即可装入室内或室外的游戏机。</p><button disabled={!agentId || !name.trim() || kind === 'bundle' && !files.length}>创建游戏</button>
  </fieldset><GameNotice action={action} /><ErrorNotice error={fileError ?? accounts.error} /></form></section>;
}

function SessionRow({ session, author = false, onPlay }: { session: GameSessionDto; author?: boolean; onPlay?: () => void }) {
  const action = useGameCommand(), client = useQueryClient();
  const [reward, setReward] = useState(session.reward_requested ?? '0'), [reason, setReason] = useState('按已公布规则核验本局结果');
  const terminal = ['settled', 'refunded'].includes(session.status), expired = new Date(session.expires_at).getTime() <= Date.now();
  const refresh = async () => { await Promise.all(['user-wallet', 'user-transactions', 'wallet', 'transactions', 'game-sessions', 'games', 'game-machine'].map(key => client.invalidateQueries({ queryKey: [key] }))); };
  return <article className={styles.session}><div className={styles.row}><strong>{statusLabel[session.status]}</strong><small>费用 {points(session.entry_fee)} · 最高奖励 {points(session.max_reward)}</small></div><code>{session.id}</code><p>分数 {session.score ?? '未提交'} · 申请奖励 {session.reward_requested ?? '0'} · 实际奖励 {session.reward_points ?? '待结算'}</p><small>到期 {dateTime(session.expires_at)}</small>
    {!terminal && !expired && !author && onPlay && <button onClick={onPlay}>恢复对局</button>}
    {author && session.settlement_rule === 'manual' && session.status === 'submitted' && !expired && <form onSubmit={event => { event.preventDefault(); void action.run(`/games/sessions/${session.id}/settle`, 'POST', { reward_points: reward, reason }, refresh); }}><fieldset disabled={action.locked}><div className={styles.row}><PointField name="reward_points" label="本局实际奖励" value={reward} onChange={setReward} /><label className={common.field}>结算说明<input required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label><button>核验并结算</button></div></fieldset></form>}
    {!terminal && expired && <button disabled={action.locked} onClick={() => void action.run(`/games/sessions/${session.id}/refund`, 'POST', {}, refresh)}>{session.settlement_rule === 'starlight_slots_v1' ? '完成超时结算' : '超时退款'}</button>}<GameNotice action={action} />
  </article>;
}
function GameManagement({ game }: { game: GameDto }) {
  const client = useQueryClient(), funds = useGameCommand(), state = useGameCommand();
  const [amount, setAmount] = useState(''), [operation, setOperation] = useState<'fund' | 'withdraw'>('fund'), [threshold, setThreshold] = useState(game.minimum_pool), [opened, setOpened] = useState(false);
  const [settlementRule, setSettlementRule] = useState<GameSettlementRuleId>(game.settlement_rule);
  const sessions = useQuery({ queryKey: ['game-sessions', 'author', game.id], queryFn: () => api<Items<GameSessionDto>>(`/games/${game.id}/sessions`), enabled: opened, refetchInterval: opened ? 10000 : false });
  const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['games'] }), client.invalidateQueries({ queryKey: ['game-machine'] })]); };
  return <details className={styles.manage} onToggle={event => setOpened(event.currentTarget.open)}><summary>管理奖池与结算</summary>
    <div className={styles.numbers}><span>奖池 {points(game.pool_balance)}</span><span>已承诺 {points(game.pool_committed)}</span><span>可提取 {points(game.available_pool)}</span></div>
    <form onSubmit={event => { event.preventDefault(); void funds.run<GameDto>(`/games/${game.id}/${operation}`, 'POST', { amount }, refresh); }}><fieldset disabled={funds.locked}><div className={styles.row}><label className={common.field}>奖池操作<select value={operation} onChange={event => setOperation(event.target.value as 'fund' | 'withdraw')}><option value="fund">从发布者钱包存入</option><option value="withdraw">提现到发布者钱包</option></select></label><PointField name="amount" label="操作积分" positive value={amount} onChange={setAmount} /><button>{operation === 'fund' ? '存入奖池' : '提取可用积分'}</button></div></fieldset><GameNotice action={funds} /></form>
    <form onSubmit={event => { event.preventDefault(); void state.run<GameDto>(`/games/${game.id}`, 'PATCH', { version: game.version, status: game.status, minimum_pool: threshold, settlement_rule: settlementRule }, refresh); }}><fieldset disabled={state.locked}><div className={styles.row}><label className={common.field}>结算方式<select value={settlementRule} onChange={event => setSettlementRule(event.target.value as GameSettlementRuleId)}><option value="manual">发布者核验结算</option><option value="starlight_slots_v1" disabled={game.entry_fee !== '1' || game.max_reward !== '3'}>星光老虎机 v1 · 平台自动结算</option></select></label><PointField name="minimum_pool" label="开放门槛" positive value={threshold} onChange={setThreshold} /><button>保存规则与门槛</button><button type="button" onClick={() => void state.run<GameDto>(`/games/${game.id}`, 'PATCH', { version: game.version, status: game.status === 'active' ? 'paused' : 'active' }, refresh)}>{game.status === 'active' ? '手动暂停' : '启用游戏'}</button></div><p className={styles.hint}>星光老虎机 v1 仅适用于每局 1 积分、最高奖励 3 积分的游戏，启用后由平台计算结果并自动派奖。</p></fieldset><GameNotice action={state} /></form>
    <p className={styles.hint}>提现仅使用未承诺积分。启用后可用奖池低于 {points(game.minimum_pool)} 积分时自动停售，补足即恢复。</p>
    <h3>对局与奖励申请</h3><ErrorNotice error={sessions.error} />{sessions.data?.items.map(session => <SessionRow key={`${session.id}:${session.status}`} session={session} author />)}{sessions.data?.items.length === 0 && <p>还没有对局。</p>}
  </details>;
}

export function GameLibrary({ userId }: { userId?: string }) {
  const [tab, setTab] = useState<'all' | 'mine' | 'sessions'>('all'), [creating, setCreating] = useState(false);
  const [playing, setPlaying] = useState<{ game: GameDto; session?: GameSessionDto; preview?: boolean } | null>(null), [openError, setOpenError] = useState<Error | null>(null);
  const games = useQuery({ queryKey: ['games', tab], queryFn: () => api<Items<GameDto>>(`/games${tab === 'mine' ? '?mine=true' : ''}`), enabled: tab !== 'sessions', refetchInterval: 10000 });
  const sessions = useQuery({ queryKey: ['game-sessions', 'mine'], queryFn: () => api<Items<GameSessionDto>>('/games/sessions?mine=true'), enabled: tab === 'sessions', refetchInterval: 10000 });
  const resume = async (session: GameSessionDto) => {
    setOpenError(null);
    try { const game = await api<GameDto>(`/games/${session.game_id}`); setPlaying({ game, session }); }
    catch (cause) { setOpenError(cause instanceof Error ? cause : new Error('无法恢复对局')); }
  };
  return <div className={styles.library}><header className={styles.heading}><div><div className={common.eyebrow}>CREATE · PLAY · SHARE</div><h1>游戏工坊</h1><p>把自己的网页游戏装进小镇的游戏机，与玩家和 Agent 一起游玩。</p></div><button onClick={() => setCreating(value => !value)}>{creating ? '收起发布表单' : '发布游戏'}</button></header>
    <p className={styles.hint}><a href="/game-sdk.js" download>下载游戏接入 SDK</a> · <a href="/games-demo.html" download>下载示例 HTML</a> · <Link to="/world">返回小镇摆放游戏机 →</Link></p>
    {creating && <GamePublisher onCreated={() => { setCreating(false); setTab('mine'); }} />}
    <div className={styles.tabs}>{([['all', '可玩游戏'], ['mine', '我的作品'], ['sessions', '我的对局']] as const).map(([value, label]) => <button className={common.secondary} key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}</div>
    <ErrorNotice error={openError ?? (tab === 'sessions' ? sessions.error : games.error)} />
    {tab === 'sessions' ? <section className={styles.card}>{sessions.isPending ? <Loading /> : sessions.data?.items.map(session => <SessionRow key={`${session.id}:${session.status}`} session={session} onPlay={() => void resume(session)} />)}{sessions.data?.items.length === 0 && <p>还没有游戏记录。</p>}</section> : <>{games.isPending && <Loading />}<div className={styles.grid}>{games.data?.items.map(game => <article key={game.id} className={styles.card}><span className={styles.badge}>{gameAvailability(game)}</span><h2>{game.name}</h2><p>{game.description || '发布者尚未填写游戏说明。'}</p><div className={styles.numbers}><span>每局 {points(game.entry_fee)} 积分</span><span>最高奖励 {points(game.max_reward)}</span></div><div className={styles.controls}><button className={common.secondary} onClick={() => setPlaying({ game, preview: true })}>免费预览</button><button disabled={!game.accepting_players} onClick={() => setPlaying({ game })}>查看费用并游玩</button></div>{game.owner_user_id === userId && <GameManagement game={game} />}</article>)}</div>{games.data?.items.length === 0 && <p className={styles.empty}>还没有游戏。发布一个网页，或上传你的浏览器游戏包。</p>}</>}
    {playing && <GamePlayer game={playing.game} initialSession={playing.session} initialPreview={playing.preview} onClose={() => setPlaying(null)} />}
  </div>;
}
