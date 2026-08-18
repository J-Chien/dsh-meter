# dsh-meter 产品需求文档（PRD）

> 状态：**已实现（v0.3.16）** · 最近更新：见文末
> 本文档沉淀**当前有效**的产品需求与决策，供后续迭代/评审使用。逐版本变更记录见 [CHANGELOG.md](CHANGELOG.md)（新版本条目追加在其最上方）；已归档的迭代设计稿在 [archive/](archive/)。

---

## 1. 产品概述

**一句话**：为 DeepSeek Harness 提供**按会话**的 token 用量与费用可视化，让用户在对话时即时了解当前会话的消耗与花费，并能按自己实际的 provider 价格与高峰时段灵活配置计价。

**目标用户**：重度使用 DSH 的开发者/团队，尤其是通过代理（如 wpsai）调用多个模型、需要跟踪成本、关注缓存收益与高峰时段费用的用户。

**核心价值**：
1. 会话级成本透明——不用等到账单，边聊边看
2. 缓存效果可视化——命中/未命中/写入分开，看缓存优化是否有效
3. 计价可配置——价格、币种、高峰时段、分段计费完全由用户掌控，不依赖内置价格准确性
4. 第三方插件形态——不动主仓库，可安装到任意 dsh profile

**非目标（明确不做）**：
- 不做全局/跨会话聚合报表（后续可做）
- 不做预算/告警/配额控制（后续可做）
- 不做真正的账单结算，仅按用户配置的价格做**估算展示**
- 不做除 web GUI 外的终端展示

---

## 2. 背景与问题

用户在 DSH Web GUI 中对话，无法直观得知：
- 当前会话消耗了多少 token、其中多少是缓存命中、缓存命中率多少
- 当前会话花费了多少钱
- 不同模型/provider 的计价各不相同，且可能有高峰/空闲差价

现有产品缺少会话级计费可视化；价格数据依赖第三方代理（wpsai）等，无内置权威价格，因此必须**用户可配置**。

---

## 3. 用户故事

| ID | 故事 |
|---|---|
| US-1 | 作为用户，我希望在会话右上角常驻看到一个费用入口，以便随时知道当前会话花了多少 |
| US-2 | 作为用户，我希望 hover/点击能看到 token 明细（输入命中/未命中、输出、缓存命中率），以便了解上下文构成与缓存效果 |
| US-3 | 作为用户，我希望看到按币种分开的费用（多 provider 多币种不混算），以便准确理解花费 |
| US-4 | 作为用户，我希望模型配置了高峰时段时能看到空闲/高峰的费用拆分，以便了解时段对成本的影响 |
| US-5 | 作为用户，我希望在设置页按 provider 分组配置价格，无需手动添加模型，以便快速填价 |
| US-6 | 作为用户，我希望每个 provider 可以选自己的币种，以便多币种 provider 各自正确计价 |
| US-7 | 作为用户，我希望每个模型支持多个高峰时段且默认用空闲价预填，以便贴合真实计费规则 |
| US-8 | 作为用户，我希望未配置价格的模型显示「未登记价格」而不是 0，以便知道我漏配了 |
| US-9 | 作为用户，我希望价格变更后能一键刷新当前会话，以便立即看到按最新价格的结果 |
| US-10 | 作为开发者，我希望改 UI 能热更新、无需重启 GUI，以便快速迭代 |
| US-11 | 作为用户，我希望看到当前会话每次请求/每轮的消耗（token/费用/命中率），以便定位「哪次最贵、哪次缓存没生效」（FR-6/FR-7） |
| US-12 | 作为用户，我希望用图表直观看到逐轮费用的起伏，以便快速扫视成本走势（FR-7） |
| US-13 | 作为用户，我希望看到最近一次请求的上下文占用比例与离自动压缩还有几轮，以便预判还能聊多久、何时该开新会话（FR-8） |
| US-14 | 作为用户，我希望在设置页看到每个模型的上下文窗口与输出上限，以便了解模型真实能力边界（FR-9） |

