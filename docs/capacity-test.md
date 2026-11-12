# 小镇容量测量

`scripts/capacity-test.ts` 提供真实广播序列化测量，以及独立本地 API / PostgreSQL / WebSocket 测量。不访问线上服务，不执行经济交易，不创建钱包或赠币。

## 无数据库测量

```powershell
node --import tsx scripts/capacity-test.ts --synthetic
```

默认测试 20、50、100 个访客，209 块土地，25% 和 100% 访客移动。调用现有 `WorldStream.publish`，模拟 socket 统计实际 JSON 字节；20 次预热后记录 100 次发布。输出 `.local/public-capacity-synthetic.json`，`--clients 20,30,50,100,200` 可改变规模。脚本访问该类内部成员仅用于测量，若重构广播实现，应同步更新脚本。

下行估算按每秒两次广播，不含 ACK、TLS、静态资源、其他 API，也不含大量离线 Agent。CPU 时间是执行脚本机器的结果，不能直接作为云服务器容量。

## 真实隔离测量

先在本机 PostgreSQL 18 创建 **独立** `agentzero_capacity_test` 数据库，所有者为已有 `agentzero_migrator`。用项目 `packages/database/src/migrate.ts` 应用全部迁移；不要把现有开发库或通用测试库改名当作容量库。

仅在进程环境中设置：

- `CAPACITY_DATABASE_URL`：`agentzero_app` 角色连接独立容量库。
- `CAPACITY_MIGRATION_DATABASE_URL`：`agentzero_migrator` 角色连接同一库。

两个连接必须使用 `127.0.0.1`、`localhost` 或 `::1`，数据库名包含 `capacity_test`，且不能带 URL 查询参数。脚本再核对实际数据库名和数据库服务地址；不会使用 `DATABASE_URL` / `TEST_DATABASE_URL`，也不接受外部 API 地址。

```powershell
node --import tsx scripts/capacity-test.ts --clients 20,50,100 --seconds 60
node --import tsx scripts/capacity-test.ts --clients 50 --seconds 300 --moving-fraction 0.25 --output .local/public-capacity-soak.json
node --import tsx scripts/capacity-test.ts --clients 50 --seconds 60 --stop-start --output .local/public-capacity-stop-start.json
```

脚本启动自己的随机本地端口 API，为每个访客创建不同的用户/session。每 500 ms 发移动、每 20 s 发心跳；`--stop-start` 交替走停，覆盖更频繁的位置落盘。`--moving-fraction 0` 测静止连接。首次运行会由正常 API 初始化 209 块默认土地。

每档输出首帧、移动 ACK、到观察者的同步延迟，接收字节、进程 CPU/RSS、事件循环延迟、连接池最大等待数与断线/错误数。发移动结束后保留 1 秒采集窗口，收齐最后的广播；`active_seconds` 是发移动时长，`seconds` 是含收尾的采集时长。测试 API 的连接上限设为最大测试档，不改变生产设置。测量结束后关闭 API，仅删除本次 UUID 标识的用户/session/位置，不清空整库；异常退出仍可能留下该独立库中的夹具。

真实模式默认结果为 `.local/public-capacity-local.json`。API 与负载发生器共用 Node 进程，CPU/RSS 含二者；PostgreSQL 资源应另外观察。本机回环结果不代表公网表现，后台作业、TLS、真实 GitHub、手机渲染和静态冷启动均未覆盖。

## 同机 Linux 隔离方法与上线判断

如需在服务器测量，先安排低流量窗口。创建单独的临时 PostgreSQL 容器/卷，在宿主 `127.0.0.1` 的独立端口监听，以项目 `deploy/init-db.sh` 相同方式创建角色，在独立 `capacity_test` 库迁移。运行独立 Node 24 容器，使用 `--network host` 连接该回环数据库；挂载的源码与依赖不含生产 `.env`、私钥或数据库卷。只传上述两个容量环境变量，不把生产 DB 容器改成测试对象。结束后保留报告，再按明确容器/卷名移除测试资源。当前小内存机器若无法保留至少约 250 MiB 可用内存，应在同规格临时机器执行。

先跑 20、50、100 人阶梯，候选档持续 5 分钟，并补频繁走停。参考通过条件：同步 p95 ≤ 1.5 秒、非主动断线 < 1%、无持续数据库等待、无内存上升趋势、CPU/内存/出口留至少约 30% 余量；首批硬上限建议 50，最终须按测量下调。峰值 200 Mbps 不等于持续保障带宽，静态冷启动和集中进入时也要留出口余量。

累计 Agent 数也是容量维度：当前世界聚合含所有未删除 Agent，同房间客户端会创建其模型/标签。只有少量 Agent 的访客测试，不能证明几千个离线 Agent 的表现。此脚本给出复现基础，不宣称单机人数上限已被证明。

## 2026-11-10 本地结果

Windows / Node 24.14.0 / Core Ultra 9 275HX / 32 GiB，本地 PostgreSQL 18 独立库应用 31 个迁移。每档全员连续移动 60 秒；全部访客成功连接，全部移动收到 ACK 和观察者更新，未出现异常断线。

| 访客数 | ACK p95 | 同步 p95 | 接收总流量 |
| ---: | ---: | ---: | ---: |
| 20 | 2.001 ms | 293.689 ms | 1.253 Mbps |
| 50 | 3.870 ms | 472.544 ms | 7.464 Mbps |
| 100 | 5.768 ms | 402.712 ms | 29.387 Mbps |

50 人频繁走停补测 60 秒（另 1 秒收尾）同样零断线，5950 次移动全部收到 ACK 与观察者更新，ACK p95 4.213 ms、同步 p95 475.993 ms；见 `.local/public-capacity-stop-start.json`。测试结束核对容量库有 0 用户、0 session、0 世界位置、0 账本交易，保留 209 块默认土地；隔离清理记录为 `.local/public-capacity-isolation.json`。

证据为 `.local/public-capacity-local.json`；无数据库合成对照为 `.local/public-capacity-synthetic.json`。50/100 人档连接池采样曾有 17/30 个等待请求，但同步未超阈值；同步延迟取决于 500 ms 广播时钟相位，100 人数值较低不能解释为性能更好。此结果验证实现及脚本在本机运行，**没有验证 2 核、系统总内存约 1.6 GiB 的生产服务器人数上限**。首批 50 人硬上限仍应以实际服务器资源观察逐步调整。

## 服务器广播测量

2026-11-10 已在实际青岛主机的候选镜像内测量序列化，容器限制1核、384 MiB、禁用网络，不连接数据库。50人全员移动时发布 p95 5.366 ms、JSON载荷6.101 Mbps；100人17.464 ms / 23.993 Mbps；200人69.230 ms / 95.824 Mbps。报告为 `.local/public-capacity-server.json`。这是实际硬件的广播计算测试，仍不包含数据库事务、公网、TLS和客户端渲染，不能作为相同人数完整上线验收。
