# 星光老虎机

自包含三轴网页小游戏。正式对局由 AgentZero 宿主开局，配置 `settlement_rule=starlight_slots_v1` 后由服务端独立计算、自动结算和派奖；游戏包不持有任何凭证，不直接访问平台 API。结算后使用宿主窗口下方“再来一局”，无需退出游戏或全屏。

## 发布文件

只发布 `index.html`、`style.css`、`main.js`、`rules.js` 四个运行文件，入口为 `index.html`。不要将验证脚本、说明或截图一起上传。

`node examples/starlight-slots/bundle.mjs` 会向标准输出生成平台需要的 `source` JSON（包含四个文件的 Base64 内容）。此脚本不会创建游戏、调用网络或交易积分。

自动规则配置：每局 1 积分，最高奖励 3 积分，最低奖池至少 3 积分。具体积分配置以发布时的用户授权为准。平台负责低奖池停止接待，游戏包不控制奖池余额。

## 固定规则 v1

输入是服务端生成的 `session_id`，区分大小写，不删除空格、不转换大小写。对 UTF-8 字节串 `agentzero-starlight-slots-v1:` 加原始对局编号计算 SHA-256；取摘要第 0、1、2 个字节各自 `% 3`。

| 值 | 符号 |
|---|---|
| 0 | 星光 ✦ |
| 1 | 月亮 ☾ |
| 2 | 宝石 ◆ |

| 组合 | 分数 | 申请奖励 |
|---|---:|---:|
| 三枚相同 | 100 | 3 |
| 恰好两枚相同 | 20 | 1 |
| 三枚各异 | 0 | 0 |

取模规则是公开固定算法，存在 256 不能被 3 整除造成的微小分布差异；本版本不宣称符号严格等概率。结果在对局编号生成后就已确定，转动动画不改变结果，也不构成保密随机源。

作者独立核验：

```powershell
node examples/starlight-slots/verify.mjs <服务端对局编号>
```

核验脚本输出摘要、符号、分数和申请奖励。自动规则由服务端使用同一算法计算，以真实对局编号决定分数和实际奖励，不信任网页自报金额。成绩提交与费用支付、奖池派奖在同一事务中完成，重试不会重复支付。自动规则对局超时也按固定结果结算，不能通过关闭页面取得未中奖局退款。尚未启用自动规则的 `manual` 对局仍由作者核验结算，既有对局使用开局时保存的规则。

## 宿主协议

协议为 `agentzero.game.v1`。页面启动发送 `ready`。只接受 `event.source === window.parent` 的初始化和结果消息，并绑定首次宿主消息的 origin。宿主 `init` 包含 `mode`、`session_id`、`entry_fee`、`max_reward`、`settlement_rule`，缺省规则按 `manual` 显示。

- `preview` 可以无限试玩，每次使用 `crypto.randomUUID()` 作为演示种子，绝不发送 `submit`。
- `play` 对当前服务端对局只转动一次，自动提交字符串 `score` 与 `reward_requested`。
- 同一对局所有重试固定使用 `request_id = "starlight:" + session_id` 和相同结果；重复初始化不会重开转动或清除提交状态。
- 只在宿主回执的对局编号和已提交结果一致时确认成功；提交成功显示“等待作者核验”，不会显示已经到账。
- 刷新后可按相同编号恢复同一结果。平台仍负责幂等提交、状态校验和最终结算。
- 若平台在网络错误后保留待确认请求，游戏内重试可能被宿主合并；用户可以使用外层平台的“重试本局分数提交”。

沙箱无需 `allow-same-origin`，不使用 Cookie、Storage、外部字体、CDN 或第三方资源。

## 本地验证

```powershell
node --test examples/starlight-slots/rules.test.mjs
node examples/starlight-slots/validate-ui.mjs
```

浏览器验证使用临时本机端口和项目已有的 Playwright Chromium，检查真实沙箱内的预览、正式结果、重复初始化、失败重试、错误窗口消息和屏幕适配，最终截图在 `.validation/`。所有宿主消息和对局都是本地夹具，不代表生产资金操作。
