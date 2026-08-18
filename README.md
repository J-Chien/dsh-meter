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

设置卡片（GUI 编辑价格表；截图为 rc.6 时代的独立设置页版式，rc.7 起位于 设置 →「插件」配置页）：

| ![设置页-分段区间计费](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/05-settings-tiered.png) | ![设置页-高峰时段定价](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/06-settings-peak.png) |
|---|---|

## 功能特性

### 会话头部入口（常驻）

- 每个会话右上角有一个**常驻**费用徽标（新会话显示 `¥0.00`）。
- **未登记价格**：会话用到的模型全部没有配置价格时，徽标显示琥珀色「未登记价格」标签而不是 `¥0.00`；部分登记时只合计已登记部分。
- **高峰/空闲标识**：会话用到配置了高峰窗口的模型时，徽标旁显示圆角状态标签——当前处于高峰显示红色「高峰」，否则灰色「空闲」（每分钟自动更新）；未配置高峰时段则不显示任何标签。
- **多币种徽标**：会话用到多种币种时按币种并列展示（`¥1.20 + $0.35`），不混算。
- **hover 或点击**都能打开统计卡片（hover 200ms 展开、离开 300ms 关闭；点击固定展开，点击外部/Esc 关闭）。

### 统计卡片

- **当前模型**：标题下方显示当前会话的 `provider / model`（含 reasoning effort）。
- **token 用量**：输入（缓存命中）→ 输入（缓存未命中）→ 缓存写入（仅存在时显示）→ 输出 → 缓存命中率。
- **费用**：按币种分行；配置了高峰时段时额外展示「空闲时段」「高峰时段」两行拆分。
- **上下文占用条（压缩预测）**：最近一次请求输入 ÷ provider 声明的输入+输出总窗口（来自日志 `request/context`），显示进度条 + `已用 / 窗口` + `输出上限`；≥85% 预警「接近上限，建议开新会话」。含 80% 压缩触发参考线、压缩历史（已压缩 N 次 · 释放 X tokens · 摘要花费——压缩摘要调用是真实 provider 请求，其费用计入总额）与压缩预估（快照差分增速外推「约 N 轮后触发压缩」，余量可心算验证）。任一数据缺省则不显示（不估算）。
- **每轮新增迷你图**：每轮一根新增占用 token 竖条（快照差分口径，免疫缓存失效；最老轮在左、从左到右 3px 等距排列；**第 1 轮的新增 = 其整轮快照**——它的前驱是空上下文，首轮装载的所有内容都是新增），高峰轮暖色着色，hover 出统一 tooltip；按卡片实际宽度自适应轮数。
- 卡片头部：**刷新**（按最新价格重算当前会话）+ **查看详情**（打开逐轮消耗面板）+ **齿轮设置**（打开设置面板并排队定位请求；计费卡片挂载时自动展开并定位当前模型——rc.7 的设置面板无导航 API，「插件」页需手动点开）。

### 逐轮消耗详情面板

- 「按轮次」（工具调用 step 合并）/「按请求」两个视图，**图表与表格粒度随视图切换**；图表横轴时间递增、纯数字标签、自动抽稀；按请求为 12px 密集模式、每轮首请求分组加粗。
- 费用柱状图（带纵向刻度轴、币种单位）+ 四段 token 堆叠图（未命中/命中/写入/输出互斥相加 = 总用量）。
- 明细表按轮次倒序；「按请求」视图为可折叠轮次分组（默认折叠）；未登记请求标「未登记」。
- 打开时拉取**全量**逐轮明细（投影帧只按轮次有界保留最近 50 轮）。

### 设置卡片（GUI 编辑价格）

设置面板 →「插件」配置页 →「计费价格配置」卡片（rc.7 原生 `settings.plugin.item` 槽位，按 `billing-pricing` 命名空间注册；读写走原生 settings RPC 的 `settingsScope` 绑定，保存后 host 自动重算所有会话、各标签页自动同步）。