---

## 4. 功能需求

### FR-1 会话头部入口（常驻）

- **入口**：每个会话右上角常驻一个费用徽标（复用 `conversation.session.header.actions` 槽位）。
- **默认态**：新会话（无任何请求）显示 `¥0.00`。
- **未登记态**：会话有请求但**所有**模型均未配置价格时，显示「未登记价格」标签（琥珀色圆角标签，多语言）。
- **部分登记态**：显示已登记部分的费用（合计数），未登记部分不混入。
- **高峰/空闲标识**：会话用到的模型配置了高峰窗口时，徽标旁显示圆角状态标签——当前处于高峰显示红色「高峰」，空闲显示灰色「空闲」（弱饱和配色，每分钟重算，跨窗口边界自动切换）；未配置高峰时段则不显示任何标签。
- **交互**：
  - hover 200ms 展开卡片、离开 300ms 关闭；点击固定展开；再次点击/点击外部/Esc 关闭（延迟常量的唯一事实源是 `src/client/interaction.ts`，卡片与 tooltip 同源）。
  - 展开箭头随开关旋转。
- **验收**：
  - 空会话显示 `¥0.00`。
  - 全未登记显示「未登记价格」标签。
  - hover 与点击均可用，箭头状态正确。
  - 高峰时段内徽标旁出现红色「高峰」标签，空闲时出现灰色「空闲」标签，无高峰配置时不显示。

### FR-2 统计卡片内容

卡片展示（命名与顺序固定，详见 §7 术语）：

0. **当前模型**：标题下方一行 `provider / model`（等宽小字条；来自最近一次请求的 `currentModel`）
1. 输入（缓存命中）—— `cacheReadTokens`
2. 输入（缓存未命中）—— `uncachedInputTokens`
3. 输入（缓存写入）—— `cacheWriteTokens`，**仅当会话存在缓存写入 token 时显示**
4. 输出 —— `outputTokens`
5. 缓存命中率 —— `cacheRead / (uncached + cacheRead)`，百分比

费用区（按币种分行）：
- 总费用（每币种一行，标签不带币种符号，金额右侧带符号如 `¥/$`）
- 当 `hasPeakConfig` 为真时，额外每币种两行：**空闲时段**、**高峰时段**

卡片头部：
- 标题「本会话计费」+ 标题旁**小刷新按钮**（重算当前会话）
- 右上角**齿轮设置**按钮（打开计费设置页；已知当前模型时**自动展开对应 provider 并滚动定位到该模型**——下方空间足够则模型显示在视口第一行，否则保持在底部，不强行留白）

- **验收**：字段顺序、命名、括号小字、币种分行、高峰分栏条件均正确；模型行显示正确；齿轮跳转后模型被展开并定位；缓存写入行为 0 时不显示。

### FR-3 价格配置（设置页）

- **入口**：设置侧栏新增「计费」页（复用 `settings.section` 槽位）。
- **按 provider 分组**：从 `ctx.llm.listProviders()` 读取已注册 provider 及其模型目录，分组折叠展开（**默认全部折叠**；折叠/展开控件为标题右侧的箭头图标按钮，整行可点击切换）；**无手动添加模型**。
- **每 provider 币种**：CNY / USD，独立选择；单位说明随币种显示（`单位：¥/百万Tokens`）。
- **每模型四价**：输入（缓存命中）、输入（缓存未命中）、缓存写入、输出，单位"元/百万 token"；输入框显示**自动补零到两位小数**（`10` → `10.00`），**超过两位小数按实际值显示**（`10.155` 不变）。
- **分段计费（开关）**：
  - 每个模型行标题右侧有**分段计费开关**；开启后**默认价格成为第一段**（可编辑区间）。
  - 分段与默认价格是**连续的一整套档**：每段 = 区间（输入长度 + 输出长度）+ 同一套四价字段（输入命中/未命中、缓存写入、输出），字段命名与默认价格完全一致，不换行。
  - 区间行首按序编号**「区间 1」「区间 2」…**：默认段 = 区间 1，后续新增依次递增（方便对照每次请求落在哪一段）；每段内部**「输入区间」「输出区间」分两行堆叠**（各自带 `K tokens` 单位，长边界不换行不溢出）。开关关闭时不显示任何分段字样。
  - 「添加分段」就在默认价格行下方直接增加新区间行；新增分段时**自动用默认价预填**。
  - 长度以 K tokens 输入（`32` = 32K，`0.2` = 200 tokens）；**下限默认填 `0`**，上限留空 = 不限（显示 `∞`）。
  - 关闭开关时清空分段；无分段 → 始终按默认价计。
