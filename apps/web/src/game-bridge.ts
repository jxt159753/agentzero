export const GAME_PROTOCOL = 'agentzero.game.v1';
export interface GameMessage { protocol: typeof GAME_PROTOCOL; type: 'ready' | 'submit'; request_id: string; score?: string; reward_requested?: string }
const amount = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;

/** Sandboxed frames have an opaque origin. The source window is the authority boundary. */
export function gameMessage(event: MessageEvent, frame: Window | null): GameMessage | null {
  if (!frame || event.source !== frame || !event.data || typeof event.data !== 'object') return null;
  const value = event.data as Record<string, unknown>;
  if (value.protocol !== GAME_PROTOCOL || typeof value.request_id !== 'string' || !/^[\w.:-]{1,80}$/.test(value.request_id)) return null;
  if (value.type === 'ready') return { protocol: GAME_PROTOCOL, type: 'ready', request_id: value.request_id };
  if (value.type !== 'submit' || !amount(value.score) || !amount(value.reward_requested)) return null;
  return { protocol: GAME_PROTOCOL, type: 'submit', request_id: value.request_id, score: value.score, reward_requested: value.reward_requested };
}

const mimeTypes: Record<string, string> = { html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', wasm: 'application/wasm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf' };
export async function readGameFiles(files: File[]) {
  if (!files.length || files.length > 128 || files.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024) throw new Error('游戏包须为 1–128 个文件，总大小不超过 2 MB。');
  const directory = files.every(file => Boolean(file.webkitRelativePath));
  return Promise.all(files.map(async file => {
    const path = directory ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
    const mime = mimeTypes[path.split('.').at(-1)?.toLowerCase() ?? ''];
    if (!mime) throw new Error(`不支持的文件类型：${path}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { path, mime, content: btoa(binary) };
  }));
}
