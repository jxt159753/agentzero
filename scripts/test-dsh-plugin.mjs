import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

// Run with DSH's Electron executable and ELECTRON_RUN_AS_NODE=1. This uses its
// real Cordis Loader and MCP bridge, without opening a user profile or model.
assert(process.versions.electron, 'Run this script with the DSH Electron host in Node mode.');
const root = fileURLToPath(new URL('../', import.meta.url));
const pluginDir = process.argv[2] ? resolve(process.argv[2]) : join(root, 'packages', 'agentzero');
const installAnchor = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
assert(existsSync(installAnchor), 'The running Electron executable must belong to DSH.');
assert(existsSync(join(pluginDir, 'dist', 'index.cjs')), 'Build @agentzero/plugin before running this check.');

const requireDsh = createRequire(installAnchor);
const { PluginPackages, loadProfileDirectory, composeEntries, boot } = requireDsh('@deepseek-ai/dsh-app-boot');
const { SystemPrompt } = requireDsh('@deepseek-ai/dsh-system-prompt');
const { ToolsService } = requireDsh('@deepseek-ai/dsh-tools');

const scratchRoot = join(root, '.local');
await mkdir(scratchRoot, { recursive: true });
const profileDir = await mkdtemp(join(scratchRoot, 'dsh-plugin-check-'));
let context;
try {
  const installedPackage = join(profileDir, 'node_modules', '@agentzero', 'plugin');
  await mkdir(installedPackage, { recursive: true });
  for (const file of ['package.json', 'cordis.patch.yml', 'dist/index.cjs']) {
    await cp(join(pluginDir, file), join(installedPackage, file), { recursive: true });
  }
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'agentzero-dsh-protocol-check', private: true,
    dependencies: { '@agentzero/plugin': `file:${pluginDir.replaceAll('\\', '/')}` },
    dsh: { profile: { bundles: ['@agentzero/plugin'] } },
  }));
  const profile = loadProfileDirectory('dsh', profileDir, installAnchor);
  assert.deepEqual(profile.skippedBundles, [], 'DSH rejected the AgentZero bundle.');
  const entries = composeEntries(profile.layers.map(layer => layer.patches));
  const entry = entries.find(item => item.id === 'mcp-agentzero');
  assert(entry, 'The bundle must insert the MCP client entry.');
  assert.equal(entry.name, '@deepseek-ai/dsh-mcp-client');

  const missingConfig = join(profileDir, 'intentionally-missing-config.json');
  assert(!existsSync(missingConfig));
  const configurationPath = join(profileDir, 'isolated.cordis.yml');
  await writeFile(configurationPath, '[]\n');
  // Leave the bundle's expressions and inject declaration intact. Only isolate
  // credentials and make connection failures fail the test immediately.
  const patches = [...profile.layers.flatMap(layer => layer.patches), {
    id: 'mcp-agentzero', config: {
      ...entry.config,
      args: [...entry.config.args, '--config', missingConfig],
      env: { ...entry.config.env, AGENTZERO_AGENT_KEY: '', AGENTZERO_API_URL: 'http://127.0.0.1:1' },
      failOnStartupError: true, reconnect: { enabled: false },
    },
  }];
  context = await boot('agentzero-dsh-check', configurationPath, patches, async ctx => {
    await ctx.plugin(PluginPackages);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolsService);
  }, pathToFileURL(installAnchor).href);
  const loaded = [...context.get('loader').entries()].find(item => item.options.id === 'mcp-agentzero');
  if (loaded?.fiber?._error) throw loaded.fiber._error;
  assert(loaded?.fiber?._effectiveConfig, 'The real Loader must activate the MCP entry.');
  const config = loaded.fiber._effectiveConfig;
  assert.equal(config.command, process.execPath);
  assert.equal(config.args[0], join(installedPackage, 'dist', 'index.cjs'), 'The server must resolve inside the relocated bundle.');
  assert(Object.hasOwn(loaded.fiber.inject, 'pluginPackages'), 'The Loader must inject package resolution into the MCP fiber.');
  const tools = context.get('tools');
  const names = [...tools.view().visible.keys()].sort();
  assert.equal(names.length, 47, 'Expected all 47 AgentZero tools.');
  assert(names.every(name => name.startsWith('mcp__agentzero__agentzero_')));
  const identity = tools.get('mcp__agentzero__agentzero_identity');
  assert(identity);
  // DSH's real MCP bridge converts an MCP isError result into a tool rejection.
  await assert.rejects(identity.execute({}, { signal: new globalThis.AbortController().signal }), /CONFIG_REQUIRED/);
  process.stdout.write(JSON.stringify({
    ok: true, loader: 'real Cordis boot', bundle: '@agentzero/plugin', tools: names,
    identity: 'CONFIG_REQUIRED', userConfigRead: false, modelStarted: false,
  }, null, 2) + '\n');
} finally {
  await context?.fiber.dispose();
  // Remove only the newly allocated test directory, never an existing profile.
  const scratchRelative = relative(scratchRoot, profileDir);
  assert(!isAbsolute(scratchRelative) && /^dsh-plugin-check-[^\\/]+$/.test(scratchRelative));
  await rm(profileDir, { recursive: true, force: true });
}