- **高峰时段**：
  - 每个模型可配**多个**高峰窗口（起止小时 + 各自四价）；起止时间以时钟样式显示（`9:00`、`22:00`，结束可为 `24:00`）。
  - 每个高峰窗口内结构为**时段 → 分段计费**：顶部是窗口的起止时间，其下「分段计费」块包含从**区间 1**（该窗口的默认/平价）开始的全部区间，区间按基础分段编号（只读），价格单独编辑（按索引对齐）。
  - 高峰每段的区间用**区间记号**展示：`输入长度 [0, 32)`、`输出长度 [0, 0.2)`、`[0.2+)`——下限缺省 = 0、上限缺省 = `+`，无约束的维度不显示、全无约束的默认段显示「全部」。
  - 新增/删除分段时高峰窗口**同步增删**对应段，结构始终与空闲时段**完全一致**。
  - 不配任何高峰窗口 → 始终按空闲/默认价计。
- **保存**：写回设置存储，host 自动重算所有会话。
- **从卡片定位**：悬浮卡片点齿轮进入设置页时，若会话已知当前模型，自动展开其 provider 分组并滚动定位该模型行（`data-billing-model` 定位 + 视口自适应：下方空间足够则置顶，否则靠底显示）。
- **未登记语义**：未填任何价格/时段/分段的新模型在保存时不写入（保持"未登记"）。
- **验收**：分组正确、币种独立、四价可编辑、分段开关正确、默认价=第一段、多分段可增删且连续、区间布局不换行、高峰时段同步增减分段、高峰价格按索引对齐、预填正确、保存后全局重算。

### FR-4 计价引擎

- **按请求时刻归属时段**：每个请求用其 `assistant/message` 事件的持久化 `time`（epoch ms）判断命中哪个高峰窗口，精确到请求，重放/历史会话一致。
- **按请求长度取档**：每个请求用其**总输入长度**（未命中 + 命中 + 写入）与输出长度命中匹配的价格分段，整单按该档单价计；**无区间约束的段（默认/全部）作为兜底**，具体区间段优先。
- **高峰时段价格独立、区间复用**：活跃高峰窗口存在时，按**模型分段区间的索引**取该窗口对应段的高峰价格（无匹配则用该窗口的平价）；否则用模型的空闲分段/平价格。
- **分桶计价**：未缓存输入、命中缓存输入、缓存写入、输出分别按对应单价计；`cacheWrite` 未配置（或缺省）时按 0 计。
- **缓存写入用真实 token 数，不估算**：`cacheWriteTokens` 来自每次请求持久化的 usage；按「缓存存储时长」计费的模型（如按 token·小时）因日志无时长维度不建模。
- **高峰窗口匹配**：支持跨天窗口（如 22:00–06:00）；`days` 空/缺省 = 每天，非空 = 按**窗口起始日**的星期几过滤（「周五 22:00–06:00」覆盖周六凌晨）；起止相同 = 全天。
- **reasoningEffort 匹配**：effort 精确匹配的价格行优先于无 effort 的通用行（与数组顺序无关）；无 effort 的请求只命中通用行（`findPriceRow` 单一事实源）。`peakModels` 的 key 在命中 effort 专属行时带第三段 effort（`provider/model/effort`），client 高峰标签据此查同一行。
- **未登记计数**：无价格行的请求计入 `unpricedRequestCount`，不计入费用。
- **多币种**：费用按 provider 币种分桶（`cost: {CNY, USD}`）。
- **精度**：内部整数 `PRICE_PRECISION=100000`（1/100000 币种单位）存储，统计显示 2 位小数；设置页输入显示补零到两位小数、超过两位按实际值（整数运算）。
- **验收**：高峰/空闲归属正确、跨天窗口正确、分段取档正确（含 32K/200 边界）、高峰窗口自身分段优先、缓存写入独立计价、多币种不混算、未登记不计费、4 位小数价格无浮点误差（测试见 `tests/pure-check.ts`）。