- **按已注册的 provider 分组**（从 `ctx.llm` 实时读取目录，默认全部折叠），**无需手动添加模型**；模型名旁显示真实上下文窗口/输出上限能力（目录数据，非估算）。
- 每个 provider 独立币种（CNY/USD）；每个模型编辑四类价格：输入（缓存命中）/ 输入（缓存未命中）/ 缓存写入 / 输出。
- **分段计费（开关）**：开启后默认价格成为「区间 1」，可继续添加分段；每段 = 输入/输出长度区间（K tokens）+ 同一套四价；无区间匹配时落到默认段兜底。
- **高峰时段**：每个模型可配多个高峰窗口（起止时钟样式 + 各自价格）；窗口内按索引复用模型的分段区间（只读展示区间记号），价格单独编辑；不配高峰则始终按空闲价计。
- 价格输入自动补零到两位小数（内部高精度整数存储，无浮点误差）；写入被宿主拒绝（校验失败/版本冲突）时在保存按钮旁提示。

### 计价核心

- **按请求时刻归属时段**：每个请求用其持久化 `time` 查该模型当天的空闲/高峰价格——重放/历史会话也准确；支持跨天窗口（22:00–06:00）与按星期几过滤（`days` 按**窗口起始日**判定：「周五 22:00–06:00」覆盖周六凌晨；起止相同 = 全天）。
- **按请求长度取档**：按请求的总输入/输出长度命中匹配分段，整单按该档单价计（与 z.ai/OpenAI 官方规则一致，非阶梯累进）。
- **缓存未命中/命中/写入分开计价**：各自按对应单价；`cacheWrite` 未配置按 0 计，且只用真实上报 token 数，不估算时长费。
- **未登记模型**：没有价格行的请求单独计数，不影响已登记请求的费用。
- **精度**：价格以整数 `PRICE_PRECISION`（1/100000 币种单位）存储，`¥10.1550/M` 这类 4 位小数也精确；统计显示 2 位小数。

详细口径、验收标准与数据模型见 [docs/prd/PRD.md](docs/prd/PRD.md)；逐版本变更记录见 [docs/prd/CHANGELOG.md](docs/prd/CHANGELOG.md)。

## 安装

```sh
# 从 npm registry 安装（推荐）
npx @deepseek-ai/dsh plugin --profile web add dsh-meter
# 首次安装或 host 改动后重启 GUI
npx @deepseek-ai/dsh web
```

> 版本要求：v0.3.18 起 peer 依赖为 `^0.1.0-rc.7`，请搭配 deepseek-harness **0.1.0-rc.7** 及以上；仍停留在 rc.6 的环境请使用 dsh-meter 0.3.16。

也可以从源码目录或 tarball 安装：

```sh
npx @deepseek-ai/dsh plugin --profile web add ./dsh-meter            # 源码目录
npx @deepseek-ai/dsh plugin --profile web add ./dsh-meter-0.3.18.tgz  # pnpm pack 产物
```

`plugin add` 会自动初始化 profile、`pnpm install`（`prepare` 脚本自动构建 `lib/`）并把 `dsh-meter` 追加进 `dsh.profile.bundles`。

### 迁移到另一台机器

插件是**独立包**，目标机器只需装好 pnpm 与 dsh，**不需要拉 deepseek-harness 仓库**：把 `dsh-meter/` 目录（不带 `node_modules/`）或 `pnpm pack` 的 `.tgz` 拷过去，按上面任一命令重新安装即可。注意：

- **迁移后务必重新安装一次**——profile 的 `package.json`/`pnpm-lock.yaml` 里写有本机 `link:`/`file:` 绝对路径，重装让 pnpm 重写为目标机路径。
- 运行数据（`~/.dsh/sessions`、`~/.dsh/settings.yaml` 的 `billing-pricing`）按用户主目录解析，跨机器/跨平台（含 Windows）自动适配。
- `@deepseek-ai/*` 依赖全部从 npm registry 解析（均为已发布的 `0.1.0-rc.7`），无需内网/私有源。

**验证**：目标 `node_modules/dsh-meter/lib/` 存在 `index.js` + `client.js`；重启后会话右上角出现费用徽标；设置面板「插件」配置页出现「计费价格配置」卡片，价格表能编辑保存。

## 开发

### 环境准备

本项目是独立 pnpm workspace，**不依赖主仓库 checkout**，可在任意目录（含 Windows / Linux / macOS）直接开发：

```sh
pnpm install
```

### 常用命令

