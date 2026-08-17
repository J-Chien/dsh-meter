# dsh-meter

DeepSeek Harness 的**按会话计费插件**：在每个会话右上角展示当前会话的 token 用量与费用（含缓存命中/未命中/写入区分、缓存命中率、按请求时刻归属的高峰/空闲计价、按请求长度取档的分段计价），并提供 GUI 设置页编辑价格表。

第三方 bundle：装进任意 dsh profile 即可，**不改主仓库任何代码**。复用 `dsh-better-sidebar` 的成熟第三方模式（自建 fenced `/billing/api` 路由 + session-projection 单元 + 纯平台模块的 client bundle）。

## 效果展示

会话头部费用徽标（含高峰/空闲标签）：

| ![会话头部-高峰标签](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/01-header-peak-label.png) | ![会话头部-空闲标签与多币种并列计费](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/02-header-idle-multicurrency.png) |
|---|---|

hover/点击展开的统计卡片（token 用量、费用、逐轮消耗）：

| ![统计卡片-多轮价格展示](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/03-card-hover.png) | ![逐轮消耗详情面板](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/04-detail-turns.png) |
|---|---|

设置页（GUI 编辑价格表）：

| ![设置页-分段区间计费](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/05-settings-tiered.png) | ![设置页-高峰时段定价](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/06-settings-peak.png) |
|---|---|

## 功能特性

### 会话头部入口（常驻）
- 每个会话右上角有一个**常驻**费用徽标（新会话显示 `¥0.00`）
- **未登记价格**：会话用到的模型没有配置价格时，徽标显示「未登记价格」标签（琥珀色圆角标签）而不是 `¥0.00`
- **高峰/空闲标识**：会话用到配置了高峰窗口的模型时，徽标旁显示圆角状态标签——**当前处于高峰**显示红色「高峰」，**空闲**显示灰色「空闲」（弱饱和配色，每分钟自动更新）；未配置高峰时段则不显示任何标签
- **hover 或点击**都能打开统计卡片（hover 200ms 展开、离开 300ms 关闭；点击固定展开，点击外部/Esc 关闭——打开/关闭延迟与图表 tooltip 同源，见「统一交互规范」）
- **多币种徽标**：会话用到多种币种时按币种并列展示（`¥1.20 + $0.35`），不混算
- 展开箭头随卡片开关旋转

### 统计卡片
- **当前模型**：标题下方一行显示当前会话的 `provider / model`（含 reasoning effort，等宽字体小字条）
- **token 用量**（统一命名与顺序）：
  1. 输入（缓存命中）
  2. 输入（缓存未命中）
  3. 缓存写入——仅当会话存在缓存写入 token 时显示
  4. 输出
  5. 缓存命中率（%）
- **费用**：按**币种**分行展示（一个会话可能用到多个 provider、多种币种）
- **空闲/高峰分栏**：当会话用到的模型配置了高峰时段时，额外按币种展示「空闲时段」与「高峰时段」两行
- **上下文占用条（压缩预测）**：模型上下文窗口（来自日志 `request/context`）与最近一次请求总输入已知时，显示占用比例（进度条 + 百分比 + `已用 / 窗口` + `输出上限`，≥85% 预警「接近上限，建议开新会话」）；任一缺省则不显示（不估算）。⚠️ 口径：`request/context.contextWindow` 是 provider 声明的**输入+输出合计**窗口（harness 定义），故进度条 = 最近一次请求输入 ÷ 输入+输出总窗口。
  - **80% 触发线**：进度条 80% 处一条 1px 半透明参考线（compaction-basic 默认 `thresholdRatio=0.8` × 窗口 = 自动压缩触发点）。⚠️ 该阈值是 compaction-basic 的**私有 cordis patch 配置**（无 settings 命名空间、第三方插件运行时读不到），当前宿主未覆盖 = 默认 0.8；宿主若覆盖，此线为近似（tooltip 有说明）。
  - **压缩历史**：折叠日志 `compaction/summary` 事件（真实 shadow price），显示「已压缩 N 次 · 上次 HH:MM:SS · 释放 X tokens」。
  - **压缩预估**：每轮上下文水平取**该轮最后一个请求**的输入（工具调用轮内每个 step 重发全上下文，求和会多倍虚增），对相邻轮次水平做差分（≤0 丢弃），最近 10 轮正差分取 **trimmed mean**（去掉最大最小各一个后平均）作为稳定增速外推，显示「按最近轮次净增 +X/轮，约 N 轮后触发压缩」——单轮偏轻/偏重不影响预估（粗估：harness 计量的是全表面启发式估算，插件只能看到真实 usage；分母是输入+输出窗口），<3 个正差分或无余量时不显示。
