# dsh-meter v0.3 迭代 PRD：逐轮消耗与上下文占用

> 状态：**已评审修订（开发基线）** · 评审角色：产品 + 架构 + 全栈 · 最近更新：见文末
> 本 PRD 规划 v0.3 迭代能力，§0 评审结论与 §5 决策表为最终方案，可直接据 §9 开发方案动代码。既有能力与历史见 [PRD.md](PRD.md)。代码与文档均已按最终方案落地（见交接状态）。**v0.3.4 起，GUI 实测反馈修订了图表方向与表头（见文末迭代记录）：详情图表横轴轮次从左到右递增，明细表头去括号，请求序号始终带 step；「按请求」视图的图表仍按轮次聚合。**

---

## ⚠️ 交接状态（新会话必读）

> 由上一开发会话在 2026-08-17 中断后整理。**代码已按 §0 评审后的最终方案实现，源码级 typecheck 与纯逻辑测试全绿，完整构建已通过；后续会话已完成文档同步（§8 Step 7）与客户端 bundle 热更新验证（GUI 已服务最新 client.js），host 侧待重启后冒烟，尚未 commit。**

### 已完成（源码层面）

- **数据模型**（`src/shared.ts`）：新增 `TurnCost`（含 `priced` 字段）、`ModelCapability`；`SessionBillingStats` 新增 `turns`（有界）、`lastRequestInputTokens`、`contextWindow`、`maxOutputTokens`；新增常量 `RECENT_TURNS_CAP=50`、`CONTEXT_WARN_THRESHOLD=0.85`、`SINGLE_TURN_WARN_RATIO=0.3`；`EMPTY_STATS` 同步（`turns: []` 冻结）。
- **折叠**（`src/host/session-stats.ts`）：`request/context` last-wins 设置/清除 `contextWindow`；`request/header` 设置/清除 `maxOutputTokens` 且 **no-op 快路径已纳入 `config.maxTokens` 比较**；`assistant/message` 逐条追加 `TurnCost`（未登记 `priced:false`、`cost:0`）、记 `lastRequestInputTokens`；新增 `foldBillingBounded`（截断到 50）。原始折叠保留全量（供 turns 路由）。
- **host 路由与 schema**（`src/host/index.ts`）：投影 zod schema 新增四字段；`stateVersion` 5 → 6；投影 apply 内截断 `turns` 到 50；新增 `turns` 路由（全量，复用 `refresh` 的 sessionId 校验）；`catalog` 扩展 `capability`（对每个模型 `resolveModelInfo`，单模型失败降级缺省）；**已删除独立的 `capability` 路由**（按评审 R-2 并入 catalog）。
- **client 数据层**（`src/client/billing-api.ts`）：新增 `getTurns(sessionId)`；`ProviderCatalogRow.models[]` 加 `capability?`；删除 `getModelCapability`。
- **卡片**（`src/client/BillingAction.tsx` + module.css）：上下文占用进度条（`lastRequestInputTokens / contextWindow`，≥85% 预警、≥30% 单轮提示、`maxOutputTokens` 展示）；「最近消耗」迷你图（最近 10 条、费用横条、peak 着色、`title` hover）；卡片头部新增「查看详情」按钮。
- **详情面板**（新文件 `src/client/BillingTurnsPanel.tsx` + module.css）：portal + fixed 定位（560px / 70vh / 窄屏 `calc(100vw-16px)`）；打开即以 `stats.turns` 渲染并 `getTurns` 拉全量替换；单图 + 费用/token 维度切换；费用柱按 period 着色、未登记斜纹；token 四段堆叠；>40 条横向滚动；明细表含**时间列（HH:MM:SS）**、`priced:false` 显示「未登记」；右上刷新按钮；Esc/外点关闭。
- **设置页**（`src/client/BillingSettings.tsx`）：模型行标题区显示能力小字（`上下文 200K · 输出上限 8K（配置）`，缺省字段不显示）。
- **文案**（`src/client/locales.ts`）：新增 `card.*` / `turn.*` / `capability.*`（zh/en 同步）。
- **测试**（`tests/pure-check.ts`）：逐轮折叠、priced、lastRequestInputTokens、request/context 设置/清除、request/header maxTokens + no-op 含 maxTokens、50 截断方向、空日志等断言，全绿。
- **文档**（§8 Step 7）：`README.md` 功能特性/数据模型速览/联动点清单/已知限制已同步最终方案；主 `docs/prd/PRD.md` v0.3 迭代记录已改写为评审后方案（删除 capability 路由与累计输入口径）。

### 已验证