### FR-5 刷新

- 卡片刷新按钮：按**最新价格表**重算当前会话并立即显示（不等投影推送）。
- 设置页保存：自动触发全局重算。
- **验收**：改价后点刷新，卡片费用按新价更新。

### FR-6 逐请求消耗明细（数据层）

- 折叠在统计会话总量的同时，**逐条记录每次带 `usage` 的 `assistant/message` 请求**为 `TurnCost`（`turn`/`step`/`time`/四类 token/`cacheHitRate`/`cost`/`currency`/`period`/`priced`），与会话总量**同源同事务**——总量没计的请求不进明细，两处数字永远对得上。
- **未登记价格的请求也记录**（`priced: false`、`cost: 0`）：token 是真实的，UI 标「未登记」而非误导性的 `¥0.00`。
- **有界投影**：`SessionBillingStats.turns` 按**轮次**保留最近 `RECENT_TURNS_CAP=50` 轮（`boundTurns` 纯函数，一个轮次的全部 step 不拆散；**按轮号计数，多币种轮只占一个名额**）——投影每事件推完整 view，无界数组会使帧体积 O(N²) 增长。
- **全量按需路由**：`/billing/api/turns` 载荷 `{ sessionId }` → 全量 `TurnCost[]`（升序），按 sessionId 取活日志**现场折叠**，无状态、无缓存。
- **验收**：turns 顺序/条数/逐字段正确；超 50 轮截断方向正确且不拆散轮次；未登记请求 `priced:false` 且 `unpricedRequestCount` 同步 +1；无 `usage` 的消息不进明细；空日志 `turns: []`（测试见 `tests/pure-check.ts`）。

### FR-7 逐请求消耗展示（卡片迷你图 + 详情面板）

- **卡片迷你图「每轮新增」**：每轮一根**新增占用 token** 竖条，柱高 = 该轮最后一个请求总输入 − 上一轮最后一个请求总输入（**快照差分**——总输入快照与缓存状态无关，免疫缓存失效时未缓存输入的假性暴涨；**第 1 轮的新增 = 其整轮快照**——前驱是空上下文，首轮装载的全部内容都是新增；截断帧的首轮无前驱信息，不计）；最老轮在左、时间递增；高峰轮暖色着色；hover 出统一 Tooltip（轮次/新增占用/费用/命中率）；柱宽固定 18px、**从左到右 3px 等距排列**（与详情面板图表一致，非两端分散对齐），**按卡片实际宽度用 ResizeObserver 实时算出容纳轮数**。
- **详情面板**：卡片头部「查看详情」打开独立 portal 面板（560px / 70vh，窄屏 `calc(100vw - 16px)`；Esc/外点关闭）：
  - **图表跟随视图切换**：「按轮次」每轮一根柱（工具调用 step 合并，`aggregateTurns`），「按请求」每个请求一根柱（12px 密集模式、宏观趋势视角）。
  - **横轴时间递增**（最老在左）、纯数字标签（`12` / `12.3`）、自动抽稀（首尾必标）；按请求模式每轮首个请求 `N.1` 前加 8px 分组间隔、标签必标并加粗提亮。
  - 费用维度：带纵向刻度轴（0 在底、最大值在顶），按时段着色，未登记特殊样式；token 维度：四段堆叠（未命中/命中/写入/输出，蓝阶渐变 + 琥珀输出），附互斥口径说明。
  - **明细表按轮次倒序**（最新轮在最上）：「按轮次」为聚合表；「按请求」为**可折叠轮次分组**（每轮一行聚合 + 展开箭头，默认折叠，请求序号始终带 step）；时段相关展示仅在 `hasPeakConfig` 时出现。
  - 打开时以 `stats.turns` 先行渲染，同时 `getTurns` 拉全量替换（失败保留已有数据并内联提示）；面板不自动轮询。