- **最近消耗迷你图**：最近若干**轮**每轮一根费用竖条（**最老轮在左、时间递增**；一个轮次内的工具调用 step 合并为一条，高峰轮次不同着色），hover 出统一 tooltip（轮次/token/费用/命中率）
- 卡片头部：标题旁**小刷新按钮**（按最新价格重算当前会话）+ **「查看详情」**（打开逐轮消耗大面板）+ 右上角**齿轮设置**（直接打开计费设置页，并**自动展开对应 provider、滚动定位到当前模型**）
- **逐轮消耗详情面板**（点「查看详情」打开）：图表**按轮次从左到右递增**（最老轮在左、最新轮在右，横轴时间递增）；**图表跟随视图切换**——「按轮次」时每轮一根柱（工具调用 step 合并），「按请求」时每个请求一根柱；**横轴为纯数字标签**（按轮次 `12`、按请求 `12.3`，完整「轮次 N」语义在 tooltip 与表格中），超宽横向滚动、标签自动抽稀（首尾必标）；**按轮次柱宽 24px，「按请求」12px 密集模式**——请求级视图提供宏观趋势（每根柱即一次请求，长会话整体形状一眼可见），精确到单请求的值看 tooltip/表格；按请求模式下**每轮首个请求（`N.1`）前加 8px 间隔分组，其横轴标签必标并加粗提亮**，轮次起点一眼可寻；费用柱状图（带**纵向刻度轴**，0 在底、最大值在顶，费用带币种单位）+ 四段 token 堆叠图（未命中/命中/写入/输出，蓝阶渐变 + 琥珀输出，附互斥口径说明）；**列表按轮次倒序**（最新轮在最上）：**「按请求」视图为可折叠轮次分组**——每轮一行聚合 + 展开箭头，点击展开该轮的请求明细（默认折叠，避免上百条请求平铺难翻找），请求保持日志顺序且序号始终带 step（`N.1`/`N.2`…，单请求轮也显示 `N.1`）；「按轮次」视图为每轮一行的聚合表（轮次/时间/未命中/命中/写入/输出/命中率/费用/时段，表头无括号）；时段相关展示（时段列、高峰/空闲图例）仅在会话配置了高峰时段时出现；打开时拉取**全量**逐轮明细（投影帧按轮次有界保留最近 50 轮）

