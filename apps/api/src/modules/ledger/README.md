# 账本内部接口

这些函数只供同进程业务服务调用，不是 HTTP 自由转账接口。金额参数及返回值均为十进制字符串，运算使用 `bigint`。全部函数使用调用者传入的 PostgreSQL `Tx`，不自行提交。

## 调用顺序

1. 通过 `runCommand` 开启事务，锁当前 user、Agent、Session/key 并重新检查身份，再取得请求幂等键。系统履约只接受服务端构造的 `{ type: 'system' }`。
2. 业务模块验证合同参与者、状态与分账方案。业务键来自已保存的领域 ID，不使用可随意更换的请求键代替合同标识。
3. 调用本模块。函数先锁付款 Agent 策略（发行锁月预算），再锁 hold，最后由 `ledger.post_journal` 按账户 ID 顺序锁账户。
4. 在同一个事务更新合同及不含秘密的回执。任何后续异常都回滚账本、冻结、预算和审计。

一个调用者若要锁多个 Agent 的策略或多个合同，应预先按统一 ID 顺序获取所有必要锁；不能在已经记账后再取另一业务的策略锁。

## 命令

| 方法 | 用途 |
| --- | --- |
| `setIssuanceLimit(tx, ctx, {month, limitPoints, reason})` | 管理员配置 `YYYY-MM` 月预算；不能降至已发行量以下 |
| `issue(tx, ctx, {businessKey, amount, reason, month?})` | 当月发行到平台奖励池；业务重放先于当前预算检查 |
| `recycle(tx, ctx, {businessKey, amount, reason})` | 管理员将回收款转回奖励池；保留未完成兑换退款准备金，不新增发行 |
| `adminAdjustWallet(tx, ctx, {businessKey, wallet, ownerUserId, direction, amount, reason})` | 管理员从奖励池给个人/Agent可用钱包加分，或将可用积分扣至回收账户；不触碰冻结、不新增发行 |
| `reserve(tx, ctx, {businessRef, payerAgentId, amount, permission, reason})` | 创建唯一冻结；`payerAgentId: null` 表示平台奖励池 |
| `adjustHold(tx, ctx, {holdId, amount, revision, permission, reason})` | 将剩余冻结调整为 `amount`；增加按当前总承诺校验，而非仅校验增量 |
| `finalizeHold(tx, ctx, {holdId, payments, refund, reason})` | 一次完成全部分账及退款，二者总和必须等于剩余冻结 |
| `pay(tx, ctx, {businessKey, payerAgentId, amount, permission, reason})` | 领域即时消费，付款到系统回收账户 |
| `refund(tx, ctx, {businessKey, originalTransactionId, amount, reason})` | 系统或管理员依原 `PAY` 记录退款；累计不能超原支付，不恢复当日已消费额度 |
| `transfer(tx, ctx, {businessKey, from, to, amount, reason})` | 用户本人从自己的用户/Agent 可用钱包转到任一可用用户/Agent 钱包，原子记两笔分录 |

转账入口先解析收款方 owner，将双方用户 ID 交给 `command` 按统一顺序锁定，然后锁 Agent、付款 Agent 策略与账户，避免双向转账死锁。只有用户 Session 可发起，源钱包必须属于本人；人工转账不检验 Agent 的自动权限与限额，但 Agent 转出仍记当日支出。请求键和用户范围内的 `transfer_id` 共同防止重试重复扣款。

管理员积分调整也先将管理员与目标owner按用户ID排序加锁，随后复核目标Agent归属。使用独立 `ADMIN_ADJUST` 分录，数据库只接受奖励池到可用账户、可用账户到回收账户两种组合。处理理由记录到用户可见流水；操作不能用于修改历史分录或解除账本隔离。

`ledger.open_user_account(user_id)` 在同事务幂等建立零余额的个人可用与冻结账户。0031 起注册不发放积分；既有余额和历史 `INITIAL_GRANT` 流水保留，账本拒绝新增该类发行。对账发行总量仍为月度发行累计加历史初始金累计。

运营管理的“发行管理”页显示用户与 Agent 可用余额、冻结余额、回收款、奖励池和退款准备金，并提供“回流到平台奖励池”入口。回流沿用账本幂等和审计，只能使用扣除 `pending` / `processing` 兑换金额后的回收款；资金再通过任务或有效贡献发放。回流不会消耗或增加发行预算。月度人工发行仍受显式预算限制，未经配置的月份预算为零。

`adjustHold.amount` 必须为正；释放全部冻结使用 `finalizeHold`，以便支付与取消共用唯一最终业务键。结算不再检验新消费开关或新限额，合法系统履约不依赖旧 key 仍有效。调用者必须在领域模块判断合同是否允许调整或结算。

事务结果包含 `transactionId`、`businessKey`、`created`；新业务 `created=true`，相同业务回放 `created=false`。回放通过不可变审计保存的命令摘要和原业务结果核对；同键不同命令报冲突。请求层的相同幂等键直接返回原完整回执。最终支付与取消共享 `hold:<id>:finalize`，不能用不同请求键再次结算。

## 查询与对账

`getWallet(tx, agentId)` 用一个 SQL 快照返回可用、冻结、今日支出和全部未结清冻结；调用者先验证 owner/绑定 Agent 授权。

`reconcile(tx, ctx?)` 在一个 SQL 快照检查账户缓存与分录、冻结余额与 hold、发行累计及积分守恒。发现差异时返回明细并追加 `ledger.quarantined` 审计，后续涉及该账户的记账被拒绝；全局守恒异常暂停全部记账。调用者应提交这个报告事务，不能因 `ok=false` 抛错回滚隔离记录。

对账不会改余额或历史流水，也不会自动解除隔离。纠正和解除隔离需要后续有明确依据的运营处理；首版不提供任意余额修复接口。
