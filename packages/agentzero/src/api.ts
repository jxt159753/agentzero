import type { AgentZeroConfig } from './config.js';
import type { CreateGameInput, PatchGameInput, WorldModelDraft } from '../../contracts/src/index.js';

type JsonObject = Record<string, unknown>;
export interface AgentIdentity extends JsonObject { actor: { type: 'agent'; agentId: string } }
export interface TaskListInput { status?: 'draft'|'open'|'in_progress'|'submitted'|'changes_requested'|'settled'|'cancelled'; mine?: boolean; cursor?: string; limit?: number }
export interface AcceptTaskInput { task_id: string; version: string; idempotency_key: string }
export interface SubmitDeliveryInput extends AcceptTaskInput { pr_number: number; head_sha: string }
export interface AgreementMemberInput { agent_id: string; role: string; deliverable: string; amount_points: string }
export interface ProposeAgreementInput extends AcceptTaskInput { deadline_at: string; members: AgreementMemberInput[] }
export interface AgreementDecisionInput extends AcceptTaskInput { agreement_id: string; decision: 'accept' | 'reject'; reason?: string; as_publisher?: boolean }
export interface ContributionInput extends AcceptTaskInput { kind: 'pr' | 'test' | 'note'; body: string; url?: string }
export interface MessagePageInput { after?: string; limit?: number }
export interface MessageTarget { conversation_id?: string; task_id?: string }
export interface CancellationInput extends AcceptTaskInput { payment_points: string; refund_points: string; reason: string; payments?: { agent_id: string; amount_points: string }[]; as_publisher?: boolean }
export type MarketAssetKind = 'land' | 'item' | 'listing';
export interface MarketPurchaseInput { kind: 'land' | 'template' | 'listing'; asset_id: string; version: string; idempotency_key: string }
export interface MarketListingInput { kind: 'land' | 'item'; asset_id: string; asset_version: string; points_price: string; idempotency_key: string }
export type StudioShowcaseItem = { type: 'text'; title?: string; text: string } | { type: 'image' | 'video' | 'webpage'; title?: string; url: string };
export type GameQuery = { action: 'list'; mine?: boolean } | { action: 'get'; game_id: string } | { action: 'machine'; placement_id: string }
  | { action: 'sessions'; game_id?: string } | { action: 'session'; session_id: string };
export type WorldModelOperation = { land_id: string } & (
  | ({ action: 'add'; land_version: string } & WorldModelDraft)
  | ({ action: 'patch'; placement_id: string; version: string } & Pick<WorldModelDraft, 'x' | 'y' | 'rotation' | 'scale'>)
  | { action: 'delete'; placement_id: string; version: string });
export type GameSessionOperation = { session_id: string } & (
  | { action: 'submit'; score: string; reward_requested: string }
  | { action: 'settle'; reward_points: string; score?: string; reason: string }
  | { action: 'refund' });
export type GroupQuery =
  | { action: 'create'; title: string; member_agent_ids?: string[]; member_user_ids?: string[] }
  | { action: 'invite'; conversation_id: string; member_agent_ids?: string[]; member_user_ids?: string[] }
  | { action: 'remove'; conversation_id: string; member_id: string }
  | { action: 'set_role'; conversation_id: string; member_id: string; role: 'admin' | 'member' }
  | { action: 'rename'; conversation_id: string; title: string }
  | { action: 'leave'; conversation_id: string };
export interface ApiFailure extends JsonObject { code: string; message: string; uncertain: boolean; status?: number; request_id?: string; idempotency_key?: string }

export class AgentZeroApiError extends Error {
  constructor(public readonly details: ApiFailure) { super(details.message); this.name = 'AgentZeroApiError'; }
}

const timeoutMs = 15_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Fixed Agent-facing routes only. Credentials never become tool arguments or output. */
export class AgentZeroApi {
  constructor(private readonly config: AgentZeroConfig) {}

  private sanitize<T>(value: T): T {
    const key = this.config.agentKey;
    const redact = (item: unknown): unknown => {
      if (typeof item === 'string') return key ? item.split(key).join('[REDACTED]') : item;
      if (Array.isArray(item)) return item.map(redact);
      if (object(item)) return Object.fromEntries(Object.entries(item).map(([name, entry]) => [key ? name.split(key).join('[REDACTED]') : name, redact(entry)]));
      return item;
    };
    return redact(value) as T;
  }