```sh
# 源码 + 测试 typecheck
node_modules/typescript/bin/tsc --noEmit        # OK
node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json  # OK
node tests/pure-check.ts                        # ALL PURE CHECKS PASSED 等全绿

# 完整构建（注意：必须 rm -rf lib 后 tsc + tsdown，见下）
node_modules/typescript/bin/tsc -p tsconfig.build.json
node node_modules/.pnpm/tsdown@0.22.14_typescript@5.9.3/node_modules/tsdown/dist/run.mjs
# lib/index.js 28.87kB / lib/client.js 119.04kB，均含 v0.3 新特性
```

### 遗留 / 未做

1. **未 commit**：当前 git 工作区含 v0.3 全部改动（含 PRD/review 迁移 + 本 PRD），尚未提交。可用 `git status scratch-billing/` 查看。用户确认验证后再提交。
2. **host 重启后冒烟待做**：host 进程（PID 35287）仍运行 v0.3 之前的 bundle——`/billing/api/turns` 返回 unknown method、`catalog` 无 `capability`。需重启 `dsh web`（`npx @deepseek-ai/dsh web`）后验证：卡片占用条/迷你图/详情面板拉全量、设置页能力行、`turns` 路由全量明细、`catalog` 带 `capability`。客户端 bundle 已确认上线（GUI 服务的 `client.js` 与最新构建 md5 一致）。
3. **`lib/` 需用完整 build 重建**：上一会话只跑了 tsdown（基于旧 `lib/types`），host 产物一度是旧代码；**已用 `tsc -p tsconfig.build.json && tsdown` 重建为正确产物**，但新会话如需改动请走 `pnpm build`（= `rm -rf lib && tsc -p tsconfig.build.json && tsdown`）。
4. **潜在待复核点**：详情面板打开时若 `getTurns` 失败仅保留卡片已有 50 条（按评审 S/R 设计的降级）；`maxTokens` 只有显式配置才进 `defaultMaxTokens`（设置页标注「（配置）」）；占用口径 = 最近一次请求输入（评审 R-1，非累计）。

### 建议新会话第一步

```sh
cd scratch-billing && pnpm build && node tests/pure-check.ts
# 再跑 GUI 冒烟（README 开发节）：host 改动需重启 dsh web，client 用 dev:watch
```

---

## 0. 评审结论（必读）

**结论：方案总体可行，数据基础全部成立，但原稿有三处必须修正、两处可以简化。** 以下每条都已对照主仓库源码核实。

### 0.1 必须修正

| # | 问题 | 核实依据 | 修正 |
|---|---|---|---|
| R-1 | **FR-8 的占用分子语义错误**：「累计输入 / contextWindow」在长会话里会单调上涨并很快超过 100%——缓存命中每轮重复计数同一批 token，累计输入是**计费口径**而非**上下文口径**，算不出「还能聊多久」 | 主仓库 `token-meter` 的 `contextPressure` 投影即用「最近一次 provider 上报的提示词规模」（pressureTokens = 未命中 + 命中 + 写入） | 分子改为**最近一次请求的总输入**（`lastRequestInputTokens`），与 token-meter 的 pressureTokens 语义对齐（见 FR-8） |
| R-2 | **FR-8/D-2/D-3 过度设计**：上下文窗口和输出上限**已经在持久化日志里**，不需要异步 capability 路由 + host 缓存 + 客户端拉取 | agent-loop 每次请求在路由或容量变化时追加 `request/context` 事件（`packages/core/agent-loop/src/agent.ts`，载荷 `{ provider, model, contextWindow? }`）；`request/header` 的 `config.maxTokens` 持有**实际生效**的输出上限（`resolveCallConfig` 在请求缺省时填入 adapter 默认值） | 卡片的占用条与输出上限全部由**纯折叠**从日志产出（FR-8 改写）。异步 `resolveModelInfo` 只留给设置页（FR-9），并入现有 `catalog` 路由，**不新建路由、不做 host 缓存** |
| R-3 | **风险 2（投影帧体积）必须落实为设计，不能留作开放问题**：投影在每个状态变化事件后向客户端推送**完整 view**（`session-projection` 的 change feed），无界 `turns` 数组会让每帧 O(N) 增长、整场会话 O(N²) 推送量，并撑大投影持久化缓存 | `packages/session/session-projection/src/index.ts`：状态引用变化即 `schema.parse(view(state))` 推帧 | 投影帧只带**有界**的最近 N 条（`RECENT_TURNS_CAP = 50`）；全量明细走新的 `/billing/api/turns` 按需路由，打开详情面板时拉取（见 FR-6/FR-7） |

### 0.2 简化与明确

