import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, validateApiUrl } from '../../packages/agentzero/src/config.js';

const folders: string[] = [];
const key = 'azk_12345678-1234-1234-1234-123456789abc.' + 'a'.repeat(43);
function configFile(text?: string) {
  const folder = mkdtempSync(join(tmpdir(), 'agentzero-config-'));
  folders.push(folder);
  const file = join(folder, 'config.json');
  if (text !== undefined) writeFileSync(file, text);
  return file;
}
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('AgentZero local plugin configuration', () => {
  it('starts without credentials for tool discovery, and loads a BOM-prefixed local config', () => {
    expect(loadConfig({}, configFile())).toMatchObject({ apiUrl: 'https://118.190.147.128:8443', agentKey: '', configFile: expect.any(String) });
    expect(loadConfig({}, configFile('\uFEFF' + JSON.stringify({ api_url: 'https://agents.example/', agent_key: key })))).toMatchObject({ apiUrl: 'https://agents.example', agentKey: key });
  });
  it('supports explicit environment overrides without reading platform .env', () => {
    const file = configFile(JSON.stringify({ api_url: 'https://agents.example', agent_key: key }));
    const override = key.replace(/a{43}$/, 'b'.repeat(43));
    expect(loadConfig({ AGENTZERO_CONFIG_FILE: file, AGENTZERO_AGENT_KEY: override, AGENTZERO_API_URL: 'http://localhost:3000' })).toEqual({ apiUrl: 'http://localhost:3000', agentKey: override, configFile: file });
  });
  it('rejects credential-bearing URLs, nonlocal cleartext and paths before any network request', () => {
    for (const value of ['http://agents.example', 'https://user:pass@agents.example', 'https://agents.example/api/v1', 'https://agents.example/?token=x', 'https://agents.example/#x', 'file:///tmp/config']) {
      expect(() => validateApiUrl(value)).toThrow();
    }
    expect(validateApiUrl('http://[::1]:3000')).toBe('http://[::1]:3000');
  });
  it('reports invalid configuration without including credential content', () => {
    for (const value of [JSON.stringify({ agent_key: 'private-value' }), '{"agent_key":"private-value"', JSON.stringify({ agent_key: 'private-value', unsupported: true })]) {
      let message = '';
      try { loadConfig({}, configFile(value)); } catch (error) { message = (error as Error).message; }
      expect(message).not.toBe('');
      expect(message).not.toContain('private-value');
    }
    expect(() => loadConfig({}, './config.json')).toThrow('绝对路径');
  });
});
