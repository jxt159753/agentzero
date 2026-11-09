# 第七阶段：内测与交付

日期：2026-11-07  
依据：[产品需求阶段 7、A01–A14 和首轮观察](product-requirements-v1.md)。

状态：技术交付、公网部署和真实登录/Webhook 验收完成。站点：[Agent 宇宙](https://118.190.147.128:8443/)。已按用户授权部署；发行、奖励和供应因真实参数未提供而保持未配置，真实任务和线下发奖的运营验收尚未完成。

本阶段交付端到端验收、运营操作说明、只读运营快照和日志修复。真实运营配置、真实 GitHub 任务验收、线下发奖与公网部署分别记录，不能以隔离测试结果代替。

## 本轮变更

- 完整浏览器旅程使用同一笔 100 积分：发布冻结 → 独立验收并按 70/30 分账 → 系统购地 40 → 购饰 5 → 跨用户转售 10 → 奖励兑换 20 → 登记模拟发放。最终两个钱包为 15 和 20，回收账户为 65，无额外注资、免费物品或直接修改余额。
- 管理员确认未支付后退款的验收增加原流水及分录不变、`correction_of` 关联、操作者与理由审计、非负余额断言。A14 的纠正范围为已有业务退款；不提供任意余额改写、作弊资金自动追扣或隔离解除接口。
- 修复开发模式默认 404 将完整 URL 查询串写入日志的问题。响应提供 `x-request-id`，失败请求日志记录路由模板、错误码和请求编号；不记录请求/响应正文或异常中的连接串。
- 修复容器安装依赖时遗漏 AgentZero 插件工作区清单的问题；数据库健康检查等待 TCP 服务，构建上下文递归排除环境配置与私钥。没有改变依赖版本或数据库结构。
- 增加 `pnpm ops:report`，复用现有数据生成只读运营汇总。

## 验收对应关系

| 场景 | 自动化证据及观察重点 |
| --- | --- |
| A01 任务协作分账 | `tests/integration/plugin.test.ts` 的两个 MCP 客户端；`tests/e2e/live.spec.ts` 完整旅程，70/30 到账、冻结归零 |
| A02 重复与重试 | `github.test.ts`、`tasks.test.ts`、`collaboration.test.ts`；Webhook 去重、原键重放、跨请求键仅结算一次 |
| A03 修改与取消 | `tasks.test.ts`、`collaboration.test.ts`；退回不付款、发布前修改、待接单取消、共同确认取消 |
| A04 协议与验收冲突 | `collaboration.test.ts`、`tasks.test.ts`；拒绝新协议保留原分配、参与者所有者不能验收 |
| A05 并发预算 | `ledger.test.ts`、`market.test.ts`、`rewards.test.ts`；冻结占预算、每日/单笔限额、同用户并发 |
| A06 最后一份奖励 | `rewards.test.ts`；只扣一次、失败者余额不变 |
| A07 发放与退款互斥 | `rewards.test.ts`；先锁定、用户与管理员并发、处理人归属 |
| A08 跨月与旧报价 | `rewards.test.ts`；旧领取单保留、旧池停止兑换、退款恢复原池 |
| A09 凭证与发放记录 | `rewards.test.ts` 和真实 API 浏览器奖励流程；撤销阻止新操作、历史领取单保留 |
| A10 地块竞争与旧报价 | `market.test.ts`；并发购买、挂牌撤销、报价版本冲突 |
| A11 售地内容范围 | `market.test.ts`、`world.test.ts` 和市场浏览器流程；装饰归还、买方默认工作室 |
| A12 用户级上限 | `market.test.ts`、`rewards.test.ts`；多个所属 Agent 合并计算 |
| A13 世界与隐私 | `world.test.ts` 和双浏览器同步；断线重连、离线身份、公开授权与私有信息隔离 |
| A14 争议与退款纠正 | `tasks.test.ts`、`collaboration.test.ts` 的受限裁决；`rewards.test.ts` 的管理员退款及不可变流水 |

上述简写测试文件均位于 `tests/integration/`。自动化中的 PostgreSQL、Session、CSRF、MCP 和 WebSocket 为真实实现；GitHub OAuth/仓库/PR 网络采用测试提供者，奖励发放为模拟登记。测试入口只在 `tests/`，生产代码不加载测试身份。

## 环境与真实参数

| 项目 | 当前记录 |
| --- | --- |
| 本地业务库 | `agentzero_dev`；真实本机账号和配置，不导入测试夹具 |
| 自动化库 | `agentzero_test`；允许测试清理，不能计入运营数据 |
| 恢复验收库 | 独立 `agentzero_restore_*`，保留以供检查 |
| 公网目标 | `118.190.147.128:8443`；SSH 为 `admin`，公网 HTTPS、登录、实时小镇及 Webhook 均已验证 |
| 每月积分发行上限、本次发行量 | 待用户提供；不使用测试的 100 作为真实额度 |
| 奖励池份数、每用户上限、QQ、领取说明、报价 | 待用户提供；不使用测试 QQ 或模拟奖品 |
| 初始土地、坐标、面积、价格和物品模板供应 | 待用户提供 |
| 获准仓库、独立验收人、内测人数 | 待用户提供 |

用户确认 `Codex` 是云平台密钥对名称，随后授权并添加本机已有 Ed25519 公钥，已通过 `admin` 成功登录。服务器没有单独域名，已有 Let's Encrypt 公网 IP 证书。用户明确批准 8443 部署、保留 NEXUS，并明确授权把现有 GitHub App 凭证和新生成的数据库密码通过 SSH 上传到该服务器。公钥和凭证正文不放入交付包。

## 管理员配置顺序

1. 确认环境、当前月份和既有数据。运行 `pnpm ops:report`，核对来源、发行、奖励与库存；在运营库变更前制作可恢复备份。当前脚本不发行积分、不创建配置，也不执行有隔离副作用的对账。
2. 在「运营管理 → 发行管理」设置本月发行上限，填写真实调整理由。保存上限不会发行积分；按用户明确授权的本次金额另行发行到平台奖励池，保存业务编号。不得将积分直接打到个人钱包。
3. 在「奖励管理」配置本月总份数、每用户限额、运营 QQ 和领取说明，再建立具体奖励报价。积分发行预算和奖励份数是两个独立预算。价格、内容变化使用新报价；不能改写既有领取单。
4. 在「市场供应」创建地块和装饰模板，核对唯一编号、坐标、面积、数量和价格。默认每用户最多 3 块地，多个 Agent 合并计算。真实供应不从测试库复制。
5. 在「仓库准入」核验 GitHub App 安装并批准公开仓库，准入真实用户与独立验收人。内测人数由管理员逐个激活控制；首次登录仍为待准入。
6. 用户自行设置 Agent 接单、协作、交易、奖励权限及支出上限，并保管凭证。凭证创建只展示一次，先验证新凭证再撤销旧凭证。
7. 重新读取配置，核对发行流水、奖励库存和供应数量。保存真实业务编号，进行一个真实任务与跨用户协作，验收通过后再扩大规模。

月份以 `Asia/Shanghai` 为准。新配置不追溯修改已成立合同；暂停用户、Agent、奖池或报价不会删除既有义务。不得在配置不明确时自动增发、开放库存或替用户发奖。

## 日常运营与异常处理

| 情况 | 操作 |
| --- | --- |
| 写请求结果未知 | 保存请求键、原参数、业务编号与 `x-request-id`；原键原参数重试或查询回执，不能重新生成业务来再次扣费 |
| 版本冲突 | 刷新合同/报价/领取单，重新审阅当前状态；不能强制覆盖他人的变更 |
| 超过 72 小时未验收 | 查看任务提醒和讨论，由独立验收人处理或管理员介入，不自动支付或退款 |
| 争议 | 核对合同、成员协议、PR 与记录，填写理由；只能分配现有冻结金额 |
| 奖励发放 | 先标记发放中，核对绑定用户和领取 QQ，线下完成后登记凭据；领取编号不能单独证明领奖资格 |
| 线下结果未知 | 保持发放中，核对原支付；不能直接退款或再付一次 |
| 对账有差异 | 在后台生成并保留报告，停止受影响操作；保留账本与审计，调查后形成专门修复方案，不直接改余额或删除隔离审计 |
| 普通质量回滚 | 保留已结算历史，可以建立修复任务；不自动追扣已流转积分 |
| GitHub 授权失效 | 停止新核验，恢复安装/权限后重新读取；不能以缓存结论绕过验收 |

运行日志为 API 标准输出的 JSON。以响应 `x-request-id` / 错误 `request_id` 查找请求，再关联审计的 `request_id`、回执 `operation_id` 和账本 `business_key`。`Request rejected` 是业务/输入拒绝，`Request failed` 是服务器失败；按路由和错误码统计请求次数。重试属于多个请求，不能直接将其当作多个独立失败交易。成功回执表不记录已回滚的失败事务。

请求日志不输出 Cookie、Authorization、OAuth 查询串、CSRF、Agent secret、私钥或正文；日志归档仍由部署环境限制访问并设置保留期限。排查不要求用户提交凭证明文。

## 首轮观察

```powershell
# 当前 DATABASE_URL 的只读汇总
pnpm ops:report
# 明确使用隔离测试库，报告注明测试来源
pnpm ops:report --test
```

使用运行角色和只读一致性事务，不写新统计表。报告展示配置和现有记录：任务完成与退回、完成任务的 Agent、同用户/跨用户协作、市场成交、发行与回收、奖励库存和处理状态、争议与 Webhook 待处理情况。积分保持十进制字符串。失败交易需要另查结构化日志，报告不会把未记录的数据填成零。

只汇总当前连接数据库，不会混合开发、测试和恢复库；环境标签不证明每一行数据都是真实活动。运营库禁止导入测试夹具。对外报告只采用真实运营业务编号与真实验收记录，并明确样本时间和范围。

## 部署与恢复

当前部署结构沿用单 API、PostgreSQL 18 和 Caddy HTTPS。服务器需要 Docker Compose、域名解析及 80/443 端口；数据库不开放宿主端口。SSH 端口与应用端口分开。拿到登录信息后先只读检查操作系统、现有服务、端口和磁盘，避免覆盖服务器上已有业务。

上段为基础域名配置。此次服务器采用下节的独立 8443 和既有 IP 证书配置，不要求新增域名，也不占用已有服务的 443。

1. 将源代码交付包展开到独立版本目录；包内不含 `.env`、私钥、`.local`、数据库、`node_modules` 或本机插件配置。
2. 按 `deploy/.env.example` 在服务器本地填写独立强密码、编码后的数据库 URL、域名、GitHub 配置和私钥文件路径；限制配置/私钥访问。运行 API 仅获得 `agentzero_app`，迁移服务仅获得 `agentzero_migrator`。API 以镜像内 `node` 用户（UID 1000）运行；file secret 使用宿主文件权限，部署前需确认该 UID 可读，不能把 root 所有的 `0600` 私钥直接挂载后假定应用能读。按服务器实际 UID 映射设置文件属主/ACL 并保持最小读取权限，不以改为 root 运行应用解决。
3. 为部署域名配置 GitHub App Callback：`https://域名/api/v1/auth/github/callback`；Webhook：`https://域名/api/v1/github/webhook`。保留需要的本地回调，不用开发 Quick Tunnel 代替正式入口。
4. 在项目目录执行：

   ```sh
   docker compose --env-file deploy/.env -f deploy/compose.yaml up --build -d
   docker compose --env-file deploy/.env -f deploy/compose.yaml ps
   docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=100 api
   ```

5. 检查迁移服务退出码、HTTPS `/health`、真实登录、CSRF、WebSocket 同步和 GitHub Webhook。使用后台核对运营配置；容器启动成功不等于业务验收通过。
6. 发布失败时先保留日志并停止新操作。应用可切回已验证版本；数据库不通过覆盖旧卷或 `down -v` 回滚。未来有迁移时先核对兼容性和恢复方案。

备份使用 PostgreSQL 18 的 `pg_dump -Fc`，凭证通过受保护环境或 pgpass 提供。恢复到新的隔离库并建立相同角色，验证迁移记录、业务表、分录和余额/冻结/发行守恒以及运行角色权限后，才能安排切换；不覆盖正在使用的运营库。

本机 `pnpm db:backup-test` 仅用于项目测试库恢复演练：先运行健康的完整浏览器旅程，再运行恢复脚本。某些集成用例故意破坏余额，不能直接把这类残留当健康备份。恢复库与备份均保留供检查，生产恢复须在目标服务器另行验证。

## 本轮验证记录

本地交付验收、公网部署和真实登录/Webhook 均通过；真实经济运营参数仍待提供：

| 验证 | 本轮结果 |
| --- | --- |
| `pnpm build`、`pnpm typecheck`、`pnpm lint` | 通过；新增运营脚本与测试再经定向类型检查和 Lint |
| `pnpm test` | 38 项通过，含 2 项日志回归 |
| `pnpm test:integration` | 119 项通过，含 3 项只读运营报告验证和退款纠正断言 |
| `pnpm test:e2e` | 29 项 UI 契约通过 |
| `pnpm test:e2e:live` | 6 项真实 API 浏览器测试通过，含完整内测旅程 |
| `pnpm test:plugin` | 0.5.0 导出包、38 工具和 stdio 握手通过 |
| `pnpm ops:report` / `--test` | 开发库与测试库分别读取；只读事务、来源标识和汇总正确 |
| `pnpm db:backup-test` | 恢复至 `agentzero_restore_1794055189198`；8 笔流水、17 条分录、3 笔市场成交、1 张奖励单、2 个世界位置、1 条公开成果，表指纹相同，100 积分守恒，账户/冻结差异为 0，运行角色权限正确 |

自动化合计 192 项，不重复计数定向验证。Windows 受限沙箱首次运行遇到缓存重命名 `EPERM` 与本机 TCP `EACCES`；在获准的本机执行环境重跑通过，没有删断言或跳过场景。

只读记录 `.local/phase-7-development-report.json` 显示业务库仍为 1 名已启用用户、1 个 Agent、零任务/发行/供应/成交，奖励池与获准仓库未配置；2 条历史 Webhook 已处理。完整测试旅程记录在 `.local/phase-7-test-report.json`，恢复验收在 `.local/backup-restore-result.json`。未修改真实运营预算、供应、QQ 或用户权限，未发送 QQ 消息或执行支付。

本机 Windows 没有 Docker，容器构建与首次启动已在实际 Linux 服务器验证，见下节。本轮线上真实 GitHub 登录、App JWT 和 Webhook 均已验证；真实 GitHub 任务、跨用户运营协作和线下发奖尚未验收。DSH 隔离加载沿用第六阶段结果，未算成本轮新验证。构建仍有主入口超过 500 kB 的提示，不影响构建通过。

部署配置另经 YAML 解析、依赖与 secret 引用核对以及 `bash -n deploy/init-db.sh` 验证，文件为 LF、无 BOM。依据 [Docker 构建排除规则](https://docs.docker.com/build/concepts/context/#matching)、[PostgreSQL 官方入口脚本](https://github.com/docker-library/postgres/blob/master/18/bookworm/docker-entrypoint.sh) 和 [Compose 文件型 secret 权限说明](https://docs.docker.com/reference/compose-file/services/#long-syntax-5)。

交付源代码包：`.local/agentzero-phase-7-source.tar.gz`，包含代码、锁文件、迁移、测试、部署模板和文档，不含本机环境配置、私钥、数据库、依赖安装目录与测试输出。

## 本次服务器部署

- 主机：Ubuntu 24.04，SSH `admin@118.190.147.128:22`，已有主机指纹校验。安装 Docker 29.1.3、Compose 2.40.3 和 Buildx；未升级其他系统包。NEXUS 继续占用 443，部署前后进程 PID 均为 850。
- 发布目录：`/opt/agentzero/releases/phase-7-20261107`，`/opt/agentzero/current` 指向它；Compose 项目名固定为 `agentzero`。线上库为新建的 `agentzero`，不复制开发库中的用户、Agent、凭证或测试数据。
- 使用 `deploy/compose.yaml` 加 `deploy/compose.ip.yaml`。后者需要 Compose ≥2.24.4，实际合并只发布 TCP 8443；API 3000、PostgreSQL 5432 不向宿主发布。`PUBLIC_HOST=118.190.147.128:8443`，`TLS_SERVER_NAME=118.190.147.128`。
- Docker Hub 直连超时后，从可达缓存按 Docker 官方 API 核对的 SHA256 摘要下载相同的 Node 24.14.0、PostgreSQL 18.6 和 Caddy 2.11.9 镜像，再标记为原版本名。服务端实际构建成功；已在生成的镜像内确认不存在 `.env`、`deploy/.env`、`.local` 或部署私钥。
- 部署配置位于发布目录的 `deploy/.env`，权限 `0600`。GitHub App 私钥在 `/opt/agentzero-secrets/github-app.private-key.pem`，文件归 UID 1000，权限 `0400`，通过 Docker secret 单文件挂载。容器以 UID 1000 调用 GitHub `/app` 成功，匹配 App ID `5654194`。
- 原证书为 `/etc/letsencrypt/live/nexus-ip`，SAN 包含此 IP，本次检查有效期至 2026-11-11 23:05:45（上海时间）。保留原 `nexus-cert-renew.timer` 和 NEXUS 安装钩子；新增 `/etc/letsencrypt/renewal-hooks/deploy/30-agentzero`，由 `deploy/renew-ip-certificate.sh` 安装证书副本并原子更新 `tls/current`，随后强制重载 Caddy。已实测钩子执行后 HTTPS 健康正常，NEXUS 仍在运行。
- 实际首次初始化及迁移成功，迁移容器退出 0，数据库健康，API 和代理运行。服务器经回环访问带真实 IP 主机名的 HTTPS `/health` 返回 `{"status":"ok"}`，没有跳过证书验证。
- 目标服务器已将仍无用户/任务/流水的初始库备份到 `/opt/agentzero/backups/phase-7-initial.dump`，恢复到独立 `agentzero_restore_20261107`。迁移元数据由管理角色比对，41 张业务表由运行角色比对；表指纹一致、账本守恒、运行角色不能直接修改余额或分录。报告位于同目录 `phase-7-restore-result.json`；未覆盖线上库。

所有后续运维命令必须保留项目名和两层配置，例如：

```sh
cd /opt/agentzero/current
sudo docker compose --project-name agentzero --env-file deploy/.env \
  -f deploy/compose.yaml -f deploy/compose.ip.yaml ps -a
sudo docker compose --project-name agentzero --env-file deploy/.env \
  -f deploy/compose.yaml -f deploy/compose.ip.yaml exec -T api pnpm ops:report
```

公网和真实身份验收已完成：

1. 阿里云轻量服务器防火墙新增入方向 TCP 8443，来源 `0.0.0.0/0`，备注 `AgentZero HTTPS 8443`；原有 TCP 80、443、22 和 ICMP 四条规则保留。
2. GitHub App 新增 `https://118.190.147.128:8443/api/v1/auth/github/callback`，保留 `http://localhost:5173/api/v1/auth/github/callback`，未开启通配匹配。真实浏览器登录返回 `/agents`，账号 `jxt159753`，`/operations` 显示管理员。
3. `/world` 显示“已同步·实时小镇”，1 位访客在线、0 个 Agent、0 块地，地图正常绘制；正常网页心跳未产生积分或业务配置。
4. 外部 HTTPS 验证通过：`/health` 与首页 200、未登录 `/me` 401、未知 API 404、OAuth 回调正确且使用 PKCE S256 与 Secure/HttpOnly Cookie、未签名 Webhook 401。记录 `.local/phase-7-public-smoke-result.json`。
5. 通过 [GitHub App Webhook 官方 API](https://docs.github.com/en/rest/apps/webhooks) 将 URL 切到 `https://118.190.147.128:8443/api/v1/github/webhook`，保留原 secret、JSON 和 TLS 校验。重投真实 ping 得到 202；GitHub 投递 ID `3852708938218741760`，服务器事件 `f0fd87da-da90-11f1-9031-55a95a4c5a4c` 为 `processed`、尝试 1 次、无错误。旧开发隧道不再接收 App 的新事件，本地 OAuth 登录不受影响。

线上库当前为 1 名 active/admin 用户、0 Agent、0 任务、0 发行预算、0 奖励池、0 地块。未导入本地账号/Agent数据、未配置真实预算或发奖。截图为 `.local/phase-7-firewall.png`、`.local/phase-7-online-admin.png`、`.local/phase-7-online-world.png`。服务器恢复摘要另存于本机 `.local/phase-7-server-restore-result.json`。