```sh
pnpm typecheck          # tsc --noEmit（src + tests 两个配置）
pnpm test               # node tests/pure-check.ts（node ≥22.18 原生跑 TS，无需 tsx）
pnpm build              # 一次性构建：tsc(lib/types) + tsdown(lib/index.js + lib/client.js)
pnpm dev:watch          # tsdown --watch：client 改动自动重建 → GUI 热更新
```

### 热更新开发循环

`dsh` GUI 内置 client-hmr，会 stat-poll 每个 client bundle，内容变化即通过 SSE 热重载浏览器插件。

- **client 改动**（`src/client/*`）→ 跑 `pnpm dev:watch` 后**自动热更新，无需重启**。
- **host 改动**（`src/host/*`）→ host 进程无热重载，**需重启 `dsh web` 一次**。
- 若一段时间没有热更新，通常是 dev:watch 停了，重新跑一下即可。

## 技术架构

| 半区 | 机制 |
|---|---|
| Host | `ctx.settings` 命名空间 `billing-pricing`（内置默认表为 `base` 层）· `ctx.sessionProjections` 的 `billing` 单元（纯函数折叠会话日志）· fenced `/billing/api` 路由（`catalog` / `refresh` / `turns`）· 通过 `ctx.llm` 读取 provider/模型目录 |
| Client | `conversation.session.header.actions` 槽位（常驻入口）· `settings.plugin.item` 原生设置卡片（key=`billing-pricing`）· `ctx.settingsScope.bind` 读写价格表（原生 settings RPC）· `useProjection('billing')` 读 host 计算结果 · 自建 hover+click popover · `/billing/api` fetch 客户端 |

数据流：**会话日志 → host 纯函数折叠 → `billing` 投影单元 → `session/projection` 推送帧 → 客户端 `useProjection` → 卡片渲染**。价格表经原生 settings RPC 保存后，host 的 `scope.watch` 重新注册投影单元，所有会话按最新价格重算，各绑定端（含其他标签页）经 `settings/document-updated` 自动重播种。

### 内置默认价格

内置 wpsai 与 zai provider 的官方参考价格表（按每百万 token）。zai（BigModel GLM）按官方分段计费写入（GLM-5.1、GLM-5-Turbo、GLM-4.5-Air 两/三档；GLM-4.7 三档含输出长度分段）；缓存写入列当前为「限时免费」（0）。用户可在设置页覆盖/增删；未配置价格的模型显示「未登记价格」并按 0 计价。

### 目录结构

```
dsh-meter/
├── package.json            # dsh bundle + dsh.client 清单，npm scripts
├── cordis.patch.yml        # bundle 的 patch：插入 billing 插件行
├── pnpm-workspace.yaml     # 独立 workspace（自含 node_modules 解析）
├── tsconfig.json           # typecheck（解析已安装 dsh 包类型 + react 类型）
├── tsconfig.build.json     # tsc 产出 lib/types（JS + d.ts）
├── tsconfig.tests.json     # tests 的 typecheck 配置
├── tsdown.config.ts        # 双 bundle：lib/index.js(host) + lib/client.js(浏览器)
├── README.md               # 本文档
├── docs/
│   ├── prd/                # PRD.md（当前规格）+ CHANGELOG.md（迭代记录）+ archive/（归档设计稿）
│   ├── review/             # 代码审查记录
│   └── screenshots/        # 效果截图
├── src/
│   ├── shared.ts           # 两侧共享的 wire 类型与纯函数（纯 JSON，无 dsh 依赖）
│   ├── index.ts            # node 半区入口：re-export host 插件与纯逻辑
│   ├── invariant.ts        # 空态断言 invariant companion
│   ├── host/               # ── Host 半区（价格计算 + 路由）──
│   │   ├── index.ts        # 插件主体：settings ns + 投影单元 + /billing/api 路由
│   │   ├── price.ts        # 价格模型：精度、高峰窗口、按请求计价、未登记检测
│   │   ├── default-prices.ts # 内置默认价格表（wpsai / zai 官方参考价）
│   │   ├── session-stats.ts  # 纯会话折叠 → 每币种费用/未登记计数/逐轮明细/压缩历史
│   │   ├── wire.ts         # /billing/api 的 JSON 读写辅助
│   │   ├── fence.ts        # 路由 loopback 信任围栏（DNS-rebinding 防御）
│   │   └── context-types.ts # host Context 结构型声明（settings/webServer/sessions/llm）
│   └── client/             # ── Client 半区（UI）──
│       ├── index.ts        # client 插件：attach settingsScope + 注册头部入口 + 原生设置卡片
│       ├── pricing-scope.ts # billing-pricing 命名空间的 settingsScope 共享绑定（徽标/卡片共用）
│       ├── BillingAction.tsx   # 入口徽标 + hover/click popover + 统计卡片
│       ├── BillingTurnsPanel.tsx # 逐轮消耗详情面板（图表 + 明细表）
│       ├── BillingSettings.tsx # 原生设置卡片：provider 分组 + 币种 + 分段 + 多高峰时段
│       ├── BillingLabel.tsx    # 共享字段标签（主词 + 小字括号 hint）
│       ├── Tooltip.tsx         # 统一 tooltip（替代原生 title）
│       ├── *.module.css        # 各组件样式（只消费 --billing-* token）
│       ├── theme.module.css    # --billing-* 设计 token 层（跨主题单一事实源）
│       ├── interaction.ts      # 交互延迟常量（卡片/tooltip 单一事实源）
│       ├── billing-api.ts      # /billing/api 的 fetch 客户端 + 目录类型
│       ├── format.ts           # 价格/单位/显示格式化 + 输入解析
│       ├── locales.ts          # zh/en 文案（命名顺序统一在此维护）
│       ├── locate.ts           # 「定位设置页模型」跨入口请求队列
│       ├── types.ts            # SessionProjectionMap 的 'billing' key 声明合并
│       └── context-types.ts    # client Context 结构型声明（slots/locale）
└── tests/
    └── pure-check.ts       # 纯逻辑断言（node 直接跑）：计价/时段/多币种/未登记/折叠
```