  private failure(code: string, message: string, extra: Partial<ApiFailure> = {}): AgentZeroApiError {
    return new AgentZeroApiError(this.sanitize({ code, message, uncertain: false, ...extra }));
  }

  private async request(path: string, write?: { body: JsonObject; key: string; method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE' }): Promise<JsonObject> {
    if (!this.config.agentKey) throw this.failure('CONFIG_REQUIRED', '请调用 agentzero_register 注册并连接 Agent，在浏览器确认后即可自动保存，无需复制凭证。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const requestContext = write ? { idempotency_key: write.key } : {};
    const retryMessage = write ? '写操作结果尚未确认，请保留原请求键与参数核对或重试。' : '请检查平台连接后重试。';
    try {
      let response: Response;
      try {
        response = await fetch(new URL(`/api/v1${path}`, this.config.apiUrl), {
          method: write ? write.method ?? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
          headers: { accept: 'application/json', authorization: `Bearer ${this.config.agentKey}`,
            ...(write ? { 'content-type': 'application/json', 'idempotency-key': write.key } : {}) },
          ...(write ? { body: JSON.stringify(write.body) } : {}),
        });
      } catch {
        throw this.failure(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
          `${controller.signal.aborted ? '平台请求超时。' : '无法连接平台。'}${retryMessage}`,
          { uncertain: Boolean(write), ...requestContext });
      }
      let data: unknown;
      try { data = await response.json(); }
      catch {
        throw this.failure(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'INVALID_RESPONSE', `平台未返回完整的 JSON 结果。${retryMessage}`,
          { status: response.status, uncertain: Boolean(write), ...requestContext });
      }
      if (!response.ok) {
        const error = object(data) && object(data.error) ? data.error : {};
        const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'HTTP_ERROR';
        throw this.failure(code, typeof error.message === 'string' ? error.message : '平台拒绝了此请求。', {
          status: response.status, uncertain: Boolean(write) && response.status >= 500,
          ...(typeof error.request_id === 'string' ? { request_id: error.request_id } : {}), ...requestContext,
        });
      }
      if (!object(data)) throw this.failure('INVALID_RESPONSE', '平台响应格式不符合接口契约。', { status: response.status, uncertain: Boolean(write), ...requestContext });
      return this.sanitize(data);
    } finally { clearTimeout(timer); }
  }

  async identity(): Promise<AgentIdentity> {
    const identity = await this.request('/me');
    if (!object(identity.actor) || identity.actor.type !== 'agent' || typeof identity.actor.agentId !== 'string' || !uuid.test(identity.actor.agentId)) {
      throw this.failure('AGENT_IDENTITY_REQUIRED', '当前凭证未返回有效的平台 Agent 身份，请重新配置 Agent 访问凭证。');
    }
    return identity as AgentIdentity;
  }

  async wallet(): Promise<JsonObject> {
    const identity = await this.identity();
    return this.request(`/agents/${encodeURIComponent(identity.actor.agentId)}/wallet`);
  }

  repositories(): Promise<JsonObject> { return this.request('/repositories'); }

  listTasks(input: TaskListInput = {}): Promise<JsonObject> {
    const query = new URLSearchParams();
    if (input.status !== undefined) query.set('status', input.status);
    if (input.mine) query.set('mine', 'true');
    if (input.cursor !== undefined) query.set('cursor', input.cursor);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    return this.request(`/tasks${query.size ? `?${query}` : ''}`);
  }

  getTask(id: string): Promise<JsonObject> { return this.request(`/tasks/${encodeURIComponent(id)}`); }

  async acceptTask(input: AcceptTaskInput): Promise<JsonObject> {
    const identity = await this.identity();
    return this.request(`/tasks/${encodeURIComponent(input.task_id)}/accept`, {
      key: input.idempotency_key, body: { version: input.version, agent_id: identity.actor.agentId },
    });
  }

  submitDelivery(input: SubmitDeliveryInput): Promise<JsonObject> {
    return this.request(`/tasks/${encodeURIComponent(input.task_id)}/deliveries`, {
      key: input.idempotency_key, body: { version: input.version, pr_number: input.pr_number, head_sha: input.head_sha },
    });
  }

  getOperation(id: string): Promise<JsonObject> { return this.request(`/operations/${encodeURIComponent(id)}`); }

  proposeAgreement(input: ProposeAgreementInput): Promise<JsonObject> {
    return this.request(`/tasks/${encodeURIComponent(input.task_id)}/agreements`, {
      key: input.idempotency_key, body: { version: input.version, deadline_at: input.deadline_at, members: input.members },
    });
  }

  async respondAgreement(input: AgreementDecisionInput): Promise<JsonObject> {
    const identity = await this.identity();
    return this.request(`/tasks/${encodeURIComponent(input.task_id)}/agreements/${encodeURIComponent(input.agreement_id)}/${input.decision}`, {
      key: input.idempotency_key, body: { version: input.version, ...(input.as_publisher ? { as_publisher: true } : { agent_id: identity.actor.agentId }), ...(input.decision === 'reject' ? { reason: input.reason } : {}) },
    });
  }

  async submitContribution(input: ContributionInput): Promise<JsonObject> {
    const identity = await this.identity();
    return this.request(`/tasks/${encodeURIComponent(input.task_id)}/contributions`, {
      key: input.idempotency_key, body: { version: input.version, agent_id: identity.actor.agentId, kind: input.kind, body: input.body, ...(input.url ? { url: input.url } : {}) },
    });
  }

  proposeCancellation(input: CancellationInput): Promise<JsonObject> {
    return this.request(`/tasks/${encodeURIComponent(input.task_id)}/cancellation-proposals`, {
      key: input.idempotency_key, body: { version: input.version, payment_points: input.payment_points, refund_points: input.refund_points, reason: input.reason, ...(input.payments ? { payments: input.payments } : {}), ...(input.as_publisher ? { as_publisher: true } : {}) },
    });
  }

  async acceptCancellation(input: AcceptTaskInput & { proposal_id: string; as_publisher?: boolean }): Promise<JsonObject> {
    const identity = await this.identity();
    return this.request(`/tasks/${encodeURIComponent(input.task_id)}/cancellation-proposals/${encodeURIComponent(input.proposal_id)}/accept`, {
      key: input.idempotency_key, body: { version: input.version, ...(input.as_publisher ? { as_publisher: true } : { agent_id: identity.actor.agentId }) },
    });
  }

  disputeTask(input: AcceptTaskInput & { reason: string }): Promise<JsonObject> {
    return this.request(`/tasks/${encodeURIComponent(input.task_id)}/disputes`, { key: input.idempotency_key, body: { version: input.version, reason: input.reason } });
  }

  listAgents(collaborationOnly = false): Promise<JsonObject> { return this.request(collaborationOnly ? '/collaboration-agents' : '/message-recipients'); }

  listConversations(input: { cursor?: string; limit?: number } = {}): Promise<JsonObject> {
    const query = new URLSearchParams();
    if (input.cursor !== undefined) query.set('cursor', input.cursor);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    return this.request(`/conversations${query.size ? `?${query}` : ''}`);
  }

  createConversation(input: { recipient_agent_id?: string; recipient_user_id?: string; idempotency_key: string }): Promise<JsonObject> {
    return this.request('/conversations', { key: input.idempotency_key, body: {
      ...(input.recipient_agent_id ? { recipient_agent_id: input.recipient_agent_id } : {}),
      ...(input.recipient_user_id ? { recipient_user_id: input.recipient_user_id } : {}),
    } });
  }

  private messagePath(target: MessageTarget): string {
    return target.task_id ? `/tasks/${encodeURIComponent(target.task_id)}/messages` : `/conversations/${encodeURIComponent(target.conversation_id!)}/messages`;
  }

  getConversation(id: string): Promise<JsonObject> { return this.request(`/conversations/${encodeURIComponent(id)}`); }

  /** Group chat commands stay one call per action so a lost response is retried with the same key. */
  group(input: { operation: GroupQuery; idempotency_key: string }): Promise<JsonObject> {
    const { operation, idempotency_key } = input;
    const members = (value: { member_agent_ids?: string[]; member_user_ids?: string[] }) => ({
      ...(value.member_agent_ids ? { member_agent_ids: value.member_agent_ids } : {}),
      ...(value.member_user_ids ? { member_user_ids: value.member_user_ids } : {}),
    });
    if (operation.action === 'create') return this.request('/conversations/groups', { key: idempotency_key, body: { title: operation.title, ...members(operation) } });
    const path = `/conversations/${encodeURIComponent(operation.conversation_id)}`;
    if (operation.action === 'invite') return this.request(`${path}/members`, { key: idempotency_key, body: members(operation) });
    if (operation.action === 'rename') return this.request(path, { key: idempotency_key, method: 'PATCH', body: { title: operation.title } });
    if (operation.action === 'leave') return this.request(`${path}/leave`, { key: idempotency_key, body: {} });
    const memberPath = `${path}/members/${encodeURIComponent(operation.member_id)}`;
    return operation.action === 'remove'
      ? this.request(memberPath, { key: idempotency_key, method: 'DELETE', body: {} })
      : this.request(memberPath, { key: idempotency_key, method: 'PATCH', body: { role: operation.role } });
  }

  private messagePage(path: string, input: MessagePageInput): Promise<JsonObject> {
    const query = new URLSearchParams();
    if (input.after !== undefined) query.set('after', input.after);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    return this.request(`${path}${query.size ? `?${query}` : ''}`);
  }

  readMessages(input: MessageTarget & MessagePageInput): Promise<JsonObject> { return this.messagePage(this.messagePath(input), input); }

  sendMessage(input: MessageTarget & { body: string; idempotency_key: string }): Promise<JsonObject> {
    return this.request(this.messagePath(input), { key: input.idempotency_key, body: { body: input.body } });
  }

  pollMessages(input: MessagePageInput): Promise<JsonObject> { return this.messagePage('/messages', input); }

  rewardCatalog(month?: string): Promise<JsonObject> { return this.request(`/rewards${month ? `?month=${encodeURIComponent(month)}` : ''}`); }

  async redeemReward(input: { offer_id: string; claimant_qq: string; idempotency_key: string }): Promise<JsonObject> {
    const identity = await this.identity();
    return this.request('/reward-redemptions', { key: input.idempotency_key,
      body: { offer_id: input.offer_id, agent_id: identity.actor.agentId, claimant_qq: input.claimant_qq } });
  }

  listRewardRedemptions(input: { cursor?: string; limit?: number } = {}): Promise<JsonObject> {
    const query = new URLSearchParams();
    if (input.cursor !== undefined) query.set('cursor', input.cursor);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    return this.request(`/reward-redemptions${query.size ? `?${query}` : ''}`);
  }

  getRewardRedemption(id: string): Promise<JsonObject> { return this.request(`/reward-redemptions/${encodeURIComponent(id)}`); }

  cancelRewardRedemption(input: { redemption_id: string; version: string; reason: string; idempotency_key: string }): Promise<JsonObject> {
    return this.request(`/reward-redemptions/${encodeURIComponent(input.redemption_id)}/cancel`, {
      key: input.idempotency_key, body: { version: input.version, reason: input.reason } });
  }

  marketCatalog(): Promise<JsonObject> { return this.request('/market'); }

  world(): Promise<JsonObject> { return this.request('/world'); }

  worldStudio(id: string): Promise<JsonObject> { return this.request(`/world/studios/${encodeURIComponent(id)}`); }

  worldAgent(id: string): Promise<JsonObject> { return this.request(`/world/agents/${encodeURIComponent(id)}`); }

  worldPresence(input: { x?: number; y?: number; room_id?: string | null; idempotency_key: string }): Promise<JsonObject> {
    return this.request('/world/presence', { key: input.idempotency_key,
      body: input.x === undefined ? {} : { x: input.x, y: input.y, ...(input.room_id === undefined ? {} : { room_id: input.room_id }) } });
  }

  worldLeave(key: string): Promise<JsonObject> { return this.request('/world/leave', { key, body: {} }); }

  async marketAssets(): Promise<JsonObject> {
    const identity = await this.identity();
    return this.request(`/agents/${encodeURIComponent(identity.actor.agentId)}/assets`);
  }

  getMarketAsset(input: { kind: MarketAssetKind; asset_id: string }): Promise<JsonObject> {
    const collection = { land: 'lands', item: 'items', listing: 'listings' }[input.kind];
    return this.request(`/market/${collection}/${encodeURIComponent(input.asset_id)}`);
  }

  async buyMarketAsset(input: MarketPurchaseInput): Promise<JsonObject> {
    const identity = await this.identity();
    const collection = { land: 'lands', template: 'templates', listing: 'listings' }[input.kind];
    return this.request(`/market/${collection}/${encodeURIComponent(input.asset_id)}/buy`, {
      key: input.idempotency_key, body: { agent_id: identity.actor.agentId, version: input.version },
    });
  }

  async createMarketListing(input: MarketListingInput): Promise<JsonObject> {
    const identity = await this.identity();
    return this.request('/market/listings', { key: input.idempotency_key, body: {
      agent_id: identity.actor.agentId, [input.kind === 'land' ? 'land_id' : 'item_id']: input.asset_id,
      asset_version: input.asset_version, points_price: input.points_price,
    } });
  }

  cancelMarketListing(input: { listing_id: string; version: string; idempotency_key: string }): Promise<JsonObject> {
    return this.request(`/market/listings/${encodeURIComponent(input.listing_id)}/cancel`, {
      key: input.idempotency_key, body: { version: input.version },
    });
  }

  async updateStudio(input: { land_id: string; version: string; name: string; works_url: string | null; showcase?: StudioShowcaseItem[]; idempotency_key: string }): Promise<JsonObject> {
    const identity = await this.identity();
    return this.request(`/market/lands/${encodeURIComponent(input.land_id)}/studio`, { key: input.idempotency_key, method: 'PATCH',
      body: { agent_id: identity.actor.agentId, version: input.version, name: input.name, works_url: input.works_url,
        ...(input.showcase === undefined ? {} : { showcase: input.showcase }) },
    });
  }

  async placeMarketItem(input: { item_id: string; version: string; land_id: string | null; idempotency_key: string }): Promise<JsonObject> {
    const identity = await this.identity();
    return this.request(`/market/items/${encodeURIComponent(input.item_id)}/place`, {
      key: input.idempotency_key, body: { agent_id: identity.actor.agentId, version: input.version, land_id: input.land_id },
    });
  }

  worldModels(input: { operation: WorldModelOperation; idempotency_key: string }): Promise<JsonObject> {
    const operation = input.operation, path = `/world/studios/${encodeURIComponent(operation.land_id)}/models`;
    if (operation.action === 'add') {
      const { action: _action, land_id: _land, ...body } = operation;
      return this.request(path, { key: input.idempotency_key, body });
    }
    const { action, land_id: _land, placement_id, ...body } = operation;
    return this.request(`${path}/${encodeURIComponent(placement_id)}`, { key: input.idempotency_key, method: action === 'patch' ? 'PATCH' : 'DELETE', body });
  }

  games(query: GameQuery): Promise<JsonObject> {
    if (query.action === 'list') return this.request(`/games${query.mine ? '?mine=true' : ''}`);
    if (query.action === 'get') return this.request(`/games/${encodeURIComponent(query.game_id)}`);
    if (query.action === 'machine') return this.request(`/games/machines/${encodeURIComponent(query.placement_id)}`);
    if (query.action === 'sessions') return this.request(query.game_id ? `/games/${encodeURIComponent(query.game_id)}/sessions` : '/games/sessions?mine=true');
    return this.request(`/games/sessions/${encodeURIComponent(query.session_id)}`);
  }

  async createGame(input: Omit<CreateGameInput, 'agent_id'> & { idempotency_key: string }): Promise<JsonObject> {
    const identity = await this.identity(), { idempotency_key, ...body } = input;
    return this.request('/games', { key: idempotency_key, body: { ...body, agent_id: identity.actor.agentId } });
  }

  updateGame(input: PatchGameInput & { game_id: string; idempotency_key: string }): Promise<JsonObject> {
    const { game_id, idempotency_key, ...body } = input;
    return this.request(`/games/${encodeURIComponent(game_id)}`, { key: idempotency_key, method: 'PATCH', body });
  }

  gamePool(input: { game_id: string; action: 'fund' | 'withdraw'; amount: string; idempotency_key: string }): Promise<JsonObject> {
    return this.request(`/games/${encodeURIComponent(input.game_id)}/${input.action}`, { key: input.idempotency_key, body: { amount: input.amount } });
  }

  bindGameMachine(input: { placement_id: string; game_id: string | null; idempotency_key: string }): Promise<JsonObject> {
    return this.request(`/games/machines/${encodeURIComponent(input.placement_id)}`, { key: input.idempotency_key, method: 'PUT', body: { game_id: input.game_id } });
  }

  async startGameSession(input: { game_id: string; game_version: string; idempotency_key: string }): Promise<JsonObject> {
    const identity = await this.identity();
    return this.request(`/games/${encodeURIComponent(input.game_id)}/sessions`, { key: input.idempotency_key,
      body: { agent_id: identity.actor.agentId, game_version: input.game_version } });
  }

  gameSession(input: { operation: GameSessionOperation; idempotency_key: string }): Promise<JsonObject> {
    const { session_id, action, ...body } = input.operation;
    return this.request(`/games/sessions/${encodeURIComponent(session_id)}/${action === 'submit' ? 'score' : action}`, { key: input.idempotency_key, body });
  }
}
