export interface Config {
  databaseUrl: string; publicOrigin: string; githubClientId: string; githubClientSecret: string;
  bootstrapAdminGithubId: string; production: boolean; host: string; port: number;
  githubAppId?:string; githubPrivateKey?:string; githubPrivateKeyPath?:string; githubWebhookSecret?:string;
  registrationMode?: 'approval' | 'public'; trustProxyHops?: 0 | 1;
  maxAgentsPerUser?: number; worldMaxConnections?: number; worldMaxConnectionsPerUser?: number;
}
function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key];
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${key} must be a positive integer`);
  return Number(value);
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const origin = new URL(env.PUBLIC_ORIGIN ?? 'http://localhost:5173');
  const production = env.NODE_ENV === 'production';
  if (origin.pathname !== '/' || origin.search || origin.hash) throw new Error('PUBLIC_ORIGIN must be an origin');
  if (origin.protocol !== 'https:' && (production || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('HTTPS is required except for local development');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (env.BOOTSTRAP_ADMIN_GITHUB_ID && !/^[1-9][0-9]*$/.test(env.BOOTSTRAP_ADMIN_GITHUB_ID)) throw new Error('BOOTSTRAP_ADMIN_GITHUB_ID must be a GitHub numeric ID');
  if (env.GITHUB_APP_ID && !/^[1-9][0-9]*$/.test(env.GITHUB_APP_ID)) throw new Error('GITHUB_APP_ID must be a GitHub numeric App ID');
  const registrationMode = env.REGISTRATION_MODE ?? 'approval';
  if (registrationMode !== 'approval' && registrationMode !== 'public') throw new Error('REGISTRATION_MODE must be approval or public');
  const trustProxyHops = env.TRUST_PROXY_HOPS ?? '0';
  if (trustProxyHops !== '0' && trustProxyHops !== '1') throw new Error('TRUST_PROXY_HOPS must be 0 or 1');
  return { databaseUrl: env.DATABASE_URL, publicOrigin: origin.origin, githubClientId: env.GITHUB_CLIENT_ID ?? '', githubClientSecret: env.GITHUB_CLIENT_SECRET ?? '', bootstrapAdminGithubId: env.BOOTSTRAP_ADMIN_GITHUB_ID ?? '', production, host: env.HOST ?? '127.0.0.1', port: Number(env.PORT ?? 3000),
    githubAppId:env.GITHUB_APP_ID,githubPrivateKey:env.GITHUB_PRIVATE_KEY?.replace(/\\n/g,'\n'),githubPrivateKeyPath:env.GITHUB_PRIVATE_KEY_PATH,githubWebhookSecret:env.GITHUB_WEBHOOK_SECRET,
    registrationMode, trustProxyHops: Number(trustProxyHops) as 0 | 1, maxAgentsPerUser: positiveInteger(env, 'MAX_AGENTS_PER_USER', 5),
    worldMaxConnections: positiveInteger(env, 'WORLD_MAX_CONNECTIONS', 50), worldMaxConnectionsPerUser: positiveInteger(env, 'WORLD_MAX_CONNECTIONS_PER_USER', 3) };
}