- **验收**：两个视图的图表粒度与表格粒度一致；横轴方向与抽稀正确；未登记/高峰样式正确；折叠分组展开正确；窄屏布局不破。

### FR-8 上下文占用与压缩预测（日志真实数据，纯折叠）

- **数据来源（全部纯折叠自持久化日志，无异步）**：
  - `contextWindow` ← `request/context` 事件，**last-wins**：载荷带窗口则设置，不带则**清除**（切到未知容量路由时旧值不得残留）。
  - `maxOutputTokens` ← `request/header.config.maxTokens`（adapter 已填默认值后的实际生效上限）；缺省则清除。⚠️ `request/header` 的 no-op 快路径比较**必须纳入 `config.maxTokens`**，否则仅改输出上限的 header 被误判为 no-op。
  - `lastRequestInputTokens` ← 最近一次带 `usage` 请求的总输入（**非累计**——累计是计费口径，长会话单调超 100%，无预测意义）。
- **卡片占用条**：百分比 + 进度条 + `已用 / 窗口` + `输出上限`；≥ `CONTEXT_WARN_THRESHOLD`（0.85）预警「接近上限，建议开新会话」；任一缺省则整行不显示（不估算）。口径：`contextWindow` 是 provider 声明的**输入+输出合计**窗口，进度条 = 最近请求输入 ÷ 总窗口。
- **80% 触发线**：进度条 80% 处 1px 半透明参考线（compaction-basic 默认 `thresholdRatio=0.8` × 窗口 = 自动压缩触发点）。⚠️ 该阈值是 compaction-basic 的**私有 cordis patch 配置**（无 settings 命名空间、运行时读不到），当前宿主未覆盖 = 默认 0.8；宿主若覆盖此线为近似（tooltip 有说明）。
- **压缩历史**：折叠 `compaction/summary` 事件（真实 shadow price，零估算）→「已压缩 N 次 · 上次 HH:MM:SS · 释放 X tokens · 摘要花费 ¥Y」。摘要调用本身是一次真实 provider 请求（不产生 `assistant/message`），其 usage 计入会话费用总额与时段拆分；token 累计在 `compactions.tokens`，**不进会话 token 桶**（一次性重读会稀释缓存命中率语义）。
- **压缩预估**：增速 = 已完成轮次的快照差分（**进行中的轮次排除**——其快照随每个请求增长，纳入会在轮边界跳变）；全历史与最近 10 轮各取 trimmed mean（去最大最小各一）后**取较小者**（早期一次性装载不虚增、近期变轻不过度乐观）；headroom = 触发线 − 最近请求总输入；显示「按最近轮次净增 +X/轮，余量 Y，约 N 轮后触发压缩」（N ≈ Y/X 可心算验证）；<3 个正净增或无余量时不显示。
- **验收**：窗口/上限的设置与清除语义正确（含 no-op 快路径）；占用反映最近一次请求；预估在缓存失效场景不暴涨；压缩史正确折叠（测试覆盖）。

### FR-9 设置页展示模型能力

- `catalog` 路由对每个 provider 的每个模型**并行**调 `ctx.llm.resolveModelInfo`（`Promise.all`，单模型失败降级缺省），响应增加 `capability?: { contextWindow?: number; maxTokens?: number }`。
- `contextWindow` ← adapter 公布的窗口；`maxTokens` ← `defaultMaxTokens`，**仅部署显式配置时存在**（从内置目录继承的值不出现），UI 标注「（配置）」。
- 设置页模型行标题区显示小字（`上下文 200K · 输出上限 8K（配置）`），缺省字段不显示、都没有则不显示该行；**只读**（能力是 adapter/部署属性，不是价格配置）；不做 host 缓存。
- **验收**：能力行显隐规则正确；单模型解析失败不影响其他模型。

