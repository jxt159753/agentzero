import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createAgentZeroServer } from './server.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--config')) {
    throw new Error('用法：node dist/index.cjs [--config 配置文件绝对路径]');
  }
  const server = createAgentZeroServer(loadConfig(process.env, args[1]));
  await server.connect(new StdioServerTransport());
}

main().catch(() => {
  process.stderr.write('AgentZero MCP 启动失败，请检查配置文件及启动参数。凭证只保存在本机，不要发到聊天。\n');
  process.exitCode = 1;
});
