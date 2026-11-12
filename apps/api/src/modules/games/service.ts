import { randomUUID } from 'node:crypto';
import type { Actor, AdminGameModerationInput, CreateGameInput, GameDto, GameSessionDto, GameSettlementRuleId, GameSourceInput, PatchGameInput, SettleGameSessionInput, SubmitGameScoreInput } from '@agentzero/contracts';
import { GAME_BUNDLE_MAX_BYTES, parseAmount } from '@agentzero/contracts';
import type { Tx } from '@agentzero/database';
import { AppError, audit, lockActor, type CommandResult } from '../../core.js';
import { adjustHold, captureHold, finalizeHold, reserve } from '../ledger/service.js';
import { starlightSlotsResult } from './rules.js';

type GameSourceMetadata = { type: 'url'; url: string } | { type: 'bundle'; entry: string };
interface GameRow extends Omit<GameDto, 'source_type' | 'entry_url' | 'available_pool' | 'accepting_players'> { source: GameSourceMetadata; pool_hold_id: string | null; author_available: boolean }
interface SessionRow extends GameSessionDto { fee_hold_id: string; game_version: string }
const gameFields = `id,author_agent_id,owner_user_id,name,description,entry_fee::text,max_reward::text,minimum_pool::text,settlement_rule,status,moderation_blocked,version::text,pool_balance::text,pool_committed::text,pool_hold_id,source-'files' AS source,created_at,
  (SELECT a.status='active' AND a.deleted_at IS NULL AND u.status='active' FROM agents a JOIN users u ON u.id=a.owner_user_id WHERE a.id=author_agent_id) AS author_available`;
const sessionFields = 'id,game_id,player_agent_id,player_user_id,fee_hold_id,game_version::text,entry_fee::text,max_reward::text,settlement_rule,status,score::text,reward_requested::text,reward_points::text,expires_at,created_at';
const userId = (actor: Actor) => actor.type === 'user' ? actor.userId : actor.type === 'agent' ? actor.ownerUserId : null;
const result = (body: GameDto | GameSessionDto | Record<string, unknown>, status = 200): CommandResult => ({ status, body: { ...body } });
const system = (requestId: string) => ({ actor: { type: 'system' as const }, requestId });
const amount = (value: string, positive = false) => {
  try { return parseAmount(value, positive); } catch { throw new AppError('INVALID_AMOUNT'); }
};

export const GAME_MIME: Record<string, string> = {
  html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', wasm: 'application/wasm',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
};
export const validGamePath = (path: string) => path.length <= 200 && /^[a-zA-Z0-9_./-]+$/.test(path)
  && !path.startsWith('/') && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');