---

## 5. 非功能需求

| 类别 | 要求 |
|---|---|
| 兼容性 | 不改主仓库；以第三方 bundle 安装到任意 dsh profile |
| 性能 | 会话折叠为纯函数、投影单元增量驱动；刷新按需折叠单会话日志 |
| 可靠性 | 重放/历史会话计价与实时一致；空日志/未知模型不崩溃 |
| 国际化 | 文案 zh/en 双语言；括号内小字提示可本地化 |
| 可维护性 | 命名/顺序统一在 `locales.ts` 维护；共享组件（BillingLabel）避免重复 |
| 安全 | `/billing/api` 路由 loopback 信任围栏（DNS-rebinding 防御）+ CSRF 检查（拒 `sec-fetch-site: cross-site`，要求 JSON content-type） |
| 隐私 | 价格配置存本地设置文档，不上传 |

---

## 6. 数据模型

唯一事实源是 `src/shared.ts`（两侧共享的纯 JSON wire 类型，注释里有各字段口径的完整说明）。速览：

```ts
// ── 价格配置（设置页编辑、settings 命名空间存储；价格均为 PRICE_PRECISION 整数，单位 /M tokens）
interface PriceTable {
  providers: Record<string, { currency: 'CNY' | 'USD'; currencySymbol: string }>
  models: ModelPrice[]
}
interface ModelPrice {
  provider: string
  model: string
  reasoningEffort?: string
  input: number; output: number; cacheInput: number; cacheWrite?: number  // 空闲（默认）四价，兼兜底
  periods?: PeakPeriod[]   // 多个高峰窗口
  tiers?: PriceTier[]      // 分段列表；tiers[0] 为默认段（区间可空 = 全部），与顶层默认价一致
}
interface PeakPeriod {
  startHour: number; endHour: number   // 本地小时 0–23 / 1–24，end < start = 跨天窗口
  days?: number[]                      // 星期掩码；空/缺省 = 每天
  input: number; output: number; cacheInput: number; cacheWrite?: number
  tiers?: PriceTier[]                  // 各段高峰价，按索引对齐模型基础分段（区间以模型为准）
}
interface PriceTier {
  inputMin?: number; inputMax?: number    // 总输入区间（原始 token 数；min 含、max 不含；缺省 = 0 / 不限）
  outputMin?: number; outputMax?: number  // 输出区间（同上）
  input: number; output: number; cacheInput: number; cacheWrite?: number
}

// ── 会话统计（billing 投影单元输出 → useProjection('billing')）
interface SessionBillingStats {
  uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number
  outputTokens: number
  cacheHitRate: number                 // cacheRead / (uncached + cacheRead)，0..1
  requestCount: number                 // 有价格行的请求数
  unpricedRequestCount: number         // 未登记价格的请求数
  hasPeakConfig: boolean               // 驱动卡片空闲/高峰分栏
  currentModel: { provider: string; model: string; reasoningEffort?: string } | undefined
  peakModels: string[]                 // 配置了高峰窗口的已用模型（"provider/model[/effort]"，effort 行带第三段，驱动高峰标签）
  cost: Record<string, number>                       // 每币种总费用
  byPeriod: Record<string, { offPeak: number; peak: number }>  // 每币种空闲/高峰拆分
  turns: TurnCost[]                    // 逐请求明细，按轮次有界保留最近 50 轮；全量走 turns 路由
  lastRequestInputTokens?: number      // 最近一次请求总输入（占用分子，非累计）
  contextWindow?: number               // 最近 request/context 窗口（占用分母；切未知容量路由时清除）
  maxOutputTokens?: number             // 最近 request/header config.maxTokens（实际生效输出上限）
  compactions: {                           // 压缩历史
    count: number; lastTime?: number; lastShadowedTokens?: number
    tokens: number                         // 摘要调用的真实 token 合计（不进会话 token 桶）
    cost: Record<string, number>           // 摘要调用费用（PRICE_PRECISION，按币种；已计入 cost 总额）
  }
}

// ── 逐请求消耗（一条带 usage 的 assistant/message，纯折叠）
interface TurnCost {
  turn: number; step: number; time: number
  inputTokens: number                  // 该请求总输入 = 未命中 + 命中 + 写入
  cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number
  cacheHitRate: number; cost: number; currency: string; period: 'peak' | 'off-peak'
  priced: boolean                      // 该请求模型是否登记价格（false 时 cost=0，明细标「未登记」）
}

// ── 轮次聚合（UI 默认视图；同轮 step 合并，命中率按合并桶重算，多币种不混并）
interface TurnSummary extends TurnCost { requests: number }
```

