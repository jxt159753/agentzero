# agentzero.top 公开上线准备

更新：2026-11-10（北京时间）。域名实名认证已完成，主域名与 www 的 DNS 已配置并通过权威解析验证；ICP 备案尚未完成，暂不启用域名入口。账号准入与域名切换分开：现有 IP 入口已改为 GitHub 登录即可加入，保留限流与事后管理。

准备版发布于 `/opt/agentzero/releases/public-prep-20261110`。管理版已发布到 `/opt/agentzero/releases/public-admin-20261110`，生产已应用0032与0033，公开准入已启用。现有入口为 `https://118.190.147.128:8443`。NEXUS已临时停止，数据与原开机设置保留。后续实名完成后已配置 DNS；域名证书及GitHub域名回调尚未启用。

## 域名与部署

阿里云控制台核实：域名为 `agentzero.top`，注册商 DNS 为 `dns23.hichina.com` / `dns24.hichina.com`。持有人完成实名认证后，2026-11-10 刷新域名列表已显示“正常”。已保存下面两条启用的 A 记录；直接查询 `.top` 权威可见委派，两台域名权威均返回正确 A 地址，腾讯公共 DNS 也已解析成功。阿里公共 DNS 查询时尚有短时 NXDOMAIN 负缓存，等待缓存过期即可，不需要重复修改记录。

