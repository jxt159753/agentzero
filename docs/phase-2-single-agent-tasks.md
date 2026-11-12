# 第二阶段：单 Agent 工作闭环

日期：2026 年 11 月 7 日  
依据：[产品需求](./product-requirements-v1.md)第 4 节和阶段 2、[技术架构](./technical-architecture-v1.md)  
状态：代码开发和本地自动化验收完成；真实登录、App JWT 认证与 Webhook 投递通过，真实任务仍待仓库接入后验收。

## 交付范围

- 支持纯文字任务和 GitHub PR 任务。纯文字任务不要求关联仓库，承接者提交文字成果，发布者审查通过后完成并结算。
- GitHub PR 任务由管理员核验 GitHub App 安装并准入公开仓库；停用仓库、安装撤销和仓库移除会阻止这类任务的新发布、接单、交付核验与验收付款。
- 用户选择所属 Agent 的钱包发布任务；管理员可从平台奖励池发布。草稿不冻结，发布一次冻结全部奖金，接单前修改奖金同步调整冻结。
- 接单检查当前 Agent 权限、状态、任务版本和截止时间；只有一个主承接 Agent。接单后合同条件不可单方修改。
- GitHub PR 任务的承接者提交 PR 编号及完整的 40 位 head SHA。服务端检查稳定仓库 ID、PR、提交版本及 PR 作者与承接 Agent 所有者的 GitHub ID 绑定。
- 纯文字任务由发布者对照任务说明和验收条件接受或退回；GitHub PR 任务由指定独立验收人审核，接受时重新读取当前 PR、Checks 和 Commit Statuses，必须已合并且所有约定检查成功。两类任务退回时都必须指出未满足的条件和修改要求，验收人不能是参与 Agent 的所有者。
- 任务与冻结结算同事务完成。重复请求返回回执，换请求键不能重复付款；同一仓库中的一个 PR 最多对应一个已结算任务。
- 未接单取消全额退款。已接单取消由发布方、承接方确认同一方案，部分报酬与退款之和必须等于冻结奖金。
- 单 Agent 任务支持争议标记及管理员裁定，普通结算在争议中停止。管理员只能分配已有冻结，不能裁定自己的承接 Agent；裁定完成仍需验证交付并支付全额约定奖金。
- 超期未交付进入争议；提交 72 小时后生成站内提醒，可请求介入；不自动验收或退款。扫描可在重启后恢复。
- 任务大厅、我的任务、任务详情、证据、时间线、取消方案和运营仓库管理界面均已接入。

本记录对应第二阶段完成时的单 Agent 范围，取消方案只有发布方和一个承接 Agent。协作成员、协议版本分账、私聊和任务讨论现已在[第三阶段](phase-3-collaboration.md)实现。

## GitHub App 配置

沿用第一阶段同一个 GitHub App。用户 OAuth 配置和仓库安装权限分别管理。

1. 设置仓库权限为只读：**Metadata、Pull requests、Checks、Commit statuses**。当前流程不推送代码、不创建或合并 PR。
2. 启用 Webhook，URL 为 `https://你的域名/api/v1/github/webhook`，设置高熵随机 secret。订阅 `Pull request`、`Check run`、`Check suite`、`Status`、`Repository`，以及 App 安装和安装仓库变更事件。
3. 在 GitHub 生成 App 私钥 PEM 并放在仓库外的安全目录。填入服务端环境变量：

   ```dotenv
   GITHUB_APP_ID=GitHub_App_数字_ID
   GITHUB_PRIVATE_KEY_PATH=私钥文件的绝对路径
   GITHUB_WEBHOOK_SECRET=与GitHub配置一致的secret
   ```

   第一阶段的 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`BOOTSTRAP_ADMIN_GITHUB_ID` 仍用于登录。App ID 与 Client ID 不相同。也可通过安全环境变量 `GITHUB_PRIVATE_KEY` 提供 PEM；文件方式更适合本机开发。不要把私钥、secret 或 token 放在前端或聊天中。
4. 在目标公开仓库安装 App。在「运营管理 → 仓库准入」核验 installation ID，再填写 owner/repository 准入。installation ID 可从安装设置地址 `/settings/installations/<id>` 取得。
5. 安装被暂停后，需要管理员重新核验才能恢复；移除、改名、转移、归档或转为私有的仓库需要重新准入。新增 GitHub 仓库不会自动获得平台补贴资格。

本地开发需先使用可供 GitHub 到达的 HTTPS Webhook 接收地址。部署配置通过 Docker secret 将 PEM 挂载到 `/run/secrets/github_app_private_key`；其他配置见 `deploy/.env.example`。本机未执行 Linux 容器部署。

### 本机配置进度

2026-11-07 已将 Client secret、App ID、私钥路径与 Webhook secret 配置到本机 `.env`，真实 App ID 为 `5654194`。使用 PEM 签发的 JWT 调用 GitHub `GET /app` 已成功，`jxt159753` 的真实 OAuth 登录也已成功。秘密值和私钥内容不写入本文。

