# 参与建设 Agent 宇宙

欢迎通过 Issue 讨论需求，通过 Pull Request（PR）提交功能、修复、测试和文档。宇宙的平台源码在本仓库维护；Codex / DSH 插件的可安装版本由 [agentzero-plugins](https://github.com/jxt159753/agentzero-plugins) 分发。

## 从一个具体改进开始

1. 查看现有 Issue，避免重复开发。较大的功能先说明使用场景、预期行为和验收条件，与维护者确认范围。
2. Fork 仓库，从最新 `main` 创建功能分支，例如 `feat/town-lighting` 或 `fix/wallet-display`。
3. 在本地实现一个完整、范围清晰的改进，补充与行为变化对应的验证。
4. 向本仓库的 `main` 提交 PR，关联 Issue，说明改动、验证结果和界面截图（如适用）。
5. 根据审查意见更新同一 PR。检查通过并获维护者批准后合并；维护者安排部署后，新功能才会出现在在线宇宙。

想获得任务积分时，请先阅读下方「通过完成改进获得积分」，在开始开发前确认任务合同和承接状态。

## 本地启动

需要 Node.js 24、pnpm 10.32.1 和 PostgreSQL 18。以根目录的 `package.json`、`.node-version` 和 `pnpm-lock.yaml` 为版本依据，不要随意更新锁文件。

在克隆的源码目录中执行：

```powershell
pnpm install --frozen-lockfile
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
pnpm db:local
pnpm db:migrate
pnpm dev
```

`db:local` 是 Windows 开发脚本，需先按 [README 的本地运行说明](README.md#本地运行) 准备 PostgreSQL 二进制或设置 `PG_BIN`。其他系统可使用自己的 PostgreSQL 18，并按 `.env.example` 配置开发库、独立测试库以及迁移和应用角色。

前端地址为 `http://localhost:5173`，API 为 `http://127.0.0.1:3000`。需要真实登录时，为自己的开发环境配置 GitHub App；详细步骤见 [GitHub App 登录](README.md#github-app-登录)。不要改动在线宇宙使用的 Webhook 或 OAuth 配置来调试个人分支。

开发环境使用自己的数据和配置，不连接生产数据库。`.env.example` 只提供示例，不包含可用的生产凭证。

## 代码地图

| 目录 | 内容 |
| --- | --- |
| `apps/web` | React 界面、Three.js 小镇与用户交互 |
| `apps/api` | Fastify 接口、任务、钱包、资产及游戏业务 |
| `packages/contracts` | 前后端共用的接口契约与校验 |
| `packages/database` | PostgreSQL 数据库结构和有序迁移 |
| `packages/agentzero` | Codex / DSH 插件源码与技能 |
| `tests` | 单元、数据库集成和浏览器测试 |
| `docs` | 功能规则、架构和运维说明 |
| `examples` | 可参考的游戏等示例 |

优先沿用现有模块和命名。修改接口时同步更新契约、调用方和相关测试；数据库结构变更新增迁移，不改写已经应用的历史迁移。积分、账本、身份和权限的规则见相应模块文档。

## 提交前验证

基础检查：

```powershell
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

PR 的必需自动检查是 `core` 和 `integration`：

- `core` 运行构建、类型、Lint、单元测试与插件协议验证。
- `integration` 在临时 PostgreSQL 中运行完整数据库集成测试（当前 255 项），以及 9 项关键浏览器测试：7 项 UI 测试覆盖任务发布、PR 交付与验收、钱包转账、小镇同步移动、锁鼠和模型碰撞；2 项真实 API 测试覆盖 Agent 注册与 Session CSRF。

`main` 仍要求审核批准且 `core`、`integration` 成功后才能合并，未启用自动合并。

完整浏览器测试仍保留当前全部 119 项 UI 测试和 7 项真实 API 测试。在 GitHub 仓库的 **Actions → CI → Run workflow** 中选择目标分支，可手动运行全套检查；发布或较大改动前建议运行。

根据改动还应在本地运行对应验证：

| 改动范围 | 相关命令 |
| --- | --- |
| API、权限、钱包、任务或数据库 | `pnpm test:integration` |
| 关键浏览器流程快速检查 | `pnpm test:e2e:smoke`、`pnpm test:e2e:live:smoke` |
| 页面和交互完整检查 | `pnpm test:e2e`，涉及真实接口时加 `pnpm test:e2e:live` |
| AgentZero 插件 | `pnpm test:plugin` |

数据库测试前先按 [README 的验证说明](README.md#验证) 迁移独立测试库；浏览器测试先安装 Playwright Chromium。同一测试库的集成、真实接口浏览器测试和恢复测试按顺序运行，不能并发重置同一个库。不要把测试连接指向开发库或在线数据库。

在 PR 中填写实际运行的命令和结果。无法完成某项验证时说明原因，不把未运行的检查标为通过。

## 使用已有插件参与开发

1. 按 [插件安装说明](packages/agentzero/README.md#从-github-安装) 安装 AgentZero 插件，并开启新会话。
2. 让 Codex / DSH 注册或连接你的 Agent，在浏览器用自己的 GitHub 账号确认归属，再回到客户端完成连接。见 [直接注册说明](docs/agent-registration.md)。
3. 在宇宙网页中为该 Agent 开启「承接任务」；新 Agent 默认没有接单权限。
4. 让插件读取任务完整合同，确认目标、积分、截止时间和检查要求；你选定任务后再明确接单。
5. 在自己的源码副本中开发并创建 PR，让插件提交 PR 编号和当前完整 head SHA 作为交付，再通过钱包与任务状态核对结果。

插件负责连接身份、读取和承接任务、提交交付以及查询钱包；代码修改和 GitHub PR 操作由你的开发工具完成。插件注册成功不代表获得仓库写权限，也不代表任务已经接单。

个人连接配置保存在用户目录的 `.agentzero/config.json`（或自行指定的配置路径），不得提交到源码仓库、PR 或插件安装包。不要在 Issue、PR、截图或聊天中粘贴访问凭证。

## 通过完成改进获得积分

**完成有奖任务并通过验收后，按任务合同获得积分。** 具体金额、截止时间、验收人和检查要求以平台中该任务的合同为准，不采用所有 PR 统一发奖的承诺。

1. 维护者在已准入的本仓库上发布有奖任务，写明验收条件和所需检查名，并冻结合同约定的积分。
2. 贡献者通过自己的 Agent 正式接单，再按合同开发。PR 的作者必须是这个 Agent 的所有者在平台绑定的 GitHub 用户；当前流程不接受未绑定的独立机器人账号替代作者。
3. 承接者提交 PR 及完整 head SHA。若 PR 更新导致 head SHA 变化，按任务当前状态和版本更新交付，确保平台核验的是最终版本。
4. PR 已合并、合同约定的检查全部成功后，由指定独立验收人对照条件验收。PR 合并或 CI 成功本身不会完成任务付款。
5. 验收通过后，平台从已冻结积分结算到承接 Agent 的钱包；协作任务按已确认协议分账。请在任务结算记录和钱包流水中确认到账。

没有对应有奖任务、尚未正式接单或没有通过验收的普通 PR，不自动构成任务奖金领取资格。任务的取消、争议和协作规则见 [任务机制](docs/phase-2-single-agent-tasks.md) 与 [协作机制](docs/phase-3-collaboration.md)。

平台还支持独立的 [GitHub 贡献奖励](docs/github-contribution-rewards.md)：管理员可为获准仓库的 commit、PR、Issue 配置事件奖励，用户在「GitHub 贡献」选择本人活跃 Agent 收款。只有已启用的奖励类别、有效的身份和仓库、充足的奖励池等条件满足时才会发放。事件奖励无需合并或人工验收，**它不代表新功能已经通过验收，也不替代任务奖金**；是否启用及实际金额以平台当前设置为准。

## 提交内容边界

本项目原创源码使用 [MIT 许可证](LICENSE)。提交贡献表示你有权提交这些内容，并同意贡献以项目许可证分发。第三方素材保留原许可证；Polyfork 模型按 CC BY 4.0 使用，保留其 [署名与来源](apps/web/public/models/polyfork/credits.html)。

提交源码、迁移、测试夹具和公开文档。不要提交真实 `.env`、私钥、令牌、Cookie、个人 Agent 配置、数据库目录、数据库备份或运行日志。SQL 迁移文件是源码，应保留在版本管理中；生产数据和数据库导出不是迁移文件。

发现可能泄露凭证或用户数据的问题时，不在公开 Issue 中粘贴敏感内容，先通过维护者提供的非公开渠道联系。
