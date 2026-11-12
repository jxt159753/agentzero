import { useRef, useState } from 'react';

const messages: Record<string, string> = {
  UNAUTHENTICATED: '登录已失效，请重新登录。',
  REGISTRATION_EXPIRED: '注册链接已过期，请回到客户端重新发起注册。',
  REGISTRATION_CONFLICT: '注册请求已发生变化，请回到客户端重新发起注册。',
  REGISTRATION_INVALID: '注册链接无效，请从客户端打开完整链接。',
  ACCESS_DENIED: '你没有执行此操作的权限。',
  ACCOUNT_PENDING: '账号正在等待内测准入。',
  ACCOUNT_SUSPENDED: '账号已暂停，请联系管理员。',
  AGENT_PAUSED: 'Agent 已暂停，请先恢复后再发起新操作。',
  AGENT_DELETED: 'Agent 已删除，不能再发起操作。历史账本和合同记录保留。',
  AGENT_VERSION_CONFLICT: 'Agent 信息已变化，请刷新详情后重新确认。',
  AGENT_DELETE_BLOCKED: '请先处理此 Agent 的余额、资产与未完成事项，再删除。',
  PUBLIC_LAND_NOT_TRADEABLE: '此地块占用公共区域，不能供应、购买或挂牌。请选择广场、道路及公共建筑以外的位置。',
  CREDENTIAL_REVOKED: '访问凭证已撤销。',
  POLICY_VERSION_CONFLICT: '权限已在别处修改。请刷新权限后重新编辑。',
  INSUFFICIENT_FUNDS: '可用积分不足。',
  SAME_WALLET: '转出和收款钱包不能相同。',
  WALLET_UNAVAILABLE: '此钱包当前无法收款，请重新选择收款方。',
  SPEND_LIMIT_EXCEEDED: '本次操作超过单笔或每日限额。',
  ISSUANCE_LIMIT_EXCEEDED: '本次发行超过当月剩余预算。',
  IDEMPOTENCY_CONFLICT: '请求编号已用于不同参数，请重新发起操作。',
  BUSINESS_ALREADY_FINALIZED: '该业务已处理完成，请查看原业务结果。',
  CSRF_INVALID: '页面验证已失效，请刷新后重试。',
  INVALID_REQUEST: '输入格式有误，请检查表单。',
  INVALID_AMOUNT: '积分必须是有效的非负整数，且不超过 9223372036854775807。',
  INVALID_INPUT: '输入内容不符合要求，请检查后重试。',
  BUSINESS_CONFLICT: '该业务编号已用于不同的操作，请查看原业务结果。',
  INVALID_ISSUANCE_PERIOD: '只能向当前上海自然月发行积分。',
  ISSUANCE_PERIOD_CHANGED: '等待期间已跨月，请刷新月份后重新提交。',
  LEDGER_INCONSISTENT: '账本存在一致性异常，请联系管理员核对业务记录。',
  LEDGER_QUARANTINED: '对账发现差异，相关资金操作已暂停，请联系管理员。',
  NOT_FOUND: '未找到该记录。',
  OAUTH_UNAVAILABLE: 'GitHub 登录尚未配置或暂时不可用。',
  GITHUB_NOT_CONFIGURED: '仓库集成尚未配置，请联系管理员设置 GitHub App。',
  GITHUB_ACCESS_DENIED: 'GitHub App 暂时无法访问该安装或仓库，请检查安装授权。',
  GITHUB_UNAVAILABLE: 'GitHub 暂时不可用，请稍后重试；以任务当前状态核对处理结果。',
  GITHUB_INVALID_RESPONSE: '未能取得有效的 GitHub 核验结果，请稍后重试。',
  REPOSITORY_UNAVAILABLE: '仓库未获准入或安装授权不可用，请联系管理员。',
  REPOSITORY_CHANGED: '仓库信息在核验期间发生变化，请刷新后重试。',
  REPOSITORY_REQUEST_EXISTS: '该仓库已有待审核申请，请查看申请状态。',
  REPOSITORY_REQUEST_VERSION_CONFLICT: '此仓库申请已由其他操作更新，请刷新审核列表后再处理。',
  CONTRIBUTION_VERSION_CONFLICT: 'GitHub 奖励金额或设置已变化，请刷新后重新提交。',
  CONTRIBUTION_DISABLED: '此类 GitHub 贡献奖励尚未开启，请稍后查看。',
  CONTRIBUTION_IDENTITY_MISMATCH: '贡献作者须与收款 Agent 所有者的 GitHub 账号一致。',
  INVALID_CONTRIBUTION_URL: '请输入有效的 GitHub Commit、Pull Request 或 Issue 链接。',
  CONTRIBUTION_BINDING_MISMATCH: 'GitHub 贡献与所选仓库或对象不一致，请核对链接。',
  PR_BINDING_MISMATCH: 'PR 的仓库、作者或提交版本与任务绑定不一致，请核对交付。',
  TASK_VERSION_CONFLICT: '任务或取消方案已更新，请刷新详情后重试。',
  TASK_STATE_CONFLICT: '任务当前状态不允许此操作，请刷新详情。',
  TASK_DISPUTED: '任务正在争议处理中，等待管理员裁定。',
  TASK_DEADLINE_PASSED: '任务已到期，请申请管理员处理。',
  INVALID_REVIEWER: '请选择已经获准入的验收人。',
  REVIEWER_CONFLICT: '验收人或裁定管理员不能是任一参与 Agent 的所有者。',
  PR_VERSION_CHANGED: 'PR 仓库或提交版本已变化，请核对并重新提交成果。',
  PR_IDENTITY_MISMATCH: 'PR 作者须与承接 Agent 所有者的 GitHub 账号一致。',
  PR_NOT_MERGED: 'PR 尚未合并，奖金继续冻结。合并后可重新验收。',
  PR_CHECKS_PENDING: '约定的 GitHub 检查尚未全部通过，奖金继续冻结。',
  PR_ALREADY_REWARDED: '此 PR 已获得另一项任务的奖励，不能重复结算。',
  INVALID_SETTLEMENT: '支付与退款金额不符合冻结奖金或任务结算要求。',
  INVALID_AGREEMENT: '请检查协议成员、分账总额与截止时间。最多 3 个成员，不能包含付款 Agent。',
  AGREEMENT_STATE_CONFLICT: '协议状态已变化，请刷新任务详情。',
  COLLABORATION_NOT_ALLOWED: '参与 Agent 须处于活跃状态并已开启协作权限。',
  REWARD_VERSION_CONFLICT: '奖励记录已变化，请刷新后重新操作。',
  REWARD_STATE_CONFLICT: '领取单当前状态不允许此操作，请刷新领取状态。',
  REWARD_PROCESSOR_CONFLICT: '该领取单由另一位管理员发放中，请由原处理人核对支付结果。',
  REWARD_POOL_LIMIT: '商品份数或用户上限超过月度奖励预算，请检查配置。',
  REWARD_MONTH_CLOSED: '当前月份已不允许新增兑换，已兑换凭证仍然有效。',
  REWARD_UNAVAILABLE: '奖励兑换已暂停，请选择其他奖励或稍后查看。',
  REWARD_SOLD_OUT: '该奖励已经兑完，积分未扣除。',
  REWARD_MONTHLY_LIMIT: '已达到用户本月兑换上限。所有所属 Agent 共享限额，取消不恢复次数。',
  MARKET_VERSION_CONFLICT: '报价或资产已变化，请刷新市场并重新选择报价。',
  WORLD_MODEL_VERSION_CONFLICT: '地块或模型已在别处更新，请重新选择后再保存。',
  WORLD_MODEL_OUT_OF_BOUNDS: '模型旋转和缩放后的完整占地须位于自己的地块内，请调整位置或大小。',
  WORLD_MODEL_LIMIT: '每块地最多摆放 32 个免费模型，请先移除不需要的模型。',
  WORLD_ROOM_INVALID: '房屋不存在或已变化，请返回室外后重试。',
  WORLD_ROOM_NOT_EMPTY: '请先移除房屋内的物品，再删除房屋。',
  WORLD_ROOM_OUT_OF_BOUNDS: '位置超出房间边界。',
  GAME_VERSION_CONFLICT: '游戏费用或开放设置已变化，请刷新后重新确认。',
  GAME_POOL_LOW: '可用奖池低于开放门槛，发布者补足后自动恢复。',
  GAME_POOL_COMMITTED: '这些积分已为进行中的对局保留，只能提取未承诺的奖池。',
  GAME_UNAVAILABLE: '游戏或发布者当前已暂停，暂不能开始新对局。',
  GAME_SESSION_CLOSED: '本局已提交或结算，请查看最新对局状态。',
  GAME_SESSION_EXPIRED: '本局已超时，可在“我的对局”查看退款。',
  GAME_SESSION_NOT_EXPIRED: '本局尚未超时，请等待结算或到期退款。',
  GAME_BUNDLE_TOO_LARGE: '游戏包总大小不能超过 2 MB。',
  ASSET_LISTED: '资产已挂牌，请先撤销挂牌再编辑或移动。',
  LAND_LIMIT_EXCEEDED: '已达到用户持地上限，所有所属 Agent 合并计算。',
  LAND_SUPPLY_CONFLICT: '地块编号重复，或地块占地与其他地块重叠。本批土地未发布，请调整位置或面积。',
  ASSET_UNAVAILABLE: '资产已售出、暂停销售或库存不足，请刷新市场。',
  ITEM_PLACED: '物品仍在工作室中，请先取回库存再挂牌。',
  LISTING_CLOSED: '该挂牌已撤销或成交，请选择仍有效的报价。',
  SAME_OWNER_TRADE: '同一用户所属 Agent 之间不能交易土地或物品。',
  NO_CHANGE: '没有需要更新的内容。',
};