### 设置页（GUI 编辑价格）
- **按已注册的 provider 分组**：从 `ctx.llm` 实时读取 provider 与其模型目录，分组折叠展开（**默认全部折叠**，箭头按钮位于标题右侧），**无需手动添加模型**
- **每个模型能力展示**：模型名旁显示真实**上下文窗口 / 最大输出**能力（来自 `ctx.llm.resolveModelInfo` 目录数据，非估算；解析失败则不显示；输出上限仅部署显式配置时存在，标注「（配置）」）
- **每个 provider 独立币种**（CNY/USD），单位说明随币种显示（`单位：¥/百万Tokens`）
- 每个模型编辑四类价格：输入（缓存命中）/ 输入（缓存未命中）/ 缓存写入 / 输出
- **分段计费（开关）**：每个模型行标题右侧有**分段计费开关**；开启后**默认价格成为第一段**（可编辑区间），在其下方直接「添加分段」——新增分段与默认价格是**连续的一整套档**，每段都是「区间 + 同一套四价字段」（输入命中/未命中、缓存写入、输出），字段命名与默认价格完全一致，不换行；区间行首按序编号**「区间 1」「区间 2」…**（默认段 = 区间 1，后续新增依次递增，方便对照每次请求落在哪一段），每段内部**「输入区间」「输出区间」分两行堆叠**（各自带 K tokens 单位，长边界不换行不溢出）；长度以 K tokens 输入（`32` = 32K，下限默认 `0`、上限留空 = 不限 `∞`）；新增分段自动用默认价预填；无区间匹配时落到默认段（全部/兜底）
- **高峰时段**：每个模型可配置**多个**高峰窗口（起止小时 + 各自价格），起止时间以时钟样式显示（`9:00`、`22:00`，结束可为 `24:00`）；每个高峰窗口内结构为**时段 → 分段计费**——顶部是窗口的起止时间，其下「分段计费」块包含从**区间 1**（该窗口的默认/平价）开始的全部区间；每段的区间以模型分段为准**只读**，用**区间记号**展示——`输入长度 [0, 32)`、`输出长度 [0, 0.2)`、`[0.2+)`（下限缺省 = 0、上限缺省 = `+`，无约束的维度不显示、全无约束的默认段显示「全部」），价格单独编辑；不配高峰时段则始终按空闲价计
- 价格输入显示**"元/M" 小数**：自动补零到两位小数（`10` → `10.00`），超过两位小数按实际值显示（`10.155` 不变）；内部高精度整数存储；输入框用 draft 字符串，清空再输入体验顺滑
- 保存后 host 自动重算所有会话

### 计价核心
- **按请求时刻归属时段**：每个请求用其 `assistant/message` 事件的持久化 `time`（epoch ms）查该模型当天的空闲/高峰价格——精确到每个请求，重放/历史会话也准确
- **按请求长度取档**：每个请求用其**总输入长度**（未命中 + 命中 + 写入）与输出长度命中匹配的**价格分段**，整单按该档单价计；**无区间约束的段（默认/全部）作为兜底**，具体区间段优先（z.ai GLM 分段即此语义）
- **高峰时段价格独立、区间复用**：活跃高峰窗口存在时，用**该窗口各段的高峰价格**（按索引对齐模型的空闲分段区间），无匹配则用该窗口的平价；否则用模型的空闲分段/平价格
- **缓存未命中/命中/写入分开计价**：未缓存输入、命中缓存输入、缓存写入、输出各自按对应单价计；`cacheWrite` 未配置（或缺省）时按 0 计
- **缓存写入用真实 token 数**：`cacheWriteTokens` 来自每次请求的持久化 usage，无任何估算；按「缓存存储时长」计费（如 Anthropic 1h TTL、按 token·小时）的模型因日志不含时长维度，不建模
- **未登记模型**：没有价格行的请求单独计数，不影响已登记请求的费用

## 技术架构

| 半区 | 机制 |
|---|---|
| Host | `ctx.settings` 命名空间 `billing-pricing`（内置默认表为 `base` 层）· `ctx.sessionProjections` 的 `billing` 单元（纯函数折叠会话日志）· fenced `/billing/api` HTTP 路由（`settings.get` / `settings.update` / `catalog` / `refresh` / `turns`）· 通过 `ctx.llm` 读取 provider/模型目录 |
| Client | `conversation.session.header.actions` 槽位（常驻入口）· `settings.section` 槽位（设置页）· `useProjection('billing')` 读 host 计算结果 · 自建 hover+click popover · `/billing/api` fetch 客户端 |

数据流：**会话日志 → host 纯函数折叠 → `billing` 投影单元 → `session/projection` 推送帧 → 客户端 `useProjection` → 卡片渲染**。价格表变更时投影单元重新注册，所有会话按最新价格重算。