- **S-1 粒度定义**：一条明细 = 一次计费请求（一条带 `usage` 的 `assistant/message` 事件），用 `turn`+`step` 标识。一个用户轮次含工具调用时会产生多条记录。**v0.3.1 更新**：UI 默认**按轮次（turn）聚合**展示（`aggregateTurns` 纯函数，同轮 step 合并），「按请求」视图展开每条明细——原「按用户轮次聚合是后续可选增强，本轮不做」已随 GUI 实测反馈落地。
- **S-2 图表减负**：原 FR-7 的「逐轮费用柱状图 + 逐轮 token 堆叠图」两张图合并为**一张逐轮图 + 维度切换**（费用 / token 堆叠），加一张明细表。信息等价，实现与维护减半。
- **S-3 未登记价格的请求也记录**：token 是真实的，只是没价格。记录带 `priced: false`、`cost: 0`，明细表标「未登记」，避免显示误导性的 `¥0.00`。
- **S-4 `context` 可缺省**：`LlmResolvedModelInfo.context` 与 `request/context.contextWindow` 都是可选（未知容量 = 不公布）。UI 全程「无数据不显示」，不臆造。
- **S-5 迷你图多币种**：条长按**当前窗口内最大费用**归一（仅作趋势可视化），条按时段着色（高峰/空闲），hover 显示精确值；跨币种长度不可比，图例注明。

### 0.3 核实后确认成立的原始判断

- `assistant/message` 事件持久化携带 `turn` / `step` / `usage`（`usage.inputTokens` 为未命中输入，`cacheReadTokens` / `cacheWriteTokens` 可选）——逐轮明细**无需新数据源**，纯折叠可重放，D-1 成立。
- 折叠是同步纯函数、投影单元重注册即全量重放的架构，对有界数组追加 + 截断完全兼容。
- client bundle purity gate 允许纯 CSS/手写 div 图表；不引图表库的判断（D-4）成立。

---

## 1. 背景与动机

v0.2 已经能回答「这个会话花了多少钱、token 构成如何、高峰/空闲花了多少」。但用户仍有两个高频诉求答不上来：

1. **回顾性：钱 / token 花在了哪些请求？** 当前只有会话级总量，看不到「哪次请求最贵、哪次缓存没命中、上下文是在哪次请求涨起来的」。对长会话排查成本、定位缓存失效、理解上下文增长都缺抓手。
2. **预测性：这个会话还能聊多久？** 模型的真实上下文窗口（contextWindow）与实际生效的输出上限（maxTokens）已随每次请求写入持久化日志，但插件完全不展示。长会话用户无法预判「离上下文上限还有多远」，往往等到被截断/压缩才意识到。

**目标**：在既有「单会话纯折叠」架构上，新增两个能力——**逐请求消耗明细与图表**、**上下文窗口占用**，全部用真实数据（日志持久化字段或 adapter 目录，不估算）。

**非目标（本轮不做）**：
- 跨会话聚合报表 / 每日账单 / 预算告警（现有 PRD 已列为非目标，延续）
- 导出/复制（用户本轮明确不做）
- 真正的上下文截断/压缩控制（只做展示与预警，不改变会话行为）
- 按用户轮次（turn）聚合多个 step 的视图（明细以请求为粒度，见 S-1）
- 上下文占用的「投影式」预估（token-meter 的 `projectedTokens` 会把压缩/裁剪后的 surface 移动计入；本插件只做最近一次请求口径，见 §7 限制）

---

## 2. 用户故事

| ID | 故事 | 对应需求 |
|---|---|---|
| US-11 | 作为用户，我希望看到当前会话每次请求的消耗（token/费用/命中率），以便定位「哪次最贵、哪次缓存没生效」 | FR-6, FR-7 |
| US-12 | 作为用户，我希望用图表直观看到逐请求费用的起伏，而不是只看数字，以便快速扫视成本走势 | FR-7 |
| US-13 | 作为用户，我希望知道最近一次请求的上下文占用该模型窗口的比例，以便预判还能聊多久、何时该开新会话 | FR-8 |
| US-14 | 作为用户，我希望当上下文占用接近上限时得到提示，以便提前决策（开新会话/压缩）而不是被突然截断 | FR-8 |
| US-15 | 作为用户，我希望在设置页看到每个模型的上下文窗口与输出上限数据，以便了解模型真实能力边界 | FR-9 |

---

## 3. 功能需求

### FR-6 逐请求消耗明细（数据层）

- 折叠在统计会话级总量的同时，**逐条记录每次 `assistant/message`（带 `usage`）请求的消耗**，与会话总量**同源同事务**——总量没计的请求不进明细，保证两处数字永远对得上。
- 每条记录（`TurnCost`，全部来自持久化日志与该请求时刻的价格表求值，无估算）：
  - `turn` / `step`：来自 `event.data`
  - `time`：`event.time`（epoch ms，与现有高峰判定同一来源）
  - 四类 token：`inputTokens`（该请求总输入 = 未命中 + 命中 + 写入）、`cacheReadTokens`、`cacheWriteTokens`、`outputTokens`
  - `cacheHitRate`：该请求 `cacheRead / (uncached + cacheRead)`，分母为 0 时为 0（与会话级公式一致）
  - `cost`：该请求费用（`PRICE_PRECISION` 单位）；`currency`：该请求币种；`period`：`'peak' | 'off-peak'`（按 `time` 求值）
  - `priced`：该请求模型是否登记了价格（false 时 `cost` 为 0）
