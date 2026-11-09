import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AgentZeroApi, AgentZeroApiError } from './api.js';
import { defaultConfigFile, loadConfig, validateApiUrl, type AgentZeroConfig } from './config.js';

const execute = promisify(execFile);
const pendingSchema = z.strictObject({
  id: z.uuid(), client: z.enum(['codex', 'dsh']), name: z.string().min(1).max(80), api_url: z.string(),
  secret: z.string().regex(/^azk_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/),
  verification_code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
type Pending = z.infer<typeof pendingSchema>;
export type RegistrationInput = { client: 'codex' | 'dsh'; name: string; api_url?: string };
const stateSchema = z.object({ id: z.uuid(), status: z.enum(['pending', 'approved']), expires_at: z.iso.datetime({ offset: true }), agent_id: z.uuid().optional(), key_id: z.uuid().optional() });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const failure = (code: string, message: string, uncertain = false) => new AgentZeroApiError({ code, message, uncertain });

/** Restrict an empty staging directory before writing any credential bytes. */
export async function savePrivateJson(file: string, value: unknown, replace = true): Promise<void> {
  if (!isAbsolute(file)) throw failure('CONFIG_WRITE_FAILED', '配置文件需要使用绝对路径。');
  const folder = dirname(file);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(folder, '.agentzero-save-'));
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
      const sid = /S-1-5-[0-9-]+/.exec(stdout)?.[0];
      if (!sid) throw new Error('WINDOWS_IDENTITY_UNAVAILABLE');
      await execute('icacls.exe', [staging, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)(F)`, '*S-1-5-18:(OI)(CI)(F)'], { windowsHide: true });
    } else await chmod(staging, 0o700);
    const temporary = join(staging, 'config.json');
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    if (replace) await rename(temporary, file);
    else await link(temporary, file); // A second MCP process must reuse the winner's pending request.
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export class AgentRegistration {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly config: AgentZeroConfig) {}

  register(input: RegistrationInput): Promise<Record<string, unknown>> {
    const operation = this.queue.then(() => this.perform(input));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async request(pending: Pending, start: boolean) {
    let response: Response;
    try {
      response = await fetch(new URL(start ? '/api/v1/agent-registrations' : `/api/v1/agent-registrations/${pending.id}/status`, pending.api_url), {
        method: start ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/json', ...(start ? { 'content-type': 'application/json' } : { authorization: `Bearer ${pending.secret}` }) },
        ...(start ? { body: JSON.stringify({ id: pending.id, client: pending.client, name: pending.name, credential_hash: digest(pending.secret), verification_hash: digest(pending.verification_code) }) } : {}),
      });
    } catch { throw failure('REGISTRATION_NETWORK_ERROR', '暂时无法连接平台；原注册请求已保存在本机，请用相同参数重试。', start); }
    if (response.status === 410) throw failure('REGISTRATION_EXPIRED', '注册链接已过期，请再次调用注册工具获取新链接。');
    if (!start && response.status === 404) throw failure('REGISTRATION_NOT_FOUND', '平台尚未收到原注册请求。');
    if (!response.ok) throw failure('REGISTRATION_REJECTED', `平台未能完成注册（HTTP ${response.status}）；请确认账号、注册状态和平台地址后重试。`, response.status >= 500);
    let data: unknown;
    try { data = await response.json(); } catch { throw failure('INVALID_RESPONSE', '平台未返回完整的注册结果，请用相同参数重试。', start); }
    const parsed = stateSchema.safeParse(data);
    if (!parsed.success || parsed.data.id !== pending.id || parsed.data.status === 'approved' && (!parsed.data.agent_id || parsed.data.key_id !== pending.id)) {
      throw failure('INVALID_RESPONSE', '平台注册结果不符合接口契约，请用相同参数重试。', start);
    }
    return parsed.data;
  }

  private async readPending(file: string): Promise<Pending | undefined> {
    try {
      const value = pendingSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      if (value.secret.split('.')[0] !== `azk_${value.id}` || validateApiUrl(value.api_url) !== value.api_url) throw new Error('INVALID_PENDING');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw failure('REGISTRATION_LOCAL_STATE_INVALID', '本机注册记录无法读取，请检查配置目录；不要把文件内容发到聊天。');
    }
  }

  private async perform(input: RegistrationInput): Promise<Record<string, unknown>> {
    const file = this.config.configFile ?? defaultConfigFile();
    // Respect credentials written by another client since this process started.
    if (!this.config.agentKey) {
      const saved = loadConfig({}, file);
      if (saved.agentKey) Object.assign(this.config, saved);
    }
    if (this.config.agentKey) {
      const identity = await new AgentZeroApi(this.config).identity();
      return { status: 'already_connected', agent_id: identity.actor.agentId, api_url: this.config.apiUrl, message: '此客户端已经连接 Agent，无需重新注册。' };
    }
    const origin = validateApiUrl(input.api_url ?? this.config.apiUrl);
    const name = input.name.trim();
    const pendingFile = `${file}.registration.json`;
    let pending = await this.readPending(pendingFile);
    let created = !pending;
    if (!pending) {
      const id = randomUUID();
      pending = { id, client: input.client, name, api_url: origin, secret: `azk_${id}.${randomBytes(32).toString('base64url')}`, verification_code: randomBytes(32).toString('base64url') };
      try { await savePrivateJson(pendingFile, pending, false); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') { pending = (await this.readPending(pendingFile))!; created = false; }
        else throw failure('CONFIG_WRITE_FAILED', '无法安全保存本机注册记录；尚未向平台注册，请检查配置目录权限。');
      }
    }
    if (pending.client !== input.client || pending.name !== name || pending.api_url !== origin) {
      throw failure('REGISTRATION_IN_PROGRESS', '已有注册正在进行，请使用原客户端、名称和平台地址完成注册后再切换。');
    }
    try {
      let status;
      if (created) {
        await this.request(pending, true);
        status = await this.request(pending, false);
      } else {
        try { status = await this.request(pending, false); }
        catch (error) {
          if (!(error instanceof AgentZeroApiError) || error.details.code !== 'REGISTRATION_NOT_FOUND') throw error;
          await this.request(pending, true);
          status = await this.request(pending, false);
        }
      }
      if (status.status === 'pending') {
        const verification = new URL('/connect', origin);
        verification.searchParams.set('request', pending.id);
        verification.hash = new URLSearchParams({ code: pending.verification_code }).toString();
        return { status: 'pending', name, client: pending.client, verification_uri: verification.toString(), expires_at: status.expires_at,
          message: '请打开链接，在网页确认要新建或连接的 Agent；完成后再次调用 agentzero_register，插件将自动保存连接。无需复制凭证。' };
      }
      // Check again before replacing the destination: another client may have connected meanwhile.
      const current = loadConfig({}, file);
      if (current.agentKey && (current.agentKey !== pending.secret || current.apiUrl !== origin)) {
        throw failure('CONFIG_ALREADY_CONNECTED', '本机配置已由另一个客户端连接到 Agent，未覆盖；请使用独立配置文件。');
      }
      try { await savePrivateJson(file, { api_url: origin, agent_key: pending.secret }); }
      catch { throw failure('CONFIG_WRITE_FAILED', '网页确认已完成，但本机配置保存失败；请检查目录权限后用相同参数重试，原注册记录已保留。'); }
      this.config.apiUrl = origin;
      this.config.agentKey = pending.secret;
      // A successful private config is authoritative even if cleanup is interrupted.
      await unlink(pendingFile).catch(() => undefined);
      return { status: 'connected', agent_id: status.agent_id, api_url: origin, message: '已注册并连接 Agent，现在可以查询身份和钱包。' };
    } catch (error) {
      if (error instanceof AgentZeroApiError && error.details.code === 'REGISTRATION_EXPIRED') await unlink(pendingFile);
      throw error;
    }
  }
}