### 价格精度
价格以整数 `PRICE_PRECISION`（1/100000 币种单位）存储，避免浮点漂移——`¥10.1550/M` 这类 4 位小数也精确。卡片/统计显示保留 2 位小数；设置页输入按"元/M"小数编辑，**自动补零到两位小数，超过两位小数按实际值显示**（整数运算，无浮点误差）。

### 内置默认价格
内置 wpsai 与 zai provider 的官方参考价格表（输入/输出/缓存输入/缓存写入，按每百万 token）。zai（BigModel GLM）按官方分段计费写入（GLM-5.1、GLM-5-Turbo、GLM-4.5-Air 两/三档；GLM-4.7 三档含输出长度分段）；缓存写入列当前为「限时免费」（0）。用户可在设置页覆盖/增删；未配置价格的模型显示「未登记价格」并按 0 计价。

## 目录结构

```
dsh-meter/
├── package.json            # dsh bundle + dsh.client 清单，npm scripts
├── cordis.patch.yml        # bundle 的 patch：插入 billing 插件行
├── pnpm-workspace.yaml     # 独立 workspace（自含 node_modules 解析）
├── tsconfig.json           # typecheck（解析已安装 dsh 包类型 + react 类型）
├── tsconfig.build.json     # tsc 产出 lib/types（JS + d.ts）
├── tsdown.config.ts        # 双 bundle：lib/index.js(host) + lib/client.js(浏览器)
├── README.md               # 本文档
├── docs/
│   ├── prd/                # 产品需求文档（主 PRD + 各迭代 PRD）
│   └── review/             # 代码审查记录
├── src/
│   ├── shared.ts           # 两侧共享的 wire 类型（纯 JSON，无 dsh 依赖）
│   ├── index.ts            # node 半区入口：re-export host 插件与纯逻辑
│   ├── invariant.ts        # 空态断言等 invariant companion
│   ├── host/               # ── Host 半区（价格计算 + 路由）──
│   │   ├── index.ts        # 插件主体：settings ns + 投影单元 + /billing/api 路由
│   │   ├── price.ts        # 价格模型：精度、高峰窗口、按请求计价、未登记检测
│   │   ├── default-prices.ts # 内置默认价格表（wpsai 官方参考价）
│   │   ├── session-stats.ts  # 纯会话折叠 → 每币种费用/未登记计数/hasPeakConfig
│   │   ├── wire.ts         # /billing/api 的 JSON 读写辅助
│   │   ├── fence.ts        # 路由 loopback 信任围栏（DNS-rebinding 防御）
│   │   └── context-types.ts # host Context 结构型声明（settings/webServer/sessions/llm）
│   └── client/             # ── Client 半区（UI）──
│       ├── index.ts        # client 插件：注册头部入口 + 设置页
│       ├── BillingAction.tsx   # 入口徽标 + hover/click popover + 统计卡片
│       ├── BillingAction.module.css
│       ├── BillingSettings.tsx # 设置页：provider 分组 + 币种 + 多高峰时段
│       ├── BillingSettings.module.css
│       ├── BillingLabel.tsx    # 共享字段标签（主词 + 小字括号 hint）
│       ├── BillingLabel.module.css
│       ├── interaction.ts       # 交互延迟常量（卡片/tooltip 单一事实源）
│       ├── Tooltip.tsx          # 统一 tooltip（替代原生 title）
│       ├── Tooltip.module.css
│       ├── theme.module.css     # --billing-* 设计 token 层（跨主题单一事实源）
│       ├── billing-api.ts      # /billing/api 的 fetch 客户端 + 目录类型
│       ├── format.ts           # 价格/单位/显示格式化 + 输入解析
│       ├── locales.ts          # zh/en 文案（命名顺序统一在此维护）
│       ├── types.ts            # SessionProjectionMap 的 'billing' key 声明合并
│       ├── context-types.ts    # client Context 结构型声明（slots/locale）
│       └── invariant.ts        # client invariant companion
└── tests/
    └── pure-check.ts       # 纯逻辑断言（node 直接跑）：计价/时段/多币种/未登记
```

## 开发