- **有界投影**：`SessionBillingStats` 新增 `turns: TurnCost[]`，只保留**最近 50 条**（`RECENT_TURNS_CAP`，定义在 `shared.ts`），追加后截断——纯函数、可重放，帧体积有上界（约 10KB）。
- **全量按需路由**：新增 `/billing/api/turns`，载荷 `{ sessionId }` → `{ turns: TurnCost[] }`（全量、升序）。复用 `refresh` 路由的模式：按 sessionId 取 `ctx.sessions` 的活日志**现场折叠**，无状态、无缓存。

**数据流**：`assistant/message` 事件 → `foldEvent` 追加 `TurnCost` 并截断到 50 条（纯函数）→ 投影帧带 `turns` → 卡片迷你图直接渲染；详情面板打开时再调 `turns` 路由取全量。

### FR-7 逐请求消耗展示（卡片迷你图 + 详情面板）

- **卡片迷你图**：统计卡片费用区下方新增「最近消耗」块：取 `stats.turns` 的**最后 10 条**，每条一根横条，长度 ∝ 该条 `cost`（按窗口内最大值归一），颜色区分 `period`（高峰/空闲，复用现有徽标配色）；hover 用 `title` 属性显示 `第 turn.step 次 · 输入/输出 token · 费用 · 命中率`。`turns` 为空（无请求或旧 host 未带该字段）时整块不渲染。多币种会话条长仅作趋势参考（S-5）。
- **详情面板**：卡片头部刷新按钮旁新增「明细」按钮，打开一个**独立 portal 面板**（复用现有 `BillingPopover` 的 portal + fixed 定位模式，不入路由）：
  - 宽度 560px、`max-height: 70vh`、内部滚动；视口 < 600px 时宽度 `calc(100vw - 16px)`、左右 8px 边距。
  - **逐请求图**（一张图 + 维度切换，**图表跟随视图切换**）：
    - 「费用」维度：每次请求一根柱子，长度 ∝ `cost`，按 `period` 着色；`priced: false` 的柱子用空心/斜纹样式（hover 注明未登记）。
    - 「token」维度：四段堆叠（输入未命中 / 缓存命中 / 缓存写入 / 输出），看上下文构成变化。
    - **横轴时间递增**：轮次从左到右递增（最老在左、最新在右），符合阅读顺序（v0.3.4 修订；列表保持最新在最上）。
    - **按轮次视图**：一个轮次内的工具调用 step 合并为一根柱；**按请求视图**：每个请求独立一根柱（序号 `N.step`）——图表粒度与明细表粒度一致。
    - 超过约 40 条时横向滚动；手写 div + flex 实现，**不引图表库**（D-4）。
  - **明细表**（可滚动，列固定顺序，表头不带括号）：`轮次(turn.step)` · `时间(HH:MM:SS)` · `输入(未命中)` · `命中` · `写入` · `输出` · `命中率` · `费用` · `时段`；`priced: false` 行在费用列显示「未登记」标签。「按请求」视图请求序号始终带 step（`N.1`/`N.2`…，单请求轮也显示 `N.1`）。
  - 打开时用 `stats.turns` 先行渲染，同时调 `turns` 路由取全量替换（加载中/失败内联提示，失败保留已有数据）；面板右上角放刷新按钮重拉。面板打开期间**不自动轮询**（后续增强）。
  - 关闭：点击外部 / Esc / 再次点击「明细」按钮，与卡片 popover 行为一致。

### FR-8 上下文窗口占用（日志真实数据，纯折叠）

- **数据来源（全部来自持久化日志，无异步、无新路由）**：
  - `contextWindow`：折叠消费 `request/context` 事件，**last-wins**——载荷带 `contextWindow` 则设置，**不带则清除**（模型切到未公布容量的路由时，旧窗口值不得残留；此语义与主仓库 token-meter 的 `contextPressure` 投影一致）。
  - `lastRequestInputTokens`：每次带 `usage` 的 `assistant/message`，记 `inputTokens + cacheReadTokens + cacheWriteTokens`（该请求总输入，即上下文占用分子；**不是累计值**，见 R-1）。
  - `maxOutputTokens`：折叠消费 `request/header` 时取 `header.config.maxTokens`（adapter 已填入默认值后的**实际生效**上限）；缺省则清除。