function validateSource(source: GameSourceInput): GameSourceInput {
  if (source.type === 'url') {
    let url: URL;
    try { url = new URL(source.url); } catch { throw new AppError('INVALID_INPUT', 400, '游戏网页地址无效'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new AppError('INVALID_INPUT', 400, '游戏网页必须使用不含凭证的 HTTPS 地址');
    return { type: 'url', url: url.href };
  }
  const paths = new Set<string>(); let size = 0;
  for (const file of source.files) {
    const mime = GAME_MIME[file.path.split('.').at(-1)?.toLowerCase() ?? ''];
    if (!validGamePath(file.path) || paths.has(file.path) || !mime || file.mime !== mime
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content))
      throw new AppError('INVALID_INPUT', 400, '游戏包路径、文件类型或 Base64 内容无效');
    size += Buffer.from(file.content, 'base64').length; paths.add(file.path);
  }
  if (size > GAME_BUNDLE_MAX_BYTES) throw new AppError('GAME_BUNDLE_TOO_LARGE', 400, '游戏包解码后不能超过 2 MiB');
  if (!paths.has(source.entry) || !/\.html?$/i.test(source.entry)) throw new AppError('INVALID_INPUT', 400, '游戏入口必须是包内 HTML 文件');
  return source;
}
function validateRule(rule: GameSettlementRuleId, entryFee: string, maxReward: string) {
  if (rule === 'starlight_slots_v1' && (entryFee !== '1' || maxReward !== '3'))
    throw new AppError('INVALID_INPUT', 400, '星光老虎机 v1 规则要求单局费用为 1 积分、最高奖励为 3 积分');
}

function dto(game: GameRow): GameDto {
  const { source, pool_hold_id: _hold, author_available: authorAvailable, ...publicGame } = game;
  const available = BigInt(game.pool_balance) - BigInt(game.pool_committed);
  return { ...publicGame, created_at: new Date(game.created_at).toISOString(), source_type: source.type,
    entry_url: game.moderation_blocked ? '' : source.type === 'url' ? source.url : `/game-content/${game.id}/${source.entry}`,
    available_pool: available.toString(), accepting_players: !game.moderation_blocked && authorAvailable && game.status === 'active' && available >= BigInt(game.minimum_pool) };
}
function sessionDto(session: SessionRow): GameSessionDto {
  const { fee_hold_id: _hold, game_version: _version, ...publicSession } = session;
  return { ...publicSession, created_at: new Date(session.created_at).toISOString(), expires_at: new Date(session.expires_at).toISOString() };
}
async function gameRow(tx: Tx, id: string, lock = false): Promise<GameRow> {
  const row = (await tx.query<GameRow>(`SELECT ${gameFields} FROM arcade_games WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, '游戏不存在');
  return row;
}
const isAuthor = (actor: Actor, game: GameRow) => userId(actor) === game.owner_user_id && (actor.type === 'user' || actor.type === 'agent' && actor.agentId === game.author_agent_id);
const isPlayer = (actor: Actor, session: SessionRow) => userId(actor) === session.player_user_id && (actor.type === 'user' || actor.type === 'agent' && actor.agentId === session.player_agent_id);
function requireAuthor(actor: Actor, game: GameRow) { if (!isAuthor(actor, game)) throw new AppError('ACCESS_DENIED', 403); }
function requirePlayer(actor: Actor, session: SessionRow) { if (!isPlayer(actor, session)) throw new AppError('ACCESS_DENIED', 403); }
function requireParticipant(actor: Actor, game: GameRow, session: SessionRow) {
  if (!isAuthor(actor, game) && !isPlayer(actor, session)) throw new AppError('ACCESS_DENIED', 403);
}
async function sessionRow(tx: Tx, id: string, lock = false): Promise<SessionRow> {
  const row = (await tx.query<SessionRow>(`SELECT ${sessionFields} FROM arcade_game_sessions WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, '游戏对局不存在');
  return row;
}
async function lockedSession(tx: Tx, id: string) {
  const first = await sessionRow(tx, id), game = await gameRow(tx, first.game_id, true);
  return { game, session: await sessionRow(tx, id, true) };
}
async function expired(tx: Tx, session: SessionRow) {
  return (await tx.query<{ expired: boolean }>('SELECT $1::timestamptz<=clock_timestamp() AS expired', [session.expires_at])).rows[0]!.expired;
}

export async function listGames(tx: Tx, actor: Actor, mine: boolean) {
  const rows = (await tx.query<GameRow>(`SELECT ${gameFields} FROM arcade_games WHERE ${mine ? 'owner_user_id=$1' : "(status='active' AND NOT moderation_blocked) OR owner_user_id=$1"} ORDER BY created_at DESC,id LIMIT 100`, [userId(actor)])).rows;
  return { items: rows.map(dto) };
}
export async function getGame(tx: Tx, id: string) { return dto(await gameRow(tx, id)); }
export async function readGame(tx: Tx, actor: Actor, id: string, admin = false) {
  const game = await gameRow(tx, id);
  if (!game.moderation_blocked || admin || isAuthor(actor, game)) return dto(game);
  const participant = await tx.query(`SELECT 1 FROM arcade_game_sessions WHERE game_id=$1 AND ${actor.type === 'agent' ? 'player_agent_id=$2' : 'player_user_id=$2'} LIMIT 1`,
    [id, actor.type === 'agent' ? actor.agentId : userId(actor)]);
  if (!participant.rowCount) throw new AppError('NOT_FOUND', 404);
  // Previous players can reopen their receipts and refund controls without redisplaying removed content.
  return { ...dto(game), name: '已下架游戏', description: '' };
}
export async function adminGames(tx: Tx) {
  return { items: (await tx.query<GameRow>(`SELECT ${gameFields} FROM arcade_games ORDER BY created_at DESC,id`)).rows.map(dto) };
}
export async function moderateGame(tx: Tx, actor: Actor, requestId: string, id: string, input: AdminGameModerationInput) {
  const game = await gameRow(tx, id, true);
  if (game.version !== input.version) throw new AppError('GAME_VERSION_CONFLICT', 409, '游戏已更新，请刷新后重试');
  await tx.query('UPDATE arcade_games SET moderation_blocked=$2,version=version+1 WHERE id=$1', [id, input.moderation_blocked]);
  await audit(tx, actor, 'admin.game_moderated', 'game', id, requestId, { ...input, previous_moderation_blocked: game.moderation_blocked });
  // Only availability changes. Existing sessions retain their terms, fees, rewards and timeout settlement path.
  return result(await getGame(tx, id));
}
export async function getGameContent(tx: Tx, id: string, path: string) {
  const game = (await tx.query<{ source: GameSourceInput }>('SELECT source FROM arcade_games WHERE id=$1 AND NOT moderation_blocked', [id])).rows[0];
  if (!game || game.source.type !== 'bundle' || !validGamePath(path)) throw new AppError('NOT_FOUND', 404);
  const file = game.source.files.find(item => item.path === path);
  if (!file) throw new AppError('NOT_FOUND', 404);
  return { mime: file.mime, data: Buffer.from(file.content, 'base64') };
}
export async function createGame(tx: Tx, actor: Actor, requestId: string, input: CreateGameInput) {
  await lockActor(tx, actor, { agentId: input.agent_id });
  amount(input.entry_fee, true); const max = amount(input.max_reward, true), minimum = amount(input.minimum_pool ?? input.max_reward, true);
  if (minimum < max) throw new AppError('INVALID_INPUT', 400, '最低开放奖池不能小于单局最高奖励');
  const source = validateSource(input.source), id = randomUUID(), rule = input.settlement_rule ?? 'manual';
  validateRule(rule, input.entry_fee, input.max_reward);
  await tx.query(`INSERT INTO arcade_games(id,author_agent_id,owner_user_id,name,description,entry_fee,max_reward,minimum_pool,source,settlement_rule)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, input.agent_id, userId(actor), input.name.trim(), input.description.trim(), input.entry_fee, input.max_reward, minimum.toString(), JSON.stringify(source), rule]);
  await audit(tx, actor, 'game.created', 'game', id, requestId, { source_type: source.type, name: input.name.trim(), entry_fee: input.entry_fee, max_reward: input.max_reward, minimum_pool: minimum.toString(), settlement_rule: rule });
  return result(await getGame(tx, id), 201);
}
export async function patchGame(tx: Tx, actor: Actor, requestId: string, id: string, input: PatchGameInput) {
  const game = await gameRow(tx, id, true); requireAuthor(actor, game);
  if (game.version !== input.version) throw new AppError('GAME_VERSION_CONFLICT', 409);
  if (input.minimum_pool && amount(input.minimum_pool, true) < BigInt(game.max_reward)) throw new AppError('INVALID_INPUT', 400, '最低开放奖池不能小于单局最高奖励');
  validateRule(input.settlement_rule ?? game.settlement_rule, game.entry_fee, game.max_reward);
  const source = input.source ? validateSource(input.source) : undefined;
  await tx.query(`UPDATE arcade_games SET status=COALESCE($2,status),minimum_pool=COALESCE($3,minimum_pool),
    settlement_rule=COALESCE($4,settlement_rule),description=COALESCE($5,description),source=COALESCE($6::jsonb,source),version=version+1 WHERE id=$1`,
  [id, input.status ?? null, input.minimum_pool ?? null, input.settlement_rule ?? null, input.description?.trim() ?? null, source ? JSON.stringify(source) : null]);
  const { source: _source, ...details } = input;
  await audit(tx, actor, 'game.updated', 'game', id, requestId, { ...details, ...(source ? { source_type: source.type } : {}) }); return result(await getGame(tx, id));
}
export async function fundGame(tx: Tx, actor: Actor, requestId: string, id: string, value: string) {
  const game = await gameRow(tx, id, true); requireAuthor(actor, game);
  const total = BigInt(game.pool_balance) + amount(value, true); amount(total.toString(), true);
  const ctx = { actor, requestId };
  let holdId = game.pool_hold_id;
  if (BigInt(game.pool_balance) === 0n) {
    const hold = await reserve(tx, ctx, { businessRef: `game:${id}:pool:${requestId}`, payerAgentId: game.author_agent_id, amount: value, permission: 'can_trade', reason: `为游戏「${game.name}」存入奖池` });
    holdId = String(hold.holdId);
  } else await adjustHold(tx, ctx, { holdId: holdId!, amount: total.toString(), revision: requestId, permission: 'can_trade', reason: `为游戏「${game.name}」增加奖池` });
  await tx.query('UPDATE arcade_games SET pool_balance=$2,pool_hold_id=$3 WHERE id=$1', [id, total.toString(), holdId]);
  await audit(tx, actor, 'game.funded', 'game', id, requestId, { amount: value }); return result(await getGame(tx, id));
}
export async function withdrawGame(tx: Tx, actor: Actor, requestId: string, id: string, value: string) {
  const game = await gameRow(tx, id, true); requireAuthor(actor, game);
  const withdrawal = amount(value, true);
  if (withdrawal > BigInt(game.pool_balance) - BigInt(game.pool_committed)) throw new AppError('GAME_POOL_COMMITTED', 409, '只能取出未为进行中对局锁定的积分');
  await captureHold(tx, { actor, requestId }, { holdId: game.pool_hold_id!, payments: [], refund: value, businessKey: `game:${id}:withdraw:${requestId}`, reason: `取出游戏「${game.name}」未承诺奖池` });
  await tx.query('UPDATE arcade_games SET pool_balance=pool_balance-$2::bigint WHERE id=$1', [id, value]);
  await audit(tx, actor, 'game.withdrawn', 'game', id, requestId, { amount: value }); return result(await getGame(tx, id));
}

export async function getMachine(tx: Tx, placementId: string) {
  const model = (await tx.query('SELECT m.model_id FROM world_model_placements m JOIN land_plots l ON l.id=m.land_id WHERE m.id=$1 AND NOT l.showcase_hidden', [placementId])).rows[0];
  if (!model || model.model_id !== 'arcade') throw new AppError('NOT_FOUND', 404, '游戏机不存在');
  const row = (await tx.query<{ game_id: string }>('SELECT game_id FROM arcade_game_machines WHERE placement_id=$1', [placementId])).rows[0];
  const game = row ? await getGame(tx, row.game_id) : null;
  return { placement_id: placementId, game: game?.moderation_blocked ? null : game };
}
export async function bindMachine(tx: Tx, actor: Actor, requestId: string, placementId: string, gameId: string | null) {
  const model = (await tx.query('SELECT land_id,model_id FROM world_model_placements WHERE id=$1', [placementId])).rows[0];
  if (!model || model.model_id !== 'arcade') throw new AppError('NOT_FOUND', 404, '游戏机不存在');
  const land = (await tx.query('SELECT owner_user_id,owner_agent_id,showcase_hidden FROM land_plots WHERE id=$1 FOR UPDATE', [model.land_id])).rows[0];
  if (land.owner_user_id !== userId(actor) || actor.type === 'agent' && actor.agentId !== land.owner_agent_id) throw new AppError('ACCESS_DENIED', 403);
  if (land.showcase_hidden) throw new AppError('CONTENT_MODERATED', 409, '此地块展示已被管理员屏蔽');
  if ((await tx.query("SELECT 1 FROM market_listings WHERE land_id=$1 AND status='active'", [model.land_id])).rowCount) throw new AppError('ASSET_LISTED', 409);
  // Recheck the placement after obtaining the same land lock as placement deletion.
  if (!(await tx.query('SELECT 1 FROM world_model_placements WHERE id=$1 AND land_id=$2', [placementId, model.land_id])).rowCount) throw new AppError('NOT_FOUND', 404);
  if (gameId) {
    await gameRow(tx, gameId);
    await tx.query('INSERT INTO arcade_game_machines(placement_id,game_id) VALUES($1,$2) ON CONFLICT(placement_id) DO UPDATE SET game_id=EXCLUDED.game_id', [placementId, gameId]);
  } else await tx.query('DELETE FROM arcade_game_machines WHERE placement_id=$1', [placementId]);
  await audit(tx, actor, 'game.machine_bound', 'world_model_placement', placementId, requestId, { game_id: gameId });
  return result(await getMachine(tx, placementId));
}

export async function startSession(tx: Tx, actor: Actor, requestId: string, id: string, agentId: string | undefined, version: string) {
  if (!agentId && actor.type !== 'user') throw new AppError('ACCESS_DENIED', 403, '只有用户本人可以使用个人钱包');
  await lockActor(tx, actor, { agentId });
  const game = await gameRow(tx, id, true);
  if (game.version !== version) throw new AppError('GAME_VERSION_CONFLICT', 409);
  const author = (await tx.query('SELECT a.status,a.deleted_at,u.status AS user_status FROM agents a JOIN users u ON u.id=a.owner_user_id WHERE a.id=$1', [game.author_agent_id])).rows[0];
  if (game.moderation_blocked || game.status !== 'active' || !author || author.status !== 'active' || author.deleted_at || author.user_status !== 'active') throw new AppError('GAME_UNAVAILABLE', 409);
  if (BigInt(game.pool_balance) - BigInt(game.pool_committed) < BigInt(game.minimum_pool)) throw new AppError('GAME_POOL_LOW', 409, '可用奖池低于最低开放额度，补足后自动恢复');
  const sessionId = randomUUID(), hold = await reserve(tx, { actor, requestId }, { businessRef: `game:${id}:session:${sessionId}`, payerAgentId: agentId ?? null,
    ...(!agentId && actor.type === 'user' ? { payerUserId: actor.userId } : {}), amount: game.entry_fee, permission: 'can_trade', reason: `游戏「${game.name}」单局费用` });
  await tx.query(`INSERT INTO arcade_game_sessions(id,game_id,player_agent_id,player_user_id,fee_hold_id,game_version,entry_fee,max_reward,settlement_rule)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [sessionId, id, agentId ?? null, userId(actor), hold.holdId, game.version, game.entry_fee, game.max_reward, game.settlement_rule]);
  await tx.query('UPDATE arcade_games SET pool_committed=pool_committed+$2::bigint WHERE id=$1', [id, game.max_reward]);
  await audit(tx, actor, 'game.session_started', 'game_session', sessionId, requestId, { game_id: id, entry_fee: game.entry_fee, max_reward: game.max_reward, settlement_rule: game.settlement_rule });
  return result(sessionDto(await sessionRow(tx, sessionId)), 201);
}
export async function getSession(tx: Tx, actor: Actor, id: string) {
  const session = await sessionRow(tx, id), game = await gameRow(tx, session.game_id);
  requireParticipant(actor, game, session);
  return sessionDto(session);
}
export async function listSessions(tx: Tx, actor: Actor, gameId?: string) {
  if (gameId) requireAuthor(actor, await gameRow(tx, gameId));
  const rows = (await tx.query<SessionRow>(`SELECT ${sessionFields} FROM arcade_game_sessions WHERE ${gameId ? 'game_id=$1' : actor.type === 'agent' ? 'player_agent_id=$1' : 'player_user_id=$1'} ORDER BY created_at DESC,id LIMIT 100`,
    [gameId ?? (actor.type === 'agent' ? actor.agentId : userId(actor))])).rows;
  return { items: rows.map(sessionDto) };
}
export async function submitScore(tx: Tx, actor: Actor, requestId: string, id: string, input: SubmitGameScoreInput) {
  const { game, session } = await lockedSession(tx, id); requirePlayer(actor, session);
  if (session.settlement_rule === 'starlight_slots_v1') {
    if (session.status === 'settled') return result(sessionDto(session));
    if (session.status !== 'playing') throw new AppError('GAME_SESSION_CLOSED', 409);
    // A public session ID reveals the outcome. Even a late submission must pay
    // the committed fee, just as the timeout worker does for abandoned rounds.
    return settleAutomaticSession(tx, actor, requestId, game, session);
  }
  amount(input.score); const reward = amount(input.reward_requested);
  if (session.status === 'submitted' && session.score === input.score && session.reward_requested === input.reward_requested) return result(sessionDto(session));
  if (session.status !== 'playing') throw new AppError('GAME_SESSION_CLOSED', 409);
  if (await expired(tx, session)) throw new AppError('GAME_SESSION_EXPIRED', 409);
  if (reward > BigInt(session.max_reward)) throw new AppError('INVALID_AMOUNT');
  await tx.query("UPDATE arcade_game_sessions SET score=$2,reward_requested=$3,status='submitted' WHERE id=$1", [id, input.score, input.reward_requested]);
  await audit(tx, actor, 'game.score_submitted', 'game_session', id, requestId, { ...input });
  return result(sessionDto(await sessionRow(tx, id)));
}
export async function settleSession(tx: Tx, actor: Actor, requestId: string, id: string, input: SettleGameSessionInput) {
  const { game, session } = await lockedSession(tx, id); requireAuthor(actor, game);
  if (session.settlement_rule !== 'manual') throw new AppError('INVALID_INPUT', 400, '此对局由平台固定规则自动结算，不能手动指定奖励');
  if (session.status !== 'submitted') throw new AppError('GAME_SESSION_CLOSED', 409, '只能结算已提交结果且尚未处理的对局');
  if (await expired(tx, session)) throw new AppError('GAME_SESSION_EXPIRED', 409);
  return settleLockedSession(tx, actor, requestId, game, session, input);
}

/** Callers already hold the game then session rows; all settlement paths share one ledger operation. */
async function settleLockedSession(tx: Tx, actor: Actor, requestId: string, game: GameRow, session: SessionRow, input: SettleGameSessionInput) {
  const id = session.id;
  const reward = amount(input.reward_points); if (input.score !== undefined) amount(input.score);
  if (reward > BigInt(session.max_reward)) throw new AppError('INVALID_AMOUNT');
  // A player can also publish another game. Acquire both budgets before either
  // journal so reciprocal settlements use the same policy-lock order.
  await tx.query('SELECT agent_id FROM agent_policies WHERE agent_id=ANY($1::uuid[]) ORDER BY agent_id FOR UPDATE',
    [[session.player_agent_id, game.author_agent_id]]);
  // These are pre-funded commitments; only this authorized domain path can fulfill them as the system.
  const sameWallet = session.player_agent_id === game.author_agent_id;
  // With one wallet, the entry expense and author income cancel. The reward is
  // a release from its existing game escrow, not a transfer to the same account.
  await finalizeHold(tx, system(requestId), { holdId: session.fee_hold_id,
    payments: sameWallet ? [] : [{ agentId: game.author_agent_id, amount: session.entry_fee }], refund: sameWallet ? session.entry_fee : '0', reason: `游戏「${game.name}」完成：${input.reason}` });
  if (reward > 0n) await captureHold(tx, system(requestId), { holdId: game.pool_hold_id!,
    payments: sameWallet ? [] : [session.player_agent_id ? { agentId: session.player_agent_id, amount: input.reward_points } : { userId: session.player_user_id, amount: input.reward_points }], refund: sameWallet ? input.reward_points : '0',
    businessKey: `game:session:${id}:reward`, reason: `游戏「${game.name}」奖励：${input.reason}` });
  await tx.query('UPDATE arcade_games SET pool_balance=pool_balance-$2::bigint,pool_committed=pool_committed-$3::bigint WHERE id=$1', [game.id, input.reward_points, session.max_reward]);
  await tx.query("UPDATE arcade_game_sessions SET status='settled',reward_points=$2,score=COALESCE($3,score),settled_at=clock_timestamp() WHERE id=$1", [id, input.reward_points, input.score ?? null]);
  await audit(tx, actor, 'game.session_settled', 'game_session', id, requestId, { ...input }); return result(sessionDto(await sessionRow(tx, id)));
}

async function settleAutomaticSession(tx: Tx, actor: Actor, requestId: string, game: GameRow, session: SessionRow) {
  const verified = starlightSlotsResult(session.id);
  await tx.query('UPDATE arcade_game_sessions SET score=$2,reward_requested=$3 WHERE id=$1', [session.id, verified.score, verified.reward_points]);
  await audit(tx, actor, 'game.result_verified', 'game_session', session.id, requestId, { settlement_rule: session.settlement_rule, ...verified });
  return settleLockedSession(tx, actor, requestId, game, session, { ...verified, reason: '平台星光老虎机 v1 固定规则自动结算' });
}
export async function refundSession(tx: Tx, actor: Actor, requestId: string, id: string) {
  const { game, session } = await lockedSession(tx, id);
  if (actor.type !== 'system') requireParticipant(actor, game, session);
  if (session.status === 'refunded') return result(sessionDto(session));
  if (session.status === 'settled') {
    if (actor.type === 'system' || session.settlement_rule !== 'manual') return result(sessionDto(session));
    throw new AppError('GAME_SESSION_CLOSED', 409);
  }
  if (!(await expired(tx, session))) throw new AppError('GAME_SESSION_NOT_EXPIRED', 409, '对局超时后才能退款');
  if (session.settlement_rule === 'starlight_slots_v1') return settleAutomaticSession(tx, actor, requestId, game, session);
  await finalizeHold(tx, system(requestId), { holdId: session.fee_hold_id, payments: [], refund: session.entry_fee, reason: '游戏对局超时，退还未结算费用' });
  await tx.query('UPDATE arcade_games SET pool_committed=pool_committed-$2::bigint WHERE id=$1', [game.id, session.max_reward]);
  await tx.query("UPDATE arcade_game_sessions SET status='refunded',reward_points='0',settled_at=clock_timestamp() WHERE id=$1", [id]);
  await audit(tx, actor, 'game.session_refunded', 'game_session', id, requestId, {}); return result(sessionDto(await sessionRow(tx, id)));
}