### 环境准备
本项目是独立 pnpm workspace。首次需安装依赖（会解析已发布的 `@deepseek-ai/*` 包）：

```sh
pnpm install
```

> 本项目是独立 workspace，**不依赖主仓库 checkout**，可在任意目录（含 Windows / Linux / macOS）直接开发。react/react-dom 等类型经 `node_modules` 正常解析，无需手动路径映射。

### 常用命令

```sh
pnpm typecheck          # tsc --noEmit（src + tests 两个配置）
pnpm test               # node tests/pure-check.ts（node ≥22.18 原生跑 TS，无需 tsx）
pnpm build              # 一次性构建：tsc(lib/types) + tsdown(lib/index.js + lib/client.js)
pnpm dev:watch          # tsdown --watch：client 改动自动重建 → GUI 热更新
```

### 热更新开发循环
`dsh` GUI 内置 client-hmr，会 stat-poll 每个 client bundle，内容变化即通过 SSE 热重载浏览器插件。

- **client 改动**（`src/client/*`：UI/CSS/交互/文案）→ 跑 `pnpm dev:watch` 后**自动热更新，无需重启**，改完直接看效果
- **host 改动**（`src/host/*`：价格计算/schema/路由）→ host 进程无热重载，**需重启 `dsh web` 一次**
- 若一段时间没有热更新，通常是 dev:watch 停了，重新跑一下即可

### 安装到 profile

```sh
# 从 npm registry 安装（推荐）
npx @deepseek-ai/dsh plugin --profile web add dsh-meter
# 首次安装或 host 改动后重启 GUI
npx @deepseek-ai/dsh web
```

### 迁移到另一台电脑（无需主仓库）

插件是**独立包**，目标机器只需要装好 pnpm 与 dsh，**不需要拉 deepseek-harness 仓库**。三种方式任选：

#### 方式 A：拷贝源码目录（推荐，便于以后改动）

把 `dsh-meter/` 整个目录拷过去（**不要带 `node_modules/`**，到目标机器重新安装），然后：

```sh
# 在包含 dsh-meter 的上层目录执行；目录名随意，如 ~/dsh-meter
npx @deepseek-ai/dsh plugin --profile web add ./dsh-meter
npx @deepseek-ai/dsh web
```

`npx @deepseek-ai/dsh plugin add` 会自动初始化 profile、`pnpm install`（`prepare` 脚本自动构建 `lib/`）、并把 `dsh-meter` 追加进 `dsh.profile.bundles`。

#### 方式 B：打包 tarball（对方只装、不改源码）

在本机已构建好的目录里：

```sh
pnpm pack          # 产出 dsh-meter-0.2.6.tgz（含 lib/ + src/ + 全部构建配置）
```

把 `.tgz` 给目标机器，在任意目录执行：

```sh
npx @deepseek-ai/dsh plugin --profile web add ./dsh-meter-0.2.6.tgz
npx @deepseek-ai/dsh web
```

#### 方式 C：直接拷已安装的 node_modules（最简，跳过 install/build）

把 `~/.dsh/profiles/web/node_modules/dsh-meter/` 整个拷到目标机器同目录，并在目标机器 `~/.dsh/profiles/web/package.json` 的 `dependencies` 里补一行 `"dsh-meter": "link:<实际路径>"`，然后重启 `dsh web`。

#### 跨平台注意事项

- **路径都是 `~/`**：插件运行数据（`~/.dsh/sessions`、`~/.dsh/settings.yaml` 的 `billing-pricing`、`~/.dsh/storages`）由 dsh 按用户主目录解析，跨机器自动适配。唯一含**绝对路径**的是 profile 的 `package.json`/`pnpm-lock.yaml` 里安装时写入的 `link:` 或 `file:` 路径——**迁移后务必用方式 A/B 重新安装一次**，让 pnpm 重写成本机路径。
- **Windows**：目标机器用 `%USERPROFILE%\.dsh\...`，安装命令相同（`npx @deepseek-ai/dsh plugin --profile web add ./dsh-meter` 或 `.tgz` 路径）；`build` 脚本已是跨平台写法（`node -e fs.rmSync`，不依赖 `rm`）。
- **`@deepseek-ai/*` 依赖从 npm registry 解析**（版本均为已发布的 `0.1.0-rc.6` / `schemastery ^3.18.1`），目标机器联网即可 `pnpm install`，无需任何内网/私有源。
- 构建产物的 sourcemap 与注释不含本机绝对路径（仅 `lib/client.js` 内 `//#region` 折叠注释带源码路径，不影响运行）。