- **折叠联动（易错点，必须在测试覆盖）**：现有 `request/header` 不变即返回原状态的 no-op 快路径只比较 provider/model/effort——必须**把 `config.maxTokens` 纳入比较**，否则仅改输出上限的 header 会被误判为 no-op，`maxOutputTokens` 不更新。
- **卡片展示**：
  - token 网格下方新增一行**上下文占用进度条**：`上下文占用 62% ▓▓▓▓▓░░░░`（百分比 = `lastRequestInputTokens / contextWindow`，纯 CSS 进度条；二者任一缺省则整行不显示）。
  - 占用 ≥ `CONTEXT_WARN_THRESHOLD`（0.85，定义在 `shared.ts`）时进度条变预警色 + 文案「接近上限，建议开新会话」。
  - 最近一次请求输入占窗口 ≥ `SINGLE_TURN_WARN_RATIO`（0.3，`shared.ts`）时追加小字提示「最近一次请求输入占上下文 xx%」。
  - `maxOutputTokens` 存在时，占用行旁/下方显示 `输出上限 8K`（`formatTokens` 格式化）；不存在则不显示。
- **口径说明（写进 README 已知限制）**：占用反映**最近一次已完成请求**的提示词规模；压缩/裁剪发生后、下一次请求上报 usage 之前，占用条不会立即下降（与 token-meter 的 `pressureTokens` 同口径）。

### FR-9 设置页展示模型能力

- **路由**：扩展现有 `catalog` 路由——对每个 provider 的每个模型并行调 `ctx.llm.resolveModelInfo(provider, model)`（`Promise.all`，单模型失败/拒绝 → 该模型能力字段缺省，不影响其他模型），响应中每个 model 增加：
  ```ts
  capability?: { contextWindow?: number; maxTokens?: number }
  ```
  - `contextWindow` ← `info.context?.contextWindow`（缺省 = adapter 未公布）。
  - `maxTokens` ← `info.defaultMaxTokens`。**注意口径**：这是**部署配置的**单请求输出上限——pi-ai 仅在 profile 显式配置 `maxTokens` 时才返回，从内置目录继承的能力值**不会**出现在这里（主仓库设计使然）。UI 文案须如实标注（见下）。
- **展示**：设置页每个模型行的标题区（模型名旁或价格字段上方）加一行小字，如 `上下文 200K · 输出上限 8K（配置）`；任一字段缺省则只显示有的那段，都没有则不显示该行。**只读**，不可编辑（能力是 adapter/部署属性，不是价格配置）。
- **不做 host 缓存**：`resolveModelInfo` 是 adapter 持有的本地目录查找（无网络），`catalog` 仅在打开设置页时调用一次，开销可接受。若未来接入的 adapter 在此处引入网络开销，再评估缓存（记为后续项）。

---

## 4. 数据模型变更

```ts
// ── shared.ts 新增 ──

/** 一次计费请求的消耗明细（一条带 usage 的 assistant/message）。 */
export interface TurnCost {
  turn: number
  step: number
  time: number                       // epoch ms（event.time）
  inputTokens: number                // 该请求总输入（未命中 + 命中 + 写入）
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  cacheHitRate: number               // cacheRead / (uncached + cacheRead)，分母 0 时为 0
  cost: number                       // PRICE_PRECISION 单位；priced=false 时为 0
  currency: string
  period: 'peak' | 'off-peak'
  priced: boolean                    // 该请求模型是否登记了价格
}

/** 设置页用的模型能力（catalog 路由返回，尽力而为）。 */
export interface ModelCapability {
  contextWindow?: number             // adapter 公布的窗口；缺省 = 未知
  maxTokens?: number                 // 部署配置的输出上限；缺省 = 未配置
}

// ── SessionBillingStats 新增四个字段 ──
turns: TurnCost[]                    // 最近 ≤ RECENT_TURNS_CAP 条，升序（有界）
lastRequestInputTokens?: number      // 最近一次请求总输入（占用分子）
contextWindow?: number               // 最近 request/context 的窗口（占用分母；切到未知容量路由时清除）
maxOutputTokens?: number             // 最近 request/header config.maxTokens（实际生效上限；缺省则清除）

// ── shared.ts 新增常量 ──
export const RECENT_TURNS_CAP = 50
export const CONTEXT_WARN_THRESHOLD = 0.85
export const SINGLE_TURN_WARN_RATIO = 0.3
```

**`EMPTY_STATS` 联动**：`turns: []`（冻结）；三个可选字段缺省。`cloneStats` 增加 `turns: [...stats.turns]`。

