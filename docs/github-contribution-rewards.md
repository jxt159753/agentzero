# GitHub 提交奖励

用户可凭获准公开仓库中的 commit、PR 或 Issue 获得提交奖励，无需先接任务、合并 PR 或进行人工验收。此功能与任务验收奖金分开计奖。

## 配置与使用

1. 应用提交奖励迁移 `0016_github_contributions.sql`、`0018_contribution_events.sql`、仓库申请迁移 `0020_repository_requests.sql` 及历史补算迁移 `0022_contribution_history.sql`。初始三类奖励金额均为 0，不自动发行积分。
2. 在 GitHub App 中启用 **Contents: read**、**Issues: read**、**Metadata: read** 和 **Pull requests: read**。更新已有安装的授权。订阅 **Push、Pull request、Issues、Repository** Webhook 事件，沿用现有签名核验与投递地址。允许其他用户接入时，将 App 设为公开。
3. 在「运营管理 → 发行管理」按现有月度发行预算向平台奖励池注入积分；在「GitHub 奖励」分别设置 commit、PR、Issue 的每项积分。金额为非负整数，0 表示该类暂未开启。
4. 用户打开「GitHub 贡献」，选择自己名下的活跃 Agent 作为自动收款钱包。可以在仓库接入后再设置，待处理的历史贡献会自动重试；关闭自动收款不影响手动领取。
5. 仓库批准准入后，后台自动扫描历史 commit、PR 和 Issue，并核验作者身份、发放奖励。后续 push、新建 PR 和新建 Issue 继续通过 GitHub 通知自动处理。遗漏贡献仍可粘贴完整 GitHub 链接，选择所属 Agent 后领取；commit 链接需包含完整的 40 位 SHA。

## 用户提交仓库

用户在「GitHub 贡献 → 接入自己的仓库」中，先通过安装入口为个人或组织仓库安装 GitHub App，再提交完整仓库链接和申请理由。申请进入待审核状态，提交申请本身不发奖，也不自动准入仓库。用户可查看自己的申请状态与审核意见；同一用户对同一仓库只能保留一条待审核申请。

管理员在「运营管理 → 仓库准入」核验安装，并从仓库申请列表批准或拒绝。批准时服务端再次向 GitHub 验证该安装可访问仓库且仓库公开，随后原子完成仓库准入和申请审核。拒绝需说明理由。App 公开或安装成功均不等于仓库已经准入。

## 历史贡献自动补算

申请获批或管理员直接批准仓库准入后，系统自动安排一次历史扫描。应用 `0022_contribution_history.sql` 时，已有的获准仓库也会安排扫描。仅安装 GitHub App、尚未批准准入的仓库不会开始扫描。

扫描覆盖仓库现存各分支可访问的 commit 历史，以及所有状态的 PR 和 Issue，包括已关闭的条目。每个分支固定起始提交，分页保存进度；网络失败或服务重启后继续处理。分支间相同 commit、实时通知和链接补领共用去重记录，同一仓库中的同一贡献只奖励一次。扫描结束后，新贡献仍由 Webhook 处理。

奖励归 GitHub 返回的实际作者，进入作者在平台设置的自动收款 Agent，不会将其他作者的贡献转给仓库申请人。按实际发奖时的奖励配置从平台奖池支付。未设置自动收款、对应奖励暂未开启或奖池不足时，历史贡献保留待处理并稍后自动重试；用户无需逐条提交历史链接。无法关联 GitHub 作者的贡献无法自动发奖，链接补领入口仍保留。

## 发放规则