#### 迁移后验证

1. `npx @deepseek-ai/dsh plugin --profile web add ...` 输出里能看到 `dsh-meter` 被加入 `dsh.profile.bundles`（查看 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组）。
2. 目标 `node_modules/dsh-meter/lib/` 存在 `index.js` + `client.js`。
3. 重启后会话右上角出现费用徽标；设置页出现「计费」分组；价格表能编辑保存。

## 第三方插件要点（给后续开发）

- **不动主仓库**：所有能力都走现有扩展点（`ctx.settings`、`ctx.sessionProjections`、`conversation.session.header.actions`、`settings.section`、`ctx.webServer` 自建路由、`ctx.llm` 目录）。
- **设置页写价格不走 settings RPC**：内置 settings RPC 有写死的暴露白名单，第三方命名空间不会暴露；因此仿 `dsh-better-sidebar` 自建 fenced `/billing/api` 路由读写。
- **client bundle 必须是纯平台模块**：只能 import 平台表内的包（react / react-dom / jsx-runtime / `@deepseek-ai/dsh-client-ui-primitives` 等），否则 client bundle purity gate 报错。类型可用 `import type {}`（构建时擦除）。
- **Context 用结构型声明**：第三方包不在主仓库单例 cordis 内，收不到 `declare module` 增强；`context-types.ts` 里按需声明用到的服务面。
- **价格数据模型变更**要同步六处（改一处要联动）：
  1. `src/shared.ts`——wire 类型 + 常量（`TurnCost`/`ModelCapability`、`RECENT_TURNS_CAP`/阈值、`SessionBillingStats` 新字段）
  2. `src/host/session-stats.ts`——折叠（`assistant/message` 追加 `TurnCost`、`request/context` 设置/清除 `contextWindow`、`request/header` 设置/清除 `maxOutputTokens`）
  3. `src/host/index.ts`——投影 zod schema + `stateVersion` + 路由（`catalog` 能力、`turns` 按需路由）
  4. `src/client/billing-api.ts`——客户端类型 re-export + `getTurns(sessionId)`
  5. `src/client/types.ts`——`SessionProjectionMap['billing']`（通常随 shared 类型自动更新，无需手改）
  6. `tests/pure-check.ts`——断言

## 统一交互与设计规范

所有交互节奏与视觉 token 都是**单一事实源**，改一处全插件生效：

| 类别 | 位置 | 说明 |
|---|---|---|
| 交互延迟 | `src/client/interaction.ts` | `HOVER_OPEN_MS=200`（悬停打开卡片）、`HOVER_CLOSE_MS=300`（离开后关闭卡片）、`CLICK_DELAY_MS=100`（点击取消悬停打开）、`TOOLTIP_DELAY_MS=400`（图表/按钮 tooltip）。卡片与 tooltip 共用同一套打开/关闭节奏 |
| Tooltip | `src/client/Tooltip.tsx` | 全插件唯一的 tooltip 实现（portaled、跟随锚点、Esc 关闭、z-index 300 压过卡片 100 与面板 mask 200）。禁止原生 `title`：显示延迟不可控、触屏/读屏不可达 |
| 设计 token | `src/client/theme.module.css` | 全部 `--billing-*` 变量（文本/表面/边框/图表色/圆角/动效曲线）在此解析到 dsw token；组件 CSS 一律不得直接引用 `--dsw-*`。⚠️ dsw 主题变量定义在 `body`/`body[data-ds-dark-theme]` 上，引用它们的 `--billing-*` 也**必须声明在 `body`**（`:root` 不是 body 后代，挂 `:root` 会全部落到亮色 fallback、暗色模式失效）；z-index/圆角/动效等与主题无关的常量才放 `:root` |
| 动效 | `theme.module.css` 的 `--billing-motion-*` | 统一曲线 + 三档时长（fast 120ms 悬停反馈 / medium 160ms 表面进出 / slow 240ms 数据宽度） |