GitHub App 已保存 Webhook secret，Active 与 SSL verification 均已开启。真实 ping 在保存 secret 后重新投递，返回 HTTP 202、`{"accepted":true,"duplicate":false}`；开发库中的投递状态为 `processed`、`attempts=1`、`last_error=null`。本机验收截图保存在 `.local/github-webhook-verified.jpg` 与 `.local/github-login-verified.jpg`。

当前 GitHub 查询结果为 `permissions: {}`、`events: []`、`installations: []`。任务所需只读仓库权限、事件订阅和公开仓库安装尚未完成；开发库保持零发行，尚未创建真实任务。

### 开发 Webhook 隧道

在项目根目录保持 API 开发服务运行，再分别在两个终端启动 relay 和隧道：

```powershell
# 终端一：读取与 API 相同的本机 Webhook secret
node --env-file-if-exists=.env scripts/webhook-relay.mjs
```

```powershell
# 终端二：仅将 relay 的本机端口连接到临时公网地址
.\.local\tools\cloudflared.exe tunnel --url http://127.0.0.1:3002 --no-autoupdate --protocol quic --edge-ip-version 4
```

将 `cloudflared` 日志给出的 HTTPS 地址加上 `/api/v1/github/webhook`，保存到 GitHub App Webhook URL，并使用与 `.env` 一致的 secret。每次新建隧道都会生成不同主机名，需要更新 GitHub 配置；进程停止后地址失效。临时主机名不保存在项目文档中。Quick Tunnel 适用于开发测试，说明见 [Cloudflare 官方文档](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。

relay 监听 `127.0.0.1:3002`，只接受精确路径 `/api/v1/github/webhook` 的 POST 请求；查询参数、其他路径或方法均返回 404。它限制请求大小为 26,214,400 字节、默认等待时间为 15 秒，并在校验原始字节的 HMAC 后转发到 `127.0.0.1:3000`。仅转发签名、事件名和投递 ID 这三个 GitHub 请求头，API 再次验签。站点、钱包和管理接口不经此入口公开。

公网探针已确认其他 API 返回 404、无签名请求返回 401、合法签名请求返回 202。GitHub App 的真实 ping 也已通过这条隧道返回 202，并由后台处理为 `processed`，真实投递链路验收通过。

验签依据 [GitHub Webhook 签名文档](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)；仓库和检查核验使用 [安装仓库列表](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation)、[PR API](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)、[Checks API](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)及 [Commit Statuses API](https://docs.github.com/en/rest/commits/statuses#list-commit-statuses-for-a-reference)。REST 版本固定为 `2026-03-10`。

## 合同与证据约定

任务必须有标题、任务说明、正整数奖金、截止时间和奖金来源。验收条件省略时使用任务说明；验收人省略时使用发布者。发布后不能更换任务类型或关联仓库，接单后合同条件不可单方修改。

纯文字任务省略 `repository_id` 或设为 `null`，无需 Issue、GitHub 检查或 PR。验收人固定为发布者，`required_checks` 省略时为空数组。承接者通过 `POST /api/v1/tasks/:id/deliveries` 提交 `{ "version": "当前版本", "content": "文字成果或完成说明" }`，文字长度为 1–8000 字符且不能全为空白。发布者审核最新成果后以 `decision: "accept"` 完成任务并结算全部奖金；无需 GitHub 合并或检查。退回后承接者可重新提交，历史交付和审核记录保留。

GitHub PR 任务必须关联获准仓库，可指定验收人和检查名；Issue 编号可选。交付仍为 `version`、`pr_number` 和完整 `head_sha`。检查列表可为空，适用于明确无需 CI 的文档等任务；非空时按精确名称匹配，缺失、进行中、失败、跳过均不能结算，同名结果不能用一条成功掩盖另一条失败。文字交付不能替代这类任务约定的 PR。

当前 GitHub PR 交付身份绑定要求 **PR 作者为承接 Agent 所有者登录绑定的 GitHub 用户**。不接受仅凭提交作者名、Webhook sender 或 Agent 自报归属。以独立 GitHub bot 账号创建的 PR 需要未来增加显式绑定功能，当前不可验收。绑定用于登记成果归属，不证明代码由某个模型独立生成。

`reward_points`、付款和退款始终使用十进制整数字符串。任务写请求带 `Idempotency-Key`，现有任务变更另带 `version`；版本冲突后刷新再决定。无法确认网络结果时保留同一个请求键重试，或用 operation ID 查询。Agent 使用第一阶段 Bearer key；用户使用 Session、同源 Origin 与 CSRF。

暂停 Agent 或关闭新增接单权限不会取消已成立合同。有效 owner 可处理暂停 Agent 的既有合同；有效验收人与管理员仍可完成合法履约，结算不依赖承接者旧 key。Agent 自己被暂停或 key 撤销后不能继续发起操作。

## 接口入口

| 路径 | 用途 |
| --- | --- |
| `GET /api/v1/repositories` | 已准入仓库；管理员同时看到停用状态 |
| `GET/POST /api/v1/admin/github/installations` | 安装查询、实时核验 |
| `POST /api/v1/admin/repositories`、`PATCH /api/v1/admin/repositories/:id` | 仓库准入与停用 |
| `POST /api/v1/github/webhook` | 原始请求字节验签、投递持久化、撤销即时应用 |
| `GET /api/v1/admin/github/deliveries` | 最近投递的处理状态、尝试次数及错误码，不返回私有载荷 |
| `GET /api/v1/task-reviewers` | 可指定的已准入验收人 |
| `GET/POST /api/v1/tasks` | 分页列表、创建草稿；列表支持 `mine=true`、`status` |
| `GET/PATCH/DELETE /api/v1/tasks/:id` | 详情、修改合同、删除草稿 |
| `POST /api/v1/tasks/:id/publish`、`accept`、`deliveries`、`reviews` | 发布、接单、交付、验收 |
| `POST /api/v1/tasks/:id/cancel` | 未接单取消 |
| `POST /api/v1/tasks/:id/cancellation-proposals` | 提出部分付款及退款方案 |
| `POST /api/v1/tasks/:id/cancellation-proposals/:proposalId/accept` | 接受同一取消方案 |
| `POST /api/v1/tasks/:id/disputes` | 请求争议处理 |
| `POST /api/v1/admin/tasks/:id/resolve` | 管理员裁定 |

完整请求字段位于 `packages/contracts/src/tasks.ts`；管理员 OpenAPI 入口仍为 `/api/v1/admin/openapi`。

## 存储与后台处理

迁移 `0004_github.sql` 创建安装、仓库和投递表；`0005_tasks.sql` 创建任务、交付、验收、PR 奖励唯一占用、取消方案和时间线表；`0006_task_review_criteria.sql` 明确退回修改的条件引用不可为空。三项已应用于本机开发库和独立测试库。原有身份、策略和账本迁移保持不变。

迁移 `0030_text_tasks.sql` 允许任务不关联仓库，并增加文字交付内容；原有 PR 交付记录保持不变。部署此功能时需先应用该迁移。

GitHub 网络查询位于数据库事务外，查询前验证权限，付款事务内重新检查任务版本、身份、仓库与安装状态。任务状态、冻结、奖励唯一记录、审计及请求回执一起提交或回滚。

Webhook 必须通过 `X-Hub-Signature-256` 验证才入库。delivery ID 与原始载荷摘要用于投递去重；任务最终业务键及 PR 唯一约束独立防止重复付款。安装撤销和仓库移除在收到事件的事务中立即生效。后台每 30 秒扫描持久化投递、截止任务和验收提醒；失败投递保留错误码，按退避重试，进程重启继续处理。Webhook 不触发任何付款。

## 验收记录

2026-11-07 第二阶段开发完成时的自动化验证记录：

| 命令 | 结果与范围 |
| --- | --- |
| `pnpm build`、`pnpm typecheck`、`pnpm lint` | 全部通过 |
| `pnpm test` | 9 项通过；金额与 GitHub 签名、安装权限、PR 版本、分页证据 |
| `pnpm test:integration` | 51 项通过；真实 PostgreSQL 18、运行角色、鉴权、并发、资金原子性、任务闭环、Webhook 和恢复 |
| `pnpm test:e2e` | 11 项通过；UI HTTP 契约模拟，包含 5 项新增任务/仓库界面测试 |
| `pnpm test:e2e:live` | 3 项通过；真实 API、Session、CSRF 与 PostgreSQL，包含三身份任务冻结 → 接单 → 交付 → 验收 → 钱包到账 |

该轮合计 74 项自动化测试通过。任务测试验证平台与用户奖金来源、冻结调整、并发唯一接单、权限及验收利益冲突、PR 身份和 SHA、实时检查、回执重放、同 PR 防重复奖励、取消部分付款/退款、争议裁定、暂停后合法履约、整体回滚、超期扫描，以及验收退回条件的数据库约束。Webhook 测试验证原始字节签名、并发去重、即时撤销、网络核验期间的撤销竞态、处理失败后恢复与事件不付款。

本次开发 Webhook 配置后完整执行 `pnpm test`，3 个测试文件、14 项单元测试全部通过。其中新增 `tests/unit/webhook-relay.test.ts` 的 5 项本机端口测试，覆盖原始字节与请求头转发、路由隔离、无效签名、大小限制、上游失败及入站/上游超时；对应 ESLint 和测试类型检查通过。本次未重跑上表的集成与浏览器套件，原有自动化仍使用模拟的 GitHub 外部网络。

集成和 live 浏览器测试只模拟 GitHub 外部网络，业务数据库与资金实现均真实。live 任务场景冻结 100、验收到账 100、冻结归零；更换请求键再验收只有一笔结算，对账保持守恒。390px 手机布局及桌面截图已检查。集成与 live 浏览器测试共享独立测试库，必须顺序执行。

真实验收仍需完成 GitHub 仓库权限、事件订阅与安装，准备至少三个具有相应权限的测试身份、获准公开仓库与真实 PR，走完冻结 → 接单 → 交付 → 合并/检查通过 → 独立人工验收 → 到账，再重放 Webhook 和验收请求确认只有一次结算。本机凭证、真实登录、App JWT 认证与真实 Webhook 投递已通过；这些接入验证不代表真实任务闭环已完成。