**联动点清单**（README「第三方插件要点」已声明四处，本轮扩展为六处，需同步更新 README）：
1. `src/shared.ts`——wire 类型 + 常量（上表）
2. `src/host/session-stats.ts`——折叠：`assistant/message` 追加/截断 `TurnCost`；`request/context` last-wins 设置/清除 `contextWindow`；`request/header` 设置/清除 `maxOutputTokens` 且 **no-op 比较纳入 `maxTokens`**
3. `src/host/index.ts`——投影 zod schema 新增字段（`turns` 数组 + 三个可选 number）；`stateVersion` **5 → 6**；`catalog` 路由扩展 `capability`；新增 `turns` 路由
4. `src/client/billing-api.ts`——`TurnCost` / `ModelCapability` re-export、`getTurns(sessionId)`、`ProviderCatalogRow` 模型行加 `capability`
5. `src/client/types.ts`——无需改（`SessionProjectionMap['billing']` 引用 `SessionBillingStats`，类型随 shared 更新）
6. `tests/pure-check.ts`——新增断言（见 §6）

**wire 兼容**：客户端读新字段一律按可缺省防御（`stats.turns ?? []`、`stats.contextWindow === undefined` 判断等）——host 未重启的旧帧 schema 会剥掉未知 key，新客户端不得在缺字段时报错（沿用现有 `peakModels ?? []` 模式）。

---

## 5. 关键决策与理由

| # | 决策 | 理由 |
|---|---|---|
| D-1 | 逐请求明细由**纯折叠**产出，不进异步 | `foldEvent` 保持同步纯函数；`TurnCost` 数据全在日志 + 价格表求值里，可重放 |
| D-2（修订） | 上下文窗口/输出上限**从持久化日志折叠**（`request/context` + `request/header.config.maxTokens`），不走异步 capability 路由 | 数据已在日志里：纯函数、可重放、随会话历史正确（多模型切换各归各），且是**实际生效值**而非目录查询值。原方案的异步路由 + 缓存全部不需要（R-2） |
| D-3（修订） | 设置页能力并入**现有 `catalog` 路由**，并行解析、单模型失败降级缺省，**不做 host 缓存** | `resolveModelInfo` 是本地目录查找；catalog 每次开设置页调一次，缓存是无收益复杂度。未来 adapter 引入网络开销再议 |
| D-4 | 图表**不引库**，纯 CSS 横条 / 手写 div+flex 柱图 | client bundle 体积与 purity gate 约束；图表量级小（每请求一根条）不值得引库 |
| D-5 | 上下文占用用**真实 contextWindow**，不用分段边界估算；分子用**最近一次请求总输入**，不用累计输入 | 分段边界是价格档不是模型能力；累计输入是计费口径，长会话单调超 100%，无预测意义（R-1） |
| D-6 | 详情面板复用 portal + fixed 定位模式 | 与现有卡片打开方式一致，不引入新的路由/窗口系统 |
| D-7（新增） | 投影帧只带**有界** `turns`（50 条），全量走 `turns` 按需路由 | 投影每事件推完整 view，无界数组 → 帧体积 O(N²) 增长 + 撑大投影持久化缓存（R-3）。卡片迷你图只需最近 10 条，50 条余量充足 |
| D-8（新增） | 未登记价格的请求也进明细（`priced: false`、`cost: 0`） | token 消耗是真实的；明细与会话总量同源，缺请求会让两处对不上；UI 标「未登记」避免误导 |
| D-9（新增） | 模型切到未知容量路由时**清除** `contextWindow` / `maxOutputTokens` | last-wins 的另一半：残留旧值会把 A 模型的窗口安到 B 模型头上。与主仓库 token-meter `contextPressure` 投影同语义 |

---

## 6. 验收与测试

### 纯逻辑（`tests/pure-check.ts` 新增断言）

- 多请求折叠 → `turns` 顺序与条数正确；每条的 `turn`/`step`/`time`/四类 token/`cacheHitRate`/`cost`/`currency`/`period`/`priced` 逐项正确（含高峰归属、含分段取档的一次）。
- 超过 50 条请求 → `turns` 长度恰为 50 且是**最后** 50 条（截断方向正确）。
- 未登记模型的请求 → `priced: false`、`cost: 0`，且 `unpricedRequestCount` 仍同步 +1（明细与总量同源）。
- 无 `usage` 的 `assistant/message` → 不进 `turns`、不计总量（与现状一致）。
- `request/context`：带窗口 → `contextWindow` 设置；后续不带窗口的 `request/context`（模型切换）→ **清除**。
- `request/header`：`config.maxTokens` 存在 → `maxOutputTokens` 设置；后续 header 缺省 → 清除。
- **no-op 快路径**：仅 `maxTokens` 变化的 header 不得返回原状态对象（`maxOutputTokens` 必须更新）；完全不变的 header 仍返回原状态（现有断言保留）。
- `lastRequestInputTokens` = 最近一次请求的三项输入之和（不是累计）。
- 空日志 → `turns: []`、三个可选字段全缺省。

### host 联动（手动/构建验证）