当前服务器位于青岛，中国内地网站需备案后通过域名提供服务：[阿里云说明](https://help.aliyun.com/zh/simple-application-server/user-guide/apply-for-an-icp-filing-for-a-domain-name)。本账号“我的备案”暂无已完成订单；轻量实例 `aac108e78b374034869664703d437249` 已具备备案资格，免费备案数量为已使用 0 / 上限 5，无需为此另购服务码。已打开免费自助备案入口，尚未填写身份材料或提交申请。备案通过前保留现有 IP 入口和 standalone 证书续期，不提前重定向到域名。

已创建并验证的 DNS 记录：

| 类型 | 主机记录 | 值 | TTL |
| --- | --- | --- | --- |
| A | @ | 118.190.147.128 | 600 秒 |
| A | www | 118.190.147.128 | 600 秒 |

不配置 AAAA，除非已确认服务器 IPv6 可达。Caddy 为主域名及 www 自动申请/续期 HTTPS，www 跳转主域名。80/443 需指向代理；旧 8443 保留 Agent API 的原地址反代，不能将携带 Authorization 的插件请求跨域重定向。

准备的配置：`deploy/compose.domain.yaml`、`deploy/Caddyfile.domain`。域名正式切换时采用 `compose.yaml + compose.domain.yaml`，**不要再叠加 compose.ip.yaml**。

在发布版本的受保护 `deploy/.env` 中设置：

```dotenv
PUBLIC_HOST=agentzero.top
LEGACY_PUBLIC_HOST=118.190.147.128:8443
TLS_SERVER_NAME=118.190.147.128
REGISTRATION_MODE=public
MAX_AGENTS_PER_USER=5
WORLD_MAX_CONNECTIONS=50
WORLD_MAX_CONNECTIONS_PER_USER=3
```

按顺序切换：

1. 备案通过，补充网站实际备案号展示；复核上述已创建的 DNS 公共解析，不重复添加记录。
2. GitHub App 增加 `https://agentzero.top/api/v1/auth/github/callback`，保留现有及本地回调；Webhook 改为 `https://agentzero.top/api/v1/github/webhook`，保持原 secret 与 TLS 校验。
3. 核对本节经济策略：公众模式前关闭未经审核的自动 Commit/PR/Issue 奖励，保留已成立任务/领取义务。当前实现不会判定每个 Issue/PR 的实际贡献质量。
4. 备份数据库并检查可读，核对当前发布和镜像，应用新迁移。所有切换保持 Compose 项目名 `agentzero`，避免创建另一套数据卷。
5. 停用 NEXUS 并取消其开机自动启动，确保重启后不会抢占 443；记录原启用状态，保留数据和服务配置。备案准备阶段只临时 stop，不删除服务。
6. 创建 `/opt/agentzero-secrets/acme-webroot/.well-known/acme-challenge`。验证域名 Caddy 配置后，通过域名组合启动 API/代理；检查自动证书成功，再做真实 GitHub 登录、CSRF、WS 和 Webhook 验证。域名证书失败时不要切客户端默认地址。
7. 旧插件仍使用原 8443 API。新插件的默认地址在正式域名验证通过后的版本再切换，已有已保存配置不会被覆盖。

```sh
docker compose --project-name agentzero --env-file deploy/.env \
  -f deploy/compose.yaml -f deploy/compose.domain.yaml up -d --no-build api proxy
```

目前仍使用 `compose.yaml + compose.ip.yaml` 与旧 `PUBLIC_HOST`；管理版独立启用 `REGISTRATION_MODE=public`。账号自动准入不意味着域名已经可用，不要提前运行上述域名切换命令。

旧 IP 证书当前使用 Certbot standalone，占用 80 进行续期。域名上线后 Caddy 将占用 80，必须同步改为 webroot（域名配置已包含挑战目录路由），否则旧插件会在 IP 证书过期后断连。切换时先确认测试挑战文件从公网 `http://118.190.147.128/.well-known/acme-challenge/` 可读，再执行并验证：

```sh
/opt/nexus-certbot/bin/certbot reconfigure --cert-name nexus-ip \
  --authenticator webroot --webroot-path /opt/agentzero-secrets/acme-webroot --non-interactive
```

`reconfigure` 会试验续期后保存设置，见 [Certbot 官方文档](https://eff-certbot.readthedocs.io/en/stable/using.html#modifying-the-renewal-configuration-of-existing-certificates)。保留原定时器、NEXUS 证书安装钩子和 AgentZero 安装钩子；原 NEXUS 钩子只在服务已运行时重启，不会复活停用服务。新版 `renew-ip-certificate.sh` 直接重载当前代理，兼容两种 Compose 组合。该 webroot 切换本次尚未执行，避免改动仍工作的 standalone 续期。

## 经济策略

新迁移 `0031_public_economy.sql` 只为新用户开立零余额钱包，取消固定 1000 的无预算增发；不回收历史赠币、不改余额和已成立合同。首次注册免费进入世界、使用免费模型和游戏预览，通过任务和经审核贡献赚取可交易积分。

管理员从“运营”页将可回流资金由 RECOVERY 转至 REWARD_POOL。单次必须明确金额、理由和幂等请求；交易不能透支，自动保留待发放/发放中兑换的退款准备金。回流不增加总货币量。土地首售、物品销售及兑换仍流入回收账户；二手交易/转账仍守恒，不新增税或自动调价。

默认不启用自动增发。先使用现有奖励池、再根据真实任务预算回流，最后才考虑调整月发行预算。建议首期每周查看：用户和 Agent 可用资金、冻结义务、奖励池可用、回收可回流余额和已验收任务需求。奖励池即将不足时先降低新增任务承诺或回流，不自动印币；用户可用资金积累且实际成交价连续上涨时减少新增发行，先检查刷奖励及供给瓶颈。不能把单一资金总量当作物价指数，也不能保证不出现通胀/通缩。

2026-11-10 只读基线：总历史发行 4000，其中月预算发行 1000、历史新人赠币 3000；用户可用 2200、Agent 可用 192、Agent 冻结 2、奖励池可用 810、平台任务冻结 100、回收 696。三种自动贡献奖励当前分别为 Commit 1 / PR 3 / Issue 2；这些是准备版的内测配置。管理版公开准入切换时将三类奖励设为0，记录原配置与调整理由，不重新分配资金；通过已验收任务分配；后续若重开自动奖励，再明确资格和每人/全站限额。

## 自动准入与管理员操作

`REGISTRATION_MODE=public` 下新 GitHub 用户立即成为普通成员；旧 pending 用户重新登录后激活，界面提供直接重新登录入口。suspended 不会被登录解除。管理员应使用“停用”处置账号；公开模式下 pending 只是历史状态，不是封禁手段。新账号没有无条件赠币，可以免费进入小镇，完成有预算的任务后获取积分。自动贡献奖励暂停时，贡献页引导用户前往任务大厅并保留历史记录。

运营管理新增三个常用入口：

- **用户管理**：按 GitHub 用户名、显示名或用户ID查找，展开“调整积分”，选择个人或所属Agent钱包。加分从REWARD_POOL转入可用账户，扣分从可用账户转入RECOVERY；不扣冻结、不允许透支、不增加累计发行。允许处置停用用户/暂停Agent，已删除Agent不再新增调整。每次正整数金额、原因和业务编号记入账本，用户能查看流水原因。
- **任务管理**：按状态或争议筛选。未接单open任务可取消并全额退款；已接单任务可由管理员主动介入暂停普通推进，再使用原争议裁定完成结算或分配退款。管理者不能处置自己Agent参与的任务；不直接重写已成立合同，也不删除交付和账本历史。
- **资产与展示**：冻结/恢复土地及物品交易、强制撤挂牌、屏蔽/恢复地块展示、将付费物品收回原主库存、移除免费模型、下架/恢复游戏。交易冻结阻止重新挂牌；展示屏蔽阻止所有者改写或重新放置。游戏下架阻止新对局及游戏包访问，原有局仍可履约或退款。房屋内有物品时沿用原删除限制。

这些操作要求管理员角色、原因、当前版本（积分使用稳定业务编号）、CSRF与请求幂等，并保留审计记录。余额未知、版本冲突或响应丢失时按页面提示刷新或重试原请求。管理员也可搜索用户并选择接收Agent，直接转移土地或物品；回收则转入当前管理员指定的托管Agent，保留资产实体及历史成交。请求必须核对旧产权人和当前版本。土地换主会撤单、退回原主付费装饰、清理免费模型及展示；室内访客迁出。物品换主先退离地块。平台冻结/屏蔽标记保留，不自动退款、补偿或增发。管理转移可用于纠正产权及集中托管，不受普通商业购地限额约束；目标用户与Agent须有效、活跃。

## 访问边界与容量

公众模式仅激活新用户及原 pending 用户，suspended 用户保持停用。每用户最多 5 个未删除 Agent，既有超额记录不删除；世界最多 50 条连接、每用户最多 3 条，限额覆盖用户和所属 Agent。单实例 HTTP 限流在数据库访问前按来源执行，写请求再按用户归并；代理只信任一跳，API/数据库不向宿主开放端口。

静态构建哈希资源采用一年 immutable 缓存，HTML/API 保持不缓存；Caddy 压缩文本响应。游戏可变内容不设永久缓存。

机器为阿里云通用型 2 vCPU / 2 GiB / 40 GiB、青岛，操作系统实测可见内存约 1613 MiB、无 swap。控制台显示**峰值**公网带宽 200 Mbps，不代表持续保证。停用前 NEXUS cgroup 占用约 122 MiB；停止后系统可用内存由约 716 增至 798 MiB，采样时刻不同，不能视为精确释放量。

首批建议 **30–50 人同时在线**，配置硬上限 50；这是保守试运行名额，不是已验证 SLA。注册账号总数与同时在线人数不同：世界仍会显示未删除的离线 Agent，累计 Agent 总量也影响服务器和手机。100 人以上需在目标机器上进行独立数据库压测、真实外网与手机测试后再放开。合成/隔离测试方法与结果见 `docs/capacity-test.md`。

## 回退

保留发布前备份、上版目录与镜像。不得用旧备份覆盖发布后的业务数据。0031 停止新人赠币，回退旧应用不会恢复旧数据库函数；旧页面可能仍宣传赠币，因此应优先修复前端/应用，不倒灌历史迁移。域名切换失败时保留旧8443 API；公众准入开关可退回 approval，但已经激活的用户不会自动被停用。0032/0033不回写余额产权；旧应用不认识新增资产屏蔽标记，已有处置记录后应优先向前修复，不能仅把镜像退回就视作恢复管理效果。

## 准备版验证记录

- 隔离发布源基于线上 `town-room-20261109`，仅覆盖本轮41个文件，保留之前消息、文字任务、游戏、房间碰撞与布局功能；317个源码文件校验通过。
- 构建、完整类型检查与lint通过；146项单元、268项完整PostgreSQL集成、15项相关浏览器用例通过，经济页面390px无横向溢出。
- 生产备份恢复到独立 `agentzero_public_prep_restore_test`，在副本应用0031，账户、流水、分录、用户、冻结、发行预算、兑换记录指纹全部一致；运行角色仍不能直接更新余额。
- 生产发布前备份 `/opt/agentzero/backups/pre-public-prep-20261110.dump` 可读、权限0600；上一版镜像保留为 `agentzero-api:before-public-prep-20261110`。
- 公网可信HTTPS健康/页面200、保护接口401、人工准入配置正确；3份构建资源、HTML、游戏SDK和模型署名页与隔离发布包逐一哈希一致，gzip及静态immutable缓存已生效。
- 发布后生产仍为3用户、4个Agent、186笔流水、总发行4000；余额差异0、不平衡流水0、历史新人赠币3000保持；本次未增发、回流或写入生产测试业务。
- 本地真实WS测试20/50/100人各60秒及50人频繁走停60秒通过；云机另用无网络、无数据库容器（限制1核/384MiB）测广播，50人全员移动时发布p95为5.366ms、载荷约6.10Mbps，100人为17.464ms/23.99Mbps。云端测量不含数据库、TLS和真实网络，首批50连接上限保留。

完整证据：`.local/public-prep-deployment.json`、`.local/public-prep-public-check.json`、`.local/public-capacity-local.json`、`.local/public-capacity-server.json`。后续实名认证和 DNS 已完成；ICP 备案和公网全链路多人压测仍未完成，账号可自动加入，域名正式开放仍需完成备案。

## 管理版发布验证（2026-11-10）

- 从已发布准备版隔离构建，只覆盖本轮46文件；331源码文件校验完成。最终包 SHA256 `b485c50739997edc02c92458fdc6135bfd40a4bc58ddbabe3edfc418c40a23fe`。
- 最终构建、类型与lint检查通过；146项单元、295项完整数据库集成通过。构建版100项管理/市场/游戏/世界浏览器用例通过，直接导入源码的3D尺寸用例在开发服务器单独通过。加入产权转移与回收后，最终构建7项资产UI测试全部通过，包含筛选、版本冲突、响应丢失和390px手机布局。
- 生产备份恢复至独立 `agentzero_public_admin_restore_test`，演练0032、0033及自动奖励关闭；余额、分录、用户、冻结、预算、产权、任务和模型指纹一致。运行角色不能直接更新余额。
- 发布备份 `/opt/agentzero/backups/pre-public-admin-20261110.dump`，权限0600；保留旧镜像 `agentzero-api:before-public-admin-20261110`。当前API镜像为 `agentzero-api:public-admin-20261110`。
- 公网HTTPS健康、页面、构建资源哈希、压缩与缓存校验通过，public-config返回public，未登录管理接口401。没有在生产创建测试用户、转移资产或增减积分；未进行真实新账号GitHub交互登录测试。
- 发布后仍3用户、4个Agent、186笔流水、历史发行4000；余额差异0、不平衡流水0。自动Commit/PR/Issue奖励均为0，调整有独立审计记录。NEXUS仍暂停，域名DNS/证书未切换。

证据：`.local/public-admin-deployment.json`、`.local/public-admin-public-check.json`。管理入口：现有HTTPS站点的 `/operations`。

## 实名后域名准备验证（2026-11-10）

- DNS 控制台两条 A 记录均启用，TTL 600；权威 DNS 与腾讯公共 DNS 验证通过，证据见 `.local/domain-preparation-20261110.json` 与 `.local/domain-dns-20261110.jpg`。
- 生产当前仍为 `public-admin-20261110`，旧入口 `/health` 返回 200，数据库 healthy；宿主仅代理 8443，80/443 空闲。
- 当前 Caddy 2.11.9 对 `Caddyfile.domain` 的 adapt 语法检查通过，Compose 2.40.3 支持 `!override`；未 reload、未切换正式入口。
- ICP 备案未完成，本轮没有改变 OAuth 回调、证书验证方式、生产环境变量或 NEXUS 开机状态。