## 第三方插件要点（给后续开发）

- **不动主仓库**：所有能力都走现有扩展点（`ctx.settings`、`ctx.sessionProjections`、`conversation.session.header.actions`、`settings.plugin.item`、`ctx.settingsScope`、`ctx.webServer` 自建路由、`ctx.llm` 目录）。
- **设置走原生 settings RPC（rc.7 起）**：rc.6 及以前内置 settings RPC 有写死的暴露白名单，第三方命名空间不会暴露，因此当时仿 `dsh-better-sidebar` 自建了 fenced `/billing/api/settings.*` 路由；rc.7 移除白名单并新增 `settingsScope` 绑定 + `settings.plugin.item` 卡片槽位，价格表读写已迁移——自建路由只保留 `catalog`/`turns`/`refresh`（活目录与现场折叠，settings RPC 不覆盖）。`settingsScope` binder 经调用方 fiber 解析 `connection`/`remote`，所以插件的 cordis `inject` 与 `dsh.client.inject` 清单都要带上它们。
- **设置卡片自持有 chrome**：内置 `PluginCard`/`CardForm` 未对外导出（值不可导入），折叠头/保存栏/只读态需自实现；写入被拒（宿主校验/版本冲突）时 `scope.set` 静默重读而不抛错，要比对 user 层确认落盘。
- **client bundle 必须是纯平台模块**：只能 import 平台表内的包（react / react-dom / jsx-runtime / `@deepseek-ai/dsh-client-ui-primitives` 等），否则 client bundle purity gate 报错。类型可用 `import type {}`（构建时擦除）。
- **Context 用结构型声明**：第三方包不在主仓库单例 cordis 内，收不到 `declare module` 增强；`context-types.ts` 里按需声明用到的服务面。
- **价格数据模型变更**要同步六处联动点——清单见 [docs/prd/PRD.md §6](docs/prd/PRD.md#6-数据模型)。

## 统一交互与设计规范

所有交互节奏与视觉 token 都是**单一事实源**，改一处全插件生效：

| 类别 | 位置 | 说明 |
|---|---|---|
| 交互延迟 | `src/client/interaction.ts` | `HOVER_OPEN_MS=200`（悬停打开卡片）、`HOVER_CLOSE_MS=300`（离开后关闭）、`CLICK_DELAY_MS=100`（点击取消悬停打开）、`TOOLTIP_DELAY_MS=400`（图表/按钮 tooltip）。卡片与 tooltip 共用同一套节奏 |
| Tooltip | `src/client/Tooltip.tsx` | 全插件唯一的 tooltip 实现（portaled、跟随锚点、Esc 关闭、z-index 300 压过卡片 100 与面板 mask 200）。禁止原生 `title`：显示延迟不可控、触屏/读屏不可达 |
| 设计 token | `src/client/theme.module.css` | 全部 `--billing-*` 变量（文本/表面/边框/图表色/圆角/动效曲线）在此解析到 dsw token；组件 CSS 一律不得直接引用 `--dsw-*`。⚠️ dsw 主题变量定义在 `body`/`body[data-ds-dark-theme]` 上，引用它们的 `--billing-*` 也**必须声明在 `body`**（`:root` 不是 body 后代，挂 `:root` 会全部落到亮色 fallback、暗色模式失效）；z-index/圆角/动效等与主题无关的常量才放 `:root` |
| 动效 | `theme.module.css` 的 `--billing-motion-*` | 统一曲线 + 三档时长（fast 120ms 悬停反馈 / medium 160ms 表面进出 / slow 240ms 数据宽度） |

## 已知限制 / 后续

- host 改动无热重载，需重启（框架限制）。
- 高峰时段按**运行机器本地时区**判定：host 折叠用宿主机时区、client 标签用浏览器时区；两者不同时，费用归属与高峰标签可能不一致。
- `/billing/api` 的 fence 只认 loopback Host（另加 `sec-fetch-site` / JSON content-type 的 CSRF 检查）：`dsh web` 绑定 0.0.0.0 供局域网访问时，billing API 一律 403（DNS-rebinding 防御的取舍）。同理，远程/非本机浏览器上 settings RPC 是特权通道——设置卡片退化为只读/不可用（禁保存），徽标高峰标签不显示。
- **齿轮不能直达计费卡片**：rc.7 的设置面板打开态/激活 tab 均为组件本地 state，无导航 API——齿轮只能打开设置面板，「插件」页需用户手动点开；定位请求排队，卡片挂载时消费（展开并滚动到当前模型）。
- **首次保存后内置默认表更新不再生效**：设置页保存的是全量表，user 层整表覆盖内置 base（dsh-settings 数组合并是 wholesale 语义）——插件升级带来的内置默认价格修正/新增模型，对保存过价格表的用户不再自动可见；需要时可手动在设置页补配。
- 设置页编辑器只覆盖目录内模型的无 effort 价格行；目录外模型与 reasoningEffort 价格行不可编辑，但保存时会被**原样保留**（不会丢失）。若某 provider 未列目录，其模型不出现在编辑器（已配置的价格仍参与计价）。
- 「未登记价格」只区分「全部未登记 vs 部分登记」：部分登记时徽标显示已登记部分费用，不提示存在未登记部分。
- **上下文占用反映最近一次已完成请求**（非累计）：压缩/裁剪发生后、下一次请求上报 usage 之前，占用条不会立即下降（与主仓库 token-meter 的 `pressureTokens` 同口径）；`contextWindow` 是 provider 声明的**输入+输出合计**窗口。
- **压缩触发线是近似值**：80% 取自 compaction-basic 的默认 `thresholdRatio=0.8`，该值是私有 cordis patch 配置、运行时读不到；宿主若覆盖，此线为近似（tooltip 有说明）。
- **逐请求明细有界投影 + 全量按需路由**：投影帧按轮次保留最近 50 轮（一个轮次的工具调用 step 不拆散，多币种轮按轮号计一个名额）；全量明细在打开详情面板时走 `/billing/api/turns` 拉取。
- **缓存写入按 token 计、不估算时长费**；「缓存存储（每百万 tokens/小时）」这类按时长收费的模型因日志不含时长维度不建模。TTL 分档（Anthropic 5m/1h）待日志透传后启用，扩展方案见 [docs/prd/PRD.md §8](docs/prd/PRD.md#8-架构与关键技术)。
- 迷你图跨币种条长仅供趋势（按窗口内最大值归一，跨币种长度不可比；hover 显示精确值）。
- 价格精度固定 1/100000 币种单位，如需更高精度需调整 `PRICE_PRECISION` 并同步 schema/投影。
- 后续候选（跨会话报表、预算告警、费用导出等）见 [docs/prd/PRD.md §10](docs/prd/PRD.md#10-迭代记录与后续候选)。

## License

MIT