- `stateVersion` 递增到 6（旧投影缓存行自动失效重折）。
- 投影 zod schema 覆盖新字段；`catalog` 响应带 `capability`（可用真实 profile 跑一次核对 wpsai/zai 模型）；`turns` 路由对未知 sessionId 返回 404（复用 `refresh` 的校验路径）。

### UI 冒烟（`pnpm dev:watch` + GUI 实测）

- 卡片出现迷你图（最近 ≤10 条），hover 出 `title` 提示；无请求时不渲染。
- 「明细」按钮开面板：维度切换、堆叠图、明细表滚动、未登记行标签；面板宽屏 560px / 窄屏自适应；Esc/外点关闭。
- 占用进度条百分比与最近请求输入一致；≥85% 预警样式与文案；`maxOutputTokens` 有/无两种情形的显隐。
- 设置页模型行显示能力行；无缺省时整行不显示。
- **回归**：现有卡片字段顺序、高峰分栏、徽标、刷新、设置页编辑保存不受影响。

### 命令

```sh
pnpm test        # node tests/pure-check.ts（纯逻辑）
pnpm typecheck   # tsc --noEmit（src + tests）
pnpm build       # tsc(lib/types) + tsdown(lib/index.js + lib/client.js)
```

host 改动需重启 `dsh web`；client 改动经 `pnpm dev:watch` 热更新（README 开发节已有说明）。

---

## 7. 风险与限制（评审后状态）

| # | 事项 | 状态 |
|---|---|---|
| 1 | capability 失败降级 | **已解决**（D-2/D-3）：卡片数据全部来自日志，无异步依赖；设置页 `catalog` 单模型失败降级为该模型能力缺省 |
| 2 | 逐轮明细体积 | **已解决**（D-7）：投影有界 50 条 + 全量按需路由 |
| 3 | `defaultMaxTokens` 可得性 | **已明确**：卡片用 `request/header.config.maxTokens`（实际生效值，覆盖显式与 adapter 默认两种情形，middleware 无 adapter 时缺省则不显示）；设置页 `defaultMaxTokens` 仅部署显式配置时存在，文案标注「（配置）」 |
| 4 | 大面板定位/尺寸 | **已确定**（FR-7）：560px / 70vh / 窄屏 `calc(100vw - 16px)` |
| 5 | 迷你图多币种 | **已确定**（S-5）：窗口内最大值归一 + 时段着色 + hover 精确值，跨币种仅供趋势参考 |
| 6（新增） | 占用口径滞后于压缩 | **接受**：占用反映最近一次已完成请求；压缩发生后待下一次请求上报才回落（与 token-meter 同口径）。README 已知限制如实说明 |
| 7（新增） | 迷你图 tooltip 用原生 `title` | **接受**：现有卡片无 tooltip 设施，`title` 属性零成本可达；自定义 tooltip 记为后续打磨项 |

---

## 8. 开发方案（给实现 agent 的任务分解）

> 按依赖顺序执行；每一步完成后跑 §6 的命令再进下一步。不要改动主仓库任何文件。

### Step 1 — 数据模型与折叠（host 纯逻辑）

1. `src/shared.ts`：加 `TurnCost` / `ModelCapability` 接口、`RECENT_TURNS_CAP` / `CONTEXT_WARN_THRESHOLD` / `SINGLE_TURN_WARN_RATIO` 常量；`SessionBillingStats` 加四字段；`EMPTY_STATS` 补 `turns: []` 并冻结。
2. `src/host/session-stats.ts`：
   - `cloneStats` 加 `turns: [...stats.turns]`。
   - `foldEvent` 的 `assistant/message` 分支：构造 `TurnCost` 追加后截断到 `RECENT_TURNS_CAP`；记 `lastRequestInputTokens`。`currency`/`period`/`priced` 复用现有 `effectivePrice` 求值结果（`eff.found` → `priced`）。
   - 新增 `request/context` 分支：`contextWindow` last-wins，载荷缺省则删除该 key（返回新 stats 对象；值未变时返回原状态避免推 no-op 帧）。
   - `request/header` 分支：no-op 比较**增加 `config.maxTokens`**；通过则设置/清除 `maxOutputTokens`。
3. `tests/pure-check.ts`：按 §6 纯逻辑清单补断言。`pnpm test` 绿。

### Step 2 — host 路由与 schema