- 仅奖励已接入且准入的公开仓库；奖励发放时用户、收款 Agent、仓库与安装必须有效。
- commit 使用 GitHub 返回的 `author.id`，PR、Issue 使用创建者的 GitHub ID，与平台登录账号匹配。不以提交邮件、committer 或 Webhook 发送者代替作者。
- 同一仓库中的同一类型与对象只发一次。PR 与 Issue 不可用不同链接重复领取；commit、PR 和 Issue 是分别计奖的对象。修改标题、追加 PR 提交、重新打开 Issue 不再发该 PR/Issue 的创建奖励。
- 历史补算、实时通知与补领使用同一事务结算和去重记录。更换收款 Agent、重试请求、重复投递或再次推送同一 commit 都不会重复发放。
- 资金来自现有平台奖励池，发放不会新增积分。奖励池不足时整笔回滚，自动任务稍后重试；用户也可以在补充奖池后重试补领。
- 领取记录保存实际金额及配置版本；后续调价不改写历史、不补发差额。提交奖励不占用任务的 PR 结算记录，任务仍按原合同验收、分账。
- 删除收款 Agent 会关闭其自动收款设置；已有奖励流水保留。

## 自动事件与补领

已验签 Webhook 先写入原投递表，再将 push 中的 commit、新建 PR 和新建 Issue 放入持久队列。后台在数据库事务外读取 GitHub，在短事务内再次核验仓库和收款设置、结算并标记处理完成。网络或余额问题会重试，进程重启后继续处理。

实时通知中未关联 GitHub 作者、用户未准入、未设置收款 Agent、该类奖励关闭或仓库不可用的事件会跳过自动发放；符合条件后可用链接补领。历史扫描发现的贡献按上述历史补算规则处理。接入后的实时收集依赖 GitHub 实际投递的事件及 push 的 commit 列表，未投递或列表未包含的提交可通过补领入口处理。

## 接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/v1/contributions` | 当前奖励规则、自动收款设置、本人领取记录和分页游标 |
| `PUT /api/v1/contributions/preference` | 设置所属 Agent 或设为 null 关闭自动收款，携带设置版本 |
| `POST /api/v1/contributions/claim` | 以 GitHub 链接领取，携带收款 Agent 和奖励配置版本 |
| `GET /api/v1/admin/contribution-rewards` | 管理员读取三类奖励金额 |
| `PUT /api/v1/admin/contribution-rewards` | 管理员更新三类金额，携带版本与调整理由 |
| `GET /api/v1/repository-requests` | 用户自己的仓库申请与分页游标 |
| `POST /api/v1/repository-requests` | 提交仓库链接及申请理由 |
| `GET /api/v1/admin/repository-requests` | 管理员按状态查看申请 |
| `POST /api/v1/admin/repository-requests/:id/review` | 携带版本、理由及审核决定；批准还需有效安装 ID |

所有写接口沿用现有 CSRF、身份、幂等请求键及操作回执机制。自动队列的错误和重试状态保存在 `contribution_events`，领取记录在 `contribution_rewards`，账本与审计仍通过原运营入口核对。

## 历史补算上线记录

2026-11-08 已部署至 `https://118.190.147.128:8443`，活动发布目录为 `/opt/agentzero/releases/contribution-history-20261108`。上线前核对了原有 21 个迁移的校验值，本次仅应用 `0022_contribution_history.sql`，随后重启 API。

发布前数据库备份 `/opt/agentzero/backups/pre-contribution-history-20261108.dump` 已通过 `pg_restore --list` 可读性检查，权限为 `0600`；原发布目录和 `before-contribution-history-20261108` 镜像标签保留。已发奖励不随代码回滚撤销；旧版本也会消费已入队的历史事件，故回滚应用不能视为暂停历史补算。

上线检查确认可信 HTTPS、首页、3 个前端资源及 8 个模型目录资源与本机构建一致，受保护接口返回 401，NEXUS 服务正常。`jxt159753/nexus` 已自动开始扫描 4 个分支；首批检查发现 50 个历史 Commit，其中 5 个已处理，奖励记录由 3 笔增至 8 笔，奖池由 991 减至 986 积分，其余继续在后台处理。账户余额、冻结、借贷平衡和积分总量核对均通过。该进度为发布核验时快照，不表示历史扫描已经完成；记录见 `.local/contribution-history-public-check.json` 和 `.local/contribution-history-deployment.json`。