关键口径（详见 `shared.ts` 注释）：

- **快照差分**：每轮新增 = 该轮最后一个请求总输入 − 上一轮最后一个请求总输入，免疫缓存失效（`turnSnapshots`/`turnGrowths`）；第 1 轮的新增 = 其整轮快照（`turnGrowthByTurn`）。
- **压缩预估**：`estimateCompactionGrowth`（已完成轮、双窗口 trimmed mean 取小）+ `estimateCompactionEta`（headroom ÷ 增速）。
- **token 四桶互斥相加**：未命中输入/命中/写入/输出相加 = 总用量（与主仓库 token-meter `usageTokens` 同口径）。
- **常量**：`PRICE_PRECISION=100000`、`RECENT_TURNS_CAP=50`、`CONTEXT_WARN_THRESHOLD=0.85`、`COMPACT_TRIGGER_RATIO=0.8`。

**数据模型变更的联动点**（改一处必须同步其余）：

1. `src/shared.ts`——wire 类型 + 常量
2. `src/host/session-stats.ts`——折叠逻辑
3. `src/host/index.ts`——settings schemastery schema、投影 zod schema、`stateVersion`、路由
4. `src/client/billing-api.ts`——客户端类型 re-export + fetch 方法
5. `src/client/types.ts`——`SessionProjectionMap['billing']`（通常随 shared 自动更新）
6. `tests/pure-check.ts`——断言

---

## 7. 术语与命名（唯一事实源）

命名与顺序统一在 `src/client/locales.ts` 维护，顶部卡片与设置页共用：

| 规范名（中文） | 含义 | 对应字段 |
|---|---|---|
| 输入（缓存命中） | 缓存命中的输入 token | `cacheReadTokens` |
| 输入（缓存未命中） | 未命中缓存的输入 token | `uncachedInputTokens` |
| 缓存写入 | 写入缓存的 token（独立计价） | `cacheWriteTokens` |
| 输出 | 输出 token | `outputTokens` |
| 缓存命中率 | 命中输入 / 总输入 | `cacheHitRate` |
| 空闲时段 / 高峰时段 | 按请求时刻归属的计费时段 | `byPeriod.offPeak / peak` |
| 分段计费 | 按请求的总输入/输出长度取档计价 | `ModelPrice.tiers` / `PeakPeriod.tiers`（按索引对齐） |
| 未登记价格 | 模型未配置价格 | `unpricedRequestCount > 0` |

> 新增/改名必须在 `locales.ts` 同时更新两处使用（卡片 + 设置页），保持单一事实源。

---

## 8. 架构与关键技术