组件 CSS（`BillingAction`/`BillingTurnsPanel`/`BillingSettings`/`BillingLabel`/`Tooltip`）只消费 `--billing-*`，`--dsw-*` 仅出现在 `theme.module.css` 内部；跨主题适配只需改 `theme.module.css`。

## 数据模型速览

```ts
// 价格配置（设置页编辑、settings 命名空间存储）
interface PriceTable {
  providers: Record<string, { currency: 'CNY' | 'USD'; currencySymbol: string }> // 每 provider 币种
  models: ModelPrice[]
}
interface ModelPrice {
  provider: string
  model: string
  reasoningEffort?: string
  input: number; output: number; cacheInput: number; cacheWrite?: number  // 默认（第一段）价（PRICE_PRECISION 整数）
  periods?: PeakPeriod[]                               // 多个高峰窗口
  tiers?: PriceTier[]                                  // 分段列表；tiers[0] 为默认段（区间可空=全部），与顶层默认价一致
}
interface PeakPeriod {
  startHour: number; endHour: number
  days?: number[]              // 空/缺省 = 每天
  input: number; output: number; cacheInput: number; cacheWrite?: number
  tiers?: PriceTier[]          // 各段的高峰价格（按索引对齐模型分段区间；区间边界以模型为准；index 0 为默认段）
}
interface PriceTier {
  inputMin?: number; inputMax?: number   // 总输入长度区间（原始 token 数；min 含、max 不含；缺省 = 0 / 不限）
  outputMin?: number; outputMax?: number // 输出长度区间（同上）
  input: number; output: number; cacheInput: number; cacheWrite?: number
}

// 会话统计（投影单元输出 → useProjection('billing')）
interface SessionBillingStats {
  uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number
  outputTokens: number
  cacheHitRate: number
  requestCount: number        // 有价格行的请求数
  unpricedRequestCount: number // 未登记价格的请求数
  hasPeakConfig: boolean       // 是否配置了高峰时段（驱动卡片分栏）
  peakModels: string[]         // 配置了高峰窗口的已用模型（"provider/model"，驱动红色高峰标签）
  currentModel: { provider: string; model: string; reasoningEffort?: string } | undefined // 最近一次请求的模型（卡片模型行 + 设置页定位）
  cost: Record<string, number>           // 每币种总费用
  byPeriod: Record<string, { offPeak: number; peak: number }> // 每币种 空闲/高峰 拆分
  turns: TurnCost[]                      // 逐请求明细（最近 ≤50 条；全量走 turns 路由；UI 默认按轮次聚合）
  lastRequestInputTokens?: number        // 最近一次请求总输入（占用分子，非累计）
  contextWindow?: number                 // 最近 request/context 窗口（占用分母；切未知容量路由时清除）
  maxOutputTokens?: number               // 最近 request/header config.maxTokens（实际生效输出上限）
}

// 逐请求消耗（每次计费请求一条，纯折叠自 assistant/message）
interface TurnCost {
  turn: number; step: number; time: number
  inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number
  cacheHitRate: number; cost: number; currency: string; period: 'peak' | 'off-peak'
  priced: boolean                        // 该请求模型是否登记了价格（false 时 cost=0，明细表标「未登记」）
}
```

## 已知限制 / 后续

