# AI 钱包跟单工具(BSC · 路由镜像版)

按目标地址的链上交易**镜像路由**跟单的精简工具。不按平台写死解码器:目标用哪个合约、哪条路由买卖,就把那笔交易的 calldata 换成**你的地址、你的金额、刷新后的 deadline**,原样跟。下单全部通过币安 Agentic Wallet CLI(`baw`)完成,脚本不接触私钥。

## 它做什么

- **跟买**:目标花 BNB / WBNB / 稳定币买了代币 X,你按 `sizeRatio` 比例买同一个 X。优先镜像目标那笔交易的路由;镜像不了(自定义路由、签名单等)且该币有公开流动性时,改走币安聚合器(带 MEV 保护)。
- **跟卖**:目标卖出它持仓的 X%,你也卖出你持仓的 X%。路径同样优先镜像,失败再走聚合器。
- **防夹**:`minOut` 不再写 0。用 `eth_simulateV1` 模拟改写后的交易,拿到预估产出,再按滑点(默认 15%)回填到路由里可识别的 minOut 字段。
- **信号源**:WSS `newHeads` 订阅实时拿新块,断线自动重连,并用 HTTP 轮询兜底;拿到块后一次 `eth_getBlockReceipts` 取整块回执识别目标交易。
- **Telegram**:成交/失败通知,`/status`、`/buy`、`/sell` 命令。

> 不做池子深度检测、不接 GoPlus、不做貔貅拦截。`minOut` 是唯一的被夹止损;能走聚合器的买卖都带 MEV 保护,镜像路由的 `contract-call` 没有 MEV 保护,只靠紧 minOut 封顶损失。

## 前置条件

1. **Node.js 22+**(用到内置 `WebSocket` 和 `eth_simulateV1`)。
2. **币安 Agentic Wallet CLI**:
   ```bash
   npm i -g @binance/agentic-wallet
   baw auth signin          # 登录,钱包要和 config.wallet 一致
   baw wallet status        # 返回 CONNECTED
   baw wallet settings      # devMode.enabled 必须为 true,contract-call 才可用
   ```
3. **本地代理**(部分网络直连 binance.com / BSC RPC 不通):`run.sh` / `run.cmd` 已设 `NODE_USE_ENV_PROXY=1` 和 `HTTPS_PROXY` / `HTTP_PROXY`,按自己的端口改。

## 快速开始

```bash
cp config.example.json config.json
# 编辑 config.json:填 wallet、targets、(可选)telegram
node copytrader.mjs doctor      # 自检:Node / baw / RPC / WSS / 钱包
./run.sh                        # 启动(默认 dry-run,不下单)
```

确认 dry-run 日志里识别、改写、minOut 都正常后,把 `config.json` 的 `copy.autoExecute` 改成 `true` 再启动,才会真实下单。

## 命令

```bash
node copytrader.mjs                 # 跟单(dry-run,除非 copy.autoExecute=true)
node copytrader.mjs --dry-run       # 强制 dry-run
node copytrader.mjs replay <txHash> # 用历史交易回放决策逻辑,只 preview 不下单
node copytrader.mjs doctor          # 环境自检
```

`replay` 是上线前验证的主要手段:拿目标地址的真实历史 txHash 跑一遍,看能否识别动作、改写 calldata、模拟并 preview 成功、以及每步耗时。它只读、绝不下单,也不写 `routes.json`。

## 配置项(config.json)

| 键 | 说明 |
|---|---|
| `wallet` | 你的 AI 钱包 BSC 地址,必须和 `baw` 登录的一致 |
| `targets[]` | 跟单目标:`address`、`label`、可选 `sizeRatio`(覆盖全局) |
| `sizeRatio` | 全局跟单比例。目标花 1 BNB、比例 0.2,你花 0.2 BNB |
| `slippagePct` | 镜像路由的滑点,minOut = 模拟预估 ×(1 − 该值%),默认 15 |
| `copy.autoExecute` | `false`=dry-run;`true`=实盘下单 |
| `copy.buys` / `copy.sells` | 是否跟买 / 跟卖 |
| `copy.minBuyBnb` / `maxBuyBnb` | 单笔跟买下限 / 上限(BNB) |
| `copy.skipIfNoMinOut` | 路由找不到 minOut 字段时:`false`=照样下单(minOut 为 0);`true`=跳过 |
| `copy.sellMinRatioBps` / `sellFullExitBps` | 卖出比例下限(1%)/ 清仓阈值(99%) |
| `copy.buyMarketFallback` / `sellMarketFallback` | 路由镜像失败时是否改走聚合器 |
| `market.*` | 走聚合器时的滑点 / MEV / gas 档位 |
| `rpc.http` / `rpc.wss` | RPC 端点(多个,自动故障切换);WSS 用于实时取块 |
| `telegram` | `enabled` / `token` / `chatId` |
| `bawPath` | 可选,`baw` 的 `dist/index.js` 路径,找不到 CLI 时手动指定 |

## 工作原理

```
目标 tx 上链(WSS newHeads)
  └─ eth_getBlockReceipts 取整块回执
      └─ 按资金净流向识别:付计价币收代币=买,付代币收计价币=卖(不看平台)
          └─ 用目标那笔 calldata 生成多个候选:地址换成你的、金额按比例、
             deadline 刷新(含非对齐的 packed deadline)、minOut 先置 0
              └─ eth_simulateV1 批量模拟,选真正买到/卖出且花费不超的候选
                  └─ 二分法确认哪个字段是 minOut,回填 预估×(1−滑点)
                      └─ baw contract-call preview → execute
                          └─ 失败且有公开流动性 → baw market-order(MEV 保护)
```

验证过的路由按币缓存在 `routes.json`(`fastRoutes` 已成交 / `learnedBuys` 已学习 / `sellRoutes` 卖出),下次同币直接复用。

## 运行产物

| 文件 | 说明 |
|---|---|
| `copytrader.log` | JSON 行日志(Telegram token 已脱敏) |
| `state.json` | 已处理区块 / 交易、待 App 确认订单 |
| `routes.json` | 学习到的路由缓存 |
| `copytrader.lock` | 单实例锁 |

## 已知限制

- 镜像路由的 `contract-call` 没有 MEV 保护,最大被夹损失只靠紧 minOut 封顶;能走聚合器的都带 `--mev`。
- 跟单最快也落在目标之后 1~3 个块;刚开盘猛拉的币多半会因花费超限或模拟失败被挡下。
- 部分自定义路由(签名单、per-hop 一致性校验)无法改写,会直接走聚合器;聚合器没流动性就放弃并通知。
- `PENDING_CONFIRMATION`(需在 App 里确认)的订单会后台轮询 `baw` 历史跟踪成交结果。

## 安全

- `config.json` 含 Telegram token,不要提交或外发。
- 脚本不含私钥,所有签名由 `baw` 完成。
- 首次务必先 dry-run 观察决策日志。