| 层 | 方案 |
|---|---|
| Host 计费 | `ctx.sessionProjections` 的 `billing` 投影单元，纯函数折叠会话日志 |
| Host 价格配置 | `ctx.settings` 命名空间 `billing-pricing`（内置表为 base） |
| Host API | fenced `/billing/api` 路由：`settings.get/update`、`catalog`（读 `ctx.llm`，含模型能力）、`refresh`、`turns`（全量逐轮明细） |
| Client 展示 | `conversation.session.header.actions`（入口）+ 自建 hover/click popover + `useProjection('billing')` |
| Client 设置 | `settings.section`（计费页）+ `/billing/api` fetch |
| 构建 | tsc（lib/types）+ tsdown 双 bundle（lib/index.js host、lib/client.js 浏览器） |

关键约束（重要）：
- **settings RPC 有写死白名单**：第三方命名空间不暴露，因此自建 `/billing/api` 路由读写（仿 `dsh-better-sidebar`）。
- **client bundle 纯平台模块**：只能 import 平台表内包，类型用 `import type` 擦除。
- **host 无热重载**：host 改动需重启；client 改动 `pnpm dev:watch` 热更新。

### 缓存写入的 TTL 存储设计（待日志透传后启用）

现状：插件**只用每次请求真实上报的 `cacheWriteTokens` × 缓存写入单价**，绝不估算时长费。但 Anthropic 会把缓存写入按 TTL 拆分（`cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`，[官方](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)），pi-ai 的 `Usage` 已声明 `cacheWrite1h?` 但 harness 的 `TokenUsage` 与 pi-ai `mapUsage` 目前只透传总 `cacheWrite`。

当该拆分流入 `cacheWriteTokens` 的持久化 usage 后：
- 把 `ModelPrice.cacheWrite` / `PeakPeriod.cacheWrite` / `PriceTier.cacheWrite` 从单一数字扩展为 `Record<'5m'|'1h', number>`（或 `cacheWrite1h?` 双字段），折叠按 TTL 分别计价；
- 投影 schema 与 `stateVersion` 同步递增；
- 设置页缓存写入输入按 TTL 分行编辑（缺省 5m 档，1h 档可选）。

在此之前保持单一 `cacheWrite` 数字——没有逐 TTL 的用量，多档价格无法匹配，属于「没有可匹配的输入，就没有这个选项」。

---

## 9. 验收与测试

- 纯逻辑测试：`tests/pure-check.ts`（`node tests/pure-check.ts` 直接跑，node ≥22.18 原生 type-stripping），覆盖计价、高峰/空闲、跨天窗口、分段取档（含边界）、高峰窗口自身分段、缓存写入独立计价、多币种、未登记、空 days=每天、精度。
- 构建：`pnpm typecheck && pnpm build`。
- 安装冒烟：`npx @deepseek-ai/dsh plugin --profile web add ./dsh-meter` 后 `npx @deepseek-ai/dsh web` 启动，验证入口/卡片/设置页/刷新/保存。
- 回归重点：命名顺序、多币种、高峰多时段、分段多档、未登记显示、热更新。

---

## 10. 迭代记录与后续候选

逐版本变更记录已拆分为独立文档：**[CHANGELOG.md](CHANGELOG.md)**（最新在前，v0.1 → v0.3.15）。
v0.3 迭代的原始设计与评审记录已归档至 [archive/PRD-v0.3-逐轮消耗与上下文占用.md](archive/PRD-v0.3-逐轮消耗与上下文占用.md)。

### 后续候选（未排期）

- [ ] 跨会话/全局费用聚合报表
- [ ] 预算/告警/用量上限
- [ ] 费用趋势图（按天/按模型）
- [ ] 更多币种与汇率换算
- [ ] 模型按 reasoning effort 细分价格档
- [ ] 终端/无头模式的费用输出
- [ ] 费用导出（CSV/JSON）
- [ ] 缓存存储（按时长计费，如每百万tokens/小时）建模——需引入会话时长维度，当前无法从日志推导

---

*最近更新：文档结构调整——迭代记录拆分至 [CHANGELOG.md](CHANGELOG.md)，v0.3 迭代 PRD 归档至 archive/；代码最新版本 v0.3.16（审查修复批次二，见 [../review/review-0818.md](../review/review-0818.md)）。*
