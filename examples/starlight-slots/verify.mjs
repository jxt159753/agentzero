/* global process */
import { calculateResult } from './rules.js';

const sessionId = process.argv[2];
if (!sessionId) {
  process.stderr.write('用法: node examples/starlight-slots/verify.mjs <服务端对局编号>\n');
  process.exitCode = 1;
} else {
  const result = await calculateResult(sessionId);
  process.stdout.write(JSON.stringify({ session_id: sessionId, ...result }, null, 2) + '\n');
}
