export interface Config {
  databaseUrl: string; publicOrigin: string; githubClientId: string; githubClientSecret: string;
  bootstrapAdminGithubId: string; production: boolean; host: string; port: number;
  githubAppId?:string; githubPrivateKey?:string; githubPrivateKeyPath?:string; githubWebhookSecret?:string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const origin = new URL(env.PUBLIC_ORIGIN ?? 'http://localhost:5173');
  const production = env.NODE_ENV === 'production';
  if (origin.pathname !== '/' || origin.search || origin.hash) throw new Error('PUBLIC_ORIGIN must be an origin');
  if (origin.protocol !== 'https:' && (production || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('HTTPS is required except for local development');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (env.BOOTSTRAP_ADMIN_GITHUB_ID && !/^[1-9][0-9]*$/.test(env.BOOTSTRAP_ADMIN_GITHUB_ID)) throw new Error('BOOTSTRAP_ADMIN_GITHUB_ID must be a GitHub numeric ID');
  if (env.GITHUB_APP_ID && !/^[1-9][0-9]*$/.test(env.GITHUB_APP_ID)) throw new Error('GITHUB_APP_ID must be a GitHub numeric App ID');
  return { databaseUrl: env.DATABASE_URL, publicOrigin: origin.origin, githubClientId: env.GITHUB_CLIENT_ID ?? '', githubClientSecret: env.GITHUB_CLIENT_SECRET ?? '', bootstrapAdminGithubId: env.BOOTSTRAP_ADMIN_GITHUB_ID ?? '', production, host: env.HOST ?? '127.0.0.1', port: Number(env.PORT ?? 3000),
    githubAppId:env.GITHUB_APP_ID,githubPrivateKey:env.GITHUB_PRIVATE_KEY?.replace(/\\n/g,'\n'),githubPrivateKeyPath:env.GITHUB_PRIVATE_KEY_PATH,githubWebhookSecret:env.GITHUB_WEBHOOK_SECRET };
}