export class ApiError extends Error {
  constructor(public code: string, public requestId?: string, public uncertain = false, detail?: string) {
    super(code === 'AGENT_DELETE_BLOCKED' && detail ? detail : messages[code] ?? (uncertain ? '网络连接中断，操作结果尚未确认。可保留原请求编号重试。' : '操作未成功，请检查输入或稍后重试。'));
  }
}

export async function api<T>(path: string, options?: { method: string; body?: unknown; key?: string }): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = decodeURIComponent(document.cookie.split('; ').find((item) => item.startsWith('az_csrf='))?.slice(8) ?? '');
    if (options.key) headers['Idempotency-Key'] = options.key;
  }
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { method: options?.method ?? 'GET', credentials: 'same-origin', headers, ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
  } catch {
    throw new ApiError('NETWORK_ERROR', undefined, Boolean(options));
  }
  let data: T & { error?: { code: string; message?: string; request_id?: string } };
  try { data = await response.json() as typeof data; } catch { throw new ApiError('INVALID_RESPONSE', undefined, Boolean(options)); }
  if (!response.ok) throw new ApiError(data.error?.code ?? 'SERVER_ERROR', data.error?.request_id, response.status >= 500 && Boolean(options), data.error?.message);
  return data;
}

/** Keep the request key when a response is lost; changing the command creates a new key. */
export function useCommand() {
  const last = useRef<{ signature: string; key: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  async function run<T>(path: string, method: string, body: unknown, onSuccess?: (data: T) => void | Promise<void>) {
    if (pending) return;
    const signature = JSON.stringify([path, method, body]);
    if (last.current?.signature !== signature) last.current = { signature, key: crypto.randomUUID() };
    setPending(true); setError(null); setOperationId(null);
    try {
      const result = await api<T & { operation_id?: string }>(path, { method, body, key: last.current.key });
      setOperationId(result.operation_id ?? null);
      last.current = null;
      await onSuccess?.(result);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('操作失败'));
      if (!(cause instanceof ApiError && cause.uncertain)) last.current = null;
      return undefined;
    } finally { setPending(false); }
  }
  return { run, pending, error, operationId, requestKey: last.current?.key };
}

export const queryString = (values: Record<string, string | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  return params.size ? `?${params}` : '';
};

export function points(value: string): string { return value.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
export function measure(value: number, maximumFractionDigits = 2): string { return value.toLocaleString('zh-CN', { maximumFractionDigits, useGrouping: false }); }
export function dateTime(value: string): string { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(value)); }
export function monthNow(): string { return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', timeZone: 'Asia/Shanghai' }).format(new Date()); }
