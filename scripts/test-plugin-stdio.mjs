import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = JSON.parse(await readFile(join(root, '.local', 'plugin-release.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(release.plugin, 'plugin.json'), 'utf8'));
const compatibility = JSON.parse(await readFile(join(release.plugin, '.codex-plugin', 'plugin.json'), 'utf8'));
const mcp = JSON.parse(await readFile(join(release.plugin, 'mcp.json'), 'utf8'));
assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
assert.equal(compatibility.name, manifest.name);
assert.equal(compatibility.version, manifest.version);
assert.deepEqual(compatibility.interface, manifest.extensions['com.openai'].interface);
assert.ok(manifest.extensions['com.openai'].interface.shortDescription.length <= 30);
const exportedFiles = await readdir(release.plugin, { recursive: true });
assert.ok(exportedFiles.includes('dist/index.cjs') || exportedFiles.includes('dist\\index.cjs'));
assert.ok(!exportedFiles.some(file => /node_modules|\.pem$|(^|[/\\])\.env($|\.)|(^|[/\\])config\.json$/.test(file)));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(release.plugin, 'dist', 'index.cjs'), '--config', join(release.marketplace, 'unconfigured.json')],
  cwd: release.marketplace,
  // Do not inherit any real platform credentials during protocol verification.
  env: { SYSTEMROOT: process.env.SYSTEMROOT ?? '', PATH: process.env.PATH ?? '' },
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
const client = new Client({ name: 'agentzero-distribution-check', version: '0.1.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'agentzero_accept_task', 'agentzero_get_operation', 'agentzero_get_task', 'agentzero_identity', 'agentzero_register',
    'agentzero_list_tasks', 'agentzero_repositories', 'agentzero_submit_delivery', 'agentzero_wallet',
    'agentzero_propose_agreement','agentzero_respond_agreement','agentzero_submit_contribution',
    'agentzero_propose_cancellation','agentzero_accept_cancellation','agentzero_dispute_task',
    'agentzero_list_conversations','agentzero_list_agents','agentzero_create_conversation','agentzero_get_conversation','agentzero_group','agentzero_read_messages','agentzero_send_message','agentzero_poll_messages',
    'agentzero_reward_catalog','agentzero_redeem_reward','agentzero_list_reward_redemptions','agentzero_get_reward_redemption','agentzero_cancel_reward_redemption',
    'agentzero_market_catalog','agentzero_market_assets','agentzero_get_market_asset','agentzero_buy_market_asset',
    'agentzero_create_market_listing','agentzero_cancel_market_listing','agentzero_update_studio','agentzero_place_market_item',
    'agentzero_world','agentzero_world_studio','agentzero_world_agent','agentzero_world_presence','agentzero_world_leave',
    'agentzero_world_models','agentzero_games','agentzero_create_game','agentzero_update_game','agentzero_game_pool','agentzero_bind_game_machine','agentzero_start_game_session','agentzero_game_session',
  ].sort());
  const result = await client.callTool({ name: 'agentzero_identity', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /CONFIG_REQUIRED/);
  assert.equal(stderr, '');
  process.stdout.write(JSON.stringify({ package: release.plugin, tools: tools.length, stdio: 'passed', missing_credentials: 'CONFIG_REQUIRED' }) + '\n');
} finally { await client.close(); }