- host 改动无热重载，需重启（框架限制）。
- 高峰时段按**运行机器本地时区**判定：host 折叠用宿主机时区、client 标签用浏览器时区；两者不同时，费用归属与高峰标签可能不一致。
- `/billing/api` 的 fence 只认 loopback Host：`dsh web` 绑定 0.0.0.0 供局域网访问时，billing API 一律 403（DNS-rebinding 防御的取舍）。
- 设置页编辑器只覆盖目录内模型的无 effort 价格行；目录外模型与 reasoningEffort 价格行不可编辑，但保存时会被**原样保留**（不会丢失）。
- 「未登记价格」目前只区分"全部未登记 vs 部分登记"；卡片徽标在部分登记时显示已登记部分费用，未显示部分未登记的提示。
- 价格精度固定 1/100000 币种单位，如需更高精度需调整 `PRICE_PRECISION` 并同步 schema/投影。
- 设置页按 `ctx.llm.listProviders()` 目录分组；若某 provider 未列目录，其模型不出现在编辑器（已配置的价格仍参与计价）。
- **缓存写入按 token 计、不估算时长费**：插件只用每次请求真实上报的 `cacheWriteTokens` × 缓存写入单价；「缓存存储（每百万tokens/小时）」这类按时长收费的模型因日志不含时长维度不建模（z.ai 当前缓存存储为限时免费 0）。
- **TTL 分档暂不支持**：持久化 usage 目前只有总 `cacheWriteTokens`（pi-ai 尚未透传 Anthropic `cache_creation.ephemeral_5m/1h_input_tokens` 的 TTL 拆分），因此 `cacheWrite` 是单一单价而非按 TTL 的多档价。待日志透传该拆分后，把 `PriceTier.cacheWrite`/`PeakPeriod.cacheWrite`/`ModelPrice.cacheWrite` 扩展为 `Record<'5m'|'1h', number>` 即可（见 PRD §8）。
- 分段计费按「整单取档」语义（命中哪档整单按该档单价），非阶梯累进——与 z.ai/OpenAI 官方规则一致。
- 高峰时段存在时，其**各段高峰价格**按索引对齐模型空闲分段区间；若某高峰时段没有分段价格（旧数据），则回退到该时段的平价。
- **上下文能力依赖目录解析**：`ctx.llm.resolveModelInfo` 只对已注册 provider 的已知模型返回 contextWindow；解析失败/未知模型时设置页不显示能力行（不估算）。
- **上下文占用反映最近一次已完成请求**：占用条分子 = 最近一次请求的总输入（`lastRequestInputTokens`，非累计——缓存命中每轮重复计同一批 token，累计无预测意义）。压缩/裁剪发生后、下一次请求上报 usage 之前，占用条不会立即下降（与主仓库 token-meter 的 `pressureTokens` 同口径）。
- **`maxTokens` 口径**：卡片占用行的「输出上限」来自 `request/header.config.maxTokens`（adapter 已填默认值后的实际生效上限）；设置页能力行的输出上限来自 `resolveModelInfo.defaultMaxTokens`，**仅部署显式配置时存在**（从内置目录继承的能力值不出现），UI 标注「（配置）」。
- **逐请求明细有界投影 + 全量按需路由**：投影帧按**轮次**有界（保留最近 `RECENT_TURNS_CAP`=50 轮的完整请求，一个轮次的工具调用 step 不拆散），保持帧体积有界；全量明细走 `/billing/api/turns` 按需路由（打开详情面板时拉取）。卡片迷你图只用最近 10 轮。**UI 默认按轮次聚合**（一个轮次内的工具调用 step 合并为一条，`aggregateTurns`），「按请求」视图展开每条明细。
- **迷你图跨币种条长仅供趋势**：条长按当前窗口内最大费用归一，跨币种长度不可比；hover 显示精确值。
- **token 四桶互斥相加**：一次请求的四类 token（未命中输入/命中缓存/写入缓存/输出）是 provider 上报的**互斥桶**，相加 = 该请求总用量（与主仓库 `token-meter` 的 `usageTokens` 同口径）；图表与明细表的「输入」列均指**未命中部分**，不会与命中/写入重复计数。

## License

MIT