4. `src/host/index.ts`：
   - 投影 zod schema：`turns: zod.array(turnCostSchema)`（`turnCostSchema` 按 `TurnCost` 逐字段声明，`period` 用 `zod.union([zod.literal('peak'), zod.literal('off-peak')])`）、三个可选字段 `zod.number().int().nonnegative().optional()`（`contextWindow`/`maxOutputTokens` 用 `.positive()`）；`stateVersion: 6`。
   - 路由 switch 新增 `case 'turns'`：复用 `refreshSession` 的 sessionId 校验 + 活日志折叠，返回 `{ turns }`（全量，不截断——现场折叠时绕开 cap 或对折叠函数加参数，**选其一并在代码注释说明**：推荐 `foldBilling(events, table)` 返回全量、投影 apply 路径单独截断，即截断只发生在投影 apply 包装里）。⚠️ 实现时注意：若截断在 `foldEvent` 内，`refresh` 路由返回的 stats.turns 也是有界的——可接受（refresh 只驱动卡片），但 `turns` 路由必须全量。
   - `catalog`：`listModels` 后对每个模型 `Promise.all` 调 `resolveModelInfo`，装配 `capability`（单模型 try/catch → 缺省）。
5. `pnpm typecheck && pnpm build`；重启 `dsh web` 后用真实 profile 核对 `catalog` 响应。

### Step 3 — client 数据层

6. `src/client/billing-api.ts`：re-export `TurnCost` / `ModelCapability`；`ProviderCatalogRow['models']` 元素加 `capability?: ModelCapability`；新增 `getTurns(sessionId): Promise<TurnCost[]>`。
7. 读 `stats` 新字段处全部按可缺省防御（§4 wire 兼容）。

### Step 4 — 卡片：占用行 + 迷你图 + 明细入口（`BillingAction.tsx` + css module + locales）

8. 占用行：`contextWindow` 与 `lastRequestInputTokens` 齐 → 渲染进度条（div 宽度百分比）+ 百分比文案；≥ `CONTEXT_WARN_THRESHOLD` 加预警 class 与文案；`maxOutputTokens` 存在 → `输出上限` 小字。单轮占比提示按 FR-8。
9. 迷你图：`stats.turns?.slice(-10)`，横条长度 `cost / max(cost)`，按 `period` 着色，`title` 属性组装 hover 文本；空则不渲染。
10. 卡片头部加「明细」按钮（图标或文字，与刷新/设置按钮同排），开关详情面板。
11. `locales.ts` 新增全部文案 key（zh + en 同步）。

### Step 5 — 详情面板（新文件 `BillingTurnsPanel.tsx` + css module）

12. portal + fixed 定位（560px / 70vh / 窄屏兜底），Esc/外点关闭。
13. 打开时以 `stats.turns` 首渲染，同时 `getTurns(sessionId)` 取全量替换；加载中/失败内联态；刷新按钮重拉。
14. 维度切换（费用/token）：费用柱按 `period` 着色、未登记空心样式；token 四段堆叠；超 ~40 条横向滚动。
15. 明细表：列序按 FR-7；`priced: false` 行费用列显示「未登记」。

### Step 6 — 设置页能力行（`BillingSettings.tsx` + locales）

16. catalog 类型更新后，模型行标题区渲染能力小字行（字段缺省规则见 FR-9）；只读。

### Step 7 — 文档

17. `README.md`：功能特性补「逐请求明细与图表」「上下文占用」两节；数据模型速览补新字段；第三方插件要点的联动点清单四处 → 六处；已知限制补「占用口径滞后于压缩」「跨币种迷你图条长仅供趋势」「设置页输出上限仅部署配置值」三条。

---

## 9. 迭代记录

- **v0.3 草稿**：建立 PRD（逐轮消耗 + 上下文占用）。
- **v0.3 评审修订（开发基线）**：对照主仓库源码核实全部技术假设。修正 R-1（占用分子：累计输入 → 最近一次请求总输入）、R-2（上下文窗口/输出上限改从持久化日志纯折叠，撤销异步 capability 路由与 host 缓存）、R-3（投影帧体积：有界 50 条 + 全量按需路由，落实为 D-7）；明确粒度（请求级，S-1）、图表合并（S-2）、未登记请求入明细（D-8）、未知容量清除语义（D-9）、header no-op 比较纳入 `maxTokens`（FR-8 易错点）；补充 §8 七步开发方案与验收清单。
- **v0.3 落地**：按最终方案实现全部代码（§8 Step 1–6），typecheck/纯逻辑测试/完整构建全绿；Step 7 文档同步完成（README 与主 PRD）；GUI 冒烟验证通过（host 重启加载新路由与 schema）。
- **v0.3.4（GUI 实测反馈修订）**：① 详情图表横轴改为轮次从左到右递增（最老在左、最新在右，时间递增），与列表「最新在最上」解耦；② 明细表头去掉括号（未命中/命中/写入/输出，新增 `turn.cacheMiss`）；③ 「按请求」视图请求序号始终带 step（`N.1`/`N.2`…，不再省略）；④ 图表跟随视图切换——「按轮次」每轮一根柱（step 合并），「按请求」每个请求一根柱（`N.step`），图表粒度与明细表粒度一致（初稿曾做成「图表始终按轮次」，经 GUI 实测确认冗余后修正）。
