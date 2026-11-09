import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type AgentZeroConfig = { apiUrl: string; agentKey: string; configFile?: string };
export const defaultApiUrl = 'https://118.190.147.128:8443';
export const defaultConfigFile = () => join(homedir(), '.agentzero', 'config.json');

export function validateApiUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('AgentZero api_url 必须是完整的服务地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && local)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('AgentZero api_url 必须是 HTTPS origin（本机可用 HTTP），不包含路径、账号或查询参数。');
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, fileOverride?: string): AgentZeroConfig {
  const file = fileOverride ?? env.AGENTZERO_CONFIG_FILE ?? defaultConfigFile();
  if (!isAbsolute(file)) throw new Error('AgentZero 配置文件需要使用绝对路径。');
  let saved: { api_url?: string; agent_key?: string } = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_CONFIG');
    const object = parsed as Record<string, unknown>;
    if (Object.keys(object).some(key => !['api_url', 'agent_key'].includes(key))
      || object.api_url !== undefined && typeof object.api_url !== 'string'
      || object.agent_key !== undefined && typeof object.agent_key !== 'string') throw new Error('INVALID_CONFIG');
    saved = object;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('AgentZero 配置文件无法读取或格式错误；需要 api_url 和 agent_key 字符串。');
  }
  const agentKey = env.AGENTZERO_AGENT_KEY ?? saved.agent_key ?? '';
  if (agentKey && !/^azk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(agentKey)) {
    throw new Error('AgentZero 凭证格式错误；请使用平台生成的完整 azk_ 访问凭证。');
  }
  return { apiUrl: validateApiUrl(env.AGENTZERO_API_URL ?? saved.api_url ?? defaultApiUrl), agentKey, configFile: file };
}
