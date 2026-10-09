# dsh-meter

DeepSeek Harness 的**按会话计费插件**：在每个会话右上角展示当前会话的 token 用量与费用（含缓存命中/未命中/写入区分、缓存命中率、按请求时刻归属的高峰/空闲计价、按请求长度取档的分段计价、法定节假日日历），并提供 GUI 设置页编辑价格表。

第三方 bundle：装进任意 dsh profile 即可，**不改主仓库任何代码**。复用 `dsh-better-sidebar` 的成熟第三方模式（自建 fenced `/billing/api` 路由 + session-projection 单元 + 纯平台模块的 client bundle）。

## 效果展示

> 除特别标注的一张外，以下截图取自 **v0.3.32 之后**的构建（DSH `0.2.0-rc.2`）。

会话头部费用徽标（当前会话费用 + 高峰/空闲标签）：

![会话头部-高峰标签](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/01-header-peak-label.png)

hover / 点击展开的统计卡片：token 用量与缓存命中率、按币种并列的费用、逐轮新增迷你图、子代理费用、上下文占用条：

![统计卡片](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/03-card-hover.png)

子代理小节的状态点直接复用官方 `StateDot`，判据与官方花名册**同源**（`dsh-subagent` 的 `subagentTiming.lastTurnCompleted`）——实心绿点 = 已完成、旋转环 = 运行中、中性点 = 当前未运行：

![子代理状态点](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/07-subagent-status.png)

逐轮消耗详情面板（费用柱状图 + 四段 token 堆叠图 + 明细表，「按轮次」/「按请求」两种粒度）：

![逐轮消耗详情面板](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/04-detail-turns.png)

设置页 →「插件」→「计费价格配置」：每个模型的四价与分段计费开关 · 每个模型可配多个高峰窗口（生效星期 + 每段价格）：

| 模型四价 + 分段计费开关 | 高峰时段（生效星期 + 每段价格） |
|---|---|
| ![设置页-分段区间计费](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/05-settings-tiered.png) | ![设置页-高峰时段定价](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/06-settings-peak.png) |

> ⚠️ 下面这张是**历史截图**：空闲态 + 多币种并列计费（`¥1.20 + $0.35`）需要「USD 计价的会话」且「当前不在高峰时段」，采集这批图时两者都不满足，故无法重拍。功能未变，只是图旧。

![会话头部-空闲标签与多币种并列计费](https://raw.githubusercontent.com/J-Chien/dsh-meter/main/docs/screenshots/02-header-idle-multicurrency.png)

## 功能特性

### 会话头部入口（常驻）

- 每个会话右上角有一个**常驻**费用徽标（新会话显示 `¥0.00`）——官方头部动作标签同款：`12px/22px` 字号行高、全圆角药丸、`0 8px` 内边距、14px 图标，hover/展开态用 `interactive-bg-hover` 底色。数值取自 `theme.module.css` 的 `--billing-header-label-size/-height`（单一事实源）。
- **未登记价格**：会话用到的模型全部没有配置价格时，徽标显示琥珀色「未登记价格」标签而不是 `¥0.00`；部分登记时只合计已登记部分。
- **高峰/空闲标识**：会话用到配置了高峰窗口的模型时，徽标旁显示圆角状态标签——当前处于高峰显示红色「高峰」，否则灰色「空闲」（每分钟自动更新）；未配置高峰时段则不显示任何标签。判定按 provider 时区（缺省北京时区），host 折叠与浏览器标签一致。
- **DeepSeek 官方规则一键预设**：DeepSeek 自有 API 的两条路由（`deepseek-official` 与 `deepseek-account`，见 `shared.ts` 的 `DEEPSEEK_PROVIDER_IDS`）各自提供「应用」按钮——一键把该 provider 的模型高峰窗口设为官方那两段（`09:00–12:00` / `14:00–18:00`，来自 `DEEPSEEK_PEAK_WINDOWS` 单一事实源）、生效日收窄为**仅工作日（周一至五）**，并把 provider 时区置为 `Asia/Shanghai`；对应 DeepSeek 2026-08-23 起「周末全天低谷价」的新规。价格保留用户现有配置。
- **多币种徽标**：会话用到多种币种时按币种并列展示（`¥1.20 + $0.35`），不混算。
- **hover 或点击**都能打开统计卡片（hover 200ms 展开、离开 300ms 关闭；点击固定展开，点击外部/Esc 关闭）。

### 统计卡片

卡片沿用官方统计面板（会话内「本轮用量」弹层）的版式：12px 圆角浮层 + `--dsw-specific-menu` 底色 + 官方 prominent 阴影，标题行右侧为本次会话总费用，其下 0.5px 细线 + 一个 `dt/dd` 网格（标签走 tertiary、数值走 secondary 且右对齐、等宽数字），小节之间共用同一条细线。

- **提供方 / 模型**：网格首行显示当前会话的 `provider/model`（含 reasoning effort，长路由按任意位置换行——与官方一致）。
- **token 用量**：缓存命中（一位小数百分比，部分命中绝不四舍五入成 100%）→ 未缓存输入 → 缓存读取 → 缓存写入（仅存在时显示）→ 输出；数值为**精确计数**（千位分隔 + ` tok` 单位，如 `110,663 tok`）。
- **费用**：标题右侧的总费用按币种并列（`¥1.20 + $0.35`）；配置了高峰时段时额外展示「空闲时段」「高峰时段」两行拆分。
- **上下文占用条（压缩预测）**：最近一次请求输入 ÷ provider 声明的输入+输出总窗口（来自日志 `request/context`），显示进度条 + `已用 / 窗口` + `输出上限`；≥85% 预警「接近上限，建议开新会话」。含 80% 压缩触发参考线、压缩历史（已压缩 N 次 · 释放 X tokens · 摘要花费——压缩摘要调用是真实 provider 请求，其费用计入总额）与压缩预估（快照差分增速外推「约 N 轮后触发压缩」，余量可心算验证）。任一数据缺省则不显示（不估算）。
- **每轮新增迷你图**：每轮一根新增占用 token 竖条（快照差分口径，免疫缓存失效；最老轮在左、从左到右 3px 等距排列；**第 1 轮的新增 = 其整轮快照**——它的前驱是空上下文，首轮装载的所有内容都是新增），高峰轮暖色着色，hover 出统一 tooltip；按卡片实际宽度自适应轮数。
- **子代理小节**（见上方截图）：列出本会话派生的子代理及其费用（直接/总数、合计与平均）。状态点复用官方 `StateDot` 组件，**判据与官方花名册同源**——`running → ongoing`（旋转环）；日志证明「该子代理自己的 descriptor 之后、最近一次回合**正常完成**」`→ done`（实心绿点）；其余（尚未闭合 / 被中断 / 报错）`→ idle`（中性点，绝不冒充完成）。映射见 `src/client/subagent-dot.ts`，判定见 `src/host/subagent-pure.ts` 的 `lastTurnCompletedNormally`。
- 卡片标题行的图标按钮（hover/focus 卡片时显形，无 hover 设备常显）：**刷新**（按最新价格重算当前会话）+ **查看详情**（打开逐轮消耗面板）+ **齿轮设置**（打开设置面板并**直接跳到** 设置 →「内置插件」→「计费价格」卡片；定位请求排队，卡片挂载时消费并滚到当前模型）。

### 逐轮消耗详情面板

- 「按轮次」（工具调用 step 合并）/「按请求」两个视图，**图表与表格粒度随视图切换**；图表横轴时间递增、纯数字标签、自动抽稀；按请求为 12px 密集模式、每轮首请求分组加粗。
- 费用柱状图（带纵向刻度轴、币种单位）+ 四段 token 堆叠图（未命中/命中/写入/输出互斥相加 = 总用量）。
- 明细表按轮次倒序；「按请求」视图为可折叠轮次分组（默认折叠）；未登记请求标「未登记」。
- 打开时拉取**全量**逐轮明细（投影帧只按轮次有界保留最近 50 轮）。

### 设置卡片（GUI 编辑价格）

设置面板 →「插件」配置页 → 本插件那一行里的「计费价格配置」页（0.1.7-rc.1 起的原生 `settings.plugins.tab` 槽位，key 为插件行 id `billing`；读写走原生 settings RPC 的 `ctx.configForms.get('billing')` 绑定），保存后 host 自动重算所有会话、各标签页自动同步。

- **按已注册的 provider 分组**（从 `ctx.llm` 实时读取目录，默认全部折叠），**无需手动添加模型**；模型名旁显示真实上下文窗口/输出上限能力（目录数据，非估算）。
- 每个 provider 独立币种（CNY/USD）；每个模型编辑四类价格：输入（缓存命中）/ 输入（缓存未命中）/ 缓存写入 / 输出。
- **分段计费（开关）**：开启后默认价格成为「区间 1」，可继续添加分段；每段 = 输入/输出长度区间（K tokens）+ 同一套四价；无区间匹配时落到默认段兜底。
- **高峰时段**：每个模型可配多个高峰窗口（起止时钟样式 + 各自价格）；窗口内按索引复用模型的分段区间（只读展示区间记号），价格单独编辑；不配高峰则始终按空闲价计。每个窗口可设**生效星期**（每天/工作日/周末/逐日勾选，`days` 按窗口起始日判定），provider 可设**时区**（IANA 名，缺省 `Asia/Shanghai`）——高峰小时与星期都按该时区判定，多 provider 各算各的钟。
- 价格输入自动补零到两位小数（内部高精度整数存储，无浮点误差）；写入被宿主拒绝（校验失败/版本冲突）时在保存按钮旁提示。
- **只写用户真正改过的行**：保存时只把被编辑过的模型行/字段落进 user 层，其余行保持继承内置默认与价格文件——因此升级带来的内置价格修正、以及 Agent 写的 `prices.yaml`，不会被一次无关的保存整体覆盖。

### 计价核心

- **按请求时刻归属时段**：每个请求用其持久化 `time` 查该模型当天的空闲/高峰价格——重放/历史会话也准确；支持跨天窗口（22:00–06:00）与按星期几过滤（`days` 按**窗口起始日**判定：「周五 22:00–06:00」覆盖周六凌晨；起止相同 = 全天）。**时区**：窗口的小时与星期几按 provider 的 `timezone` 判定（缺省 `Asia/Shanghai`，DeepSeek 官方按北京时间计费），host 折叠与 client 高峰标签共用同一判定，不再依赖运行机器时区。
- **法定节假日日历**：provider 可命名一个日历（`providers.<id>.calendar`），命中当天则整天所有高峰窗口不生效、按基准价计。只建模**放假日**、绝不建模**调休上班日**——官方规则是「周一至五（不含法定节假日）」，而 2026 年的六个调休日全部落在周末，按规则本来就是空闲；用「工作日库」反而会把它们算成高峰。内置 `cn` 日历（2025–2026，源自国办通知），两条 DeepSeek 路由默认挂载，**其它 provider 一律不预设**（网关的高峰窗口由其运营方决定，替它认定节假日是猜测）。
- **按请求长度取档**：按请求的总输入/输出长度命中匹配分段，整单按该档单价计（与 z.ai/OpenAI 官方规则一致，非阶梯累进）。
- **缓存未命中/命中/写入分开计价**：各自按对应单价；`cacheWrite` 未配置按 0 计，且只用真实上报 token 数，不估算时长费。
- **未登记模型**：没有价格行的请求单独计数，不影响已登记请求的费用。
- **精度**：价格以整数 `PRICE_PRECISION`（1/100000 币种单位）存储，`¥10.1550/M` 这类 4 位小数也精确；统计显示 2 位小数。价格文件里写成内部单位（如 `300000`）会被 `RATE_CEILING` 拒绝并指出错因。

详细口径、验收标准与数据模型见 [PRD.md](https://github.com/J-Chien/dsh-meter/blob/main/docs/prd/PRD.md)；逐版本变更记录见 [CHANGELOG.md](https://github.com/J-Chien/dsh-meter/blob/main/docs/prd/CHANGELOG.md)。

## 安装

> ⚠️ **npm registry 上的 `dsh-meter` 停留在 0.3.18（2026-08-18）**，其 peer 区间是 `^0.1.0-rc.7`。运行 0.2.x 及更新宿主时，安装前的 peer 校验（`evaluatePluginCompatibility`）会**直接拒绝**它——不是警告。当前源码线（0.3.3x）尚未发布到 npm，所以在那之前请用下面的**源码目录 / tarball** 方式安装。

```sh
# 源码目录（推荐；本仓库当前线）
npx @deepseek-ai/dsh plugin --profile web add ./dsh-meter
# 或打包后安装
pnpm pack
npx @deepseek-ai/dsh plugin --profile web add ./dsh-meter-<version>.tgz
# 首次安装或 host 改动后重启 GUI
npx @deepseek-ai/dsh web
```

只有在 **0.1.7 线**（`0.1.7-rc.2` ~ `0.1.7.x`）的宿主上，npm 上的 0.3.18 才装得上：

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-meter@0.3.18
```

### 用配置文件定价（不想点设置页时）

价格表可以完全用文件维护，Agent 也能据此把"一个链接 / 一张截图"直接落成配置：

```sh
# 默认路径：$DSH_HOME/dsh-meter/prices.yaml（未设 DSH_HOME 即 ~/.dsh/dsh-meter/prices.yaml）
node scripts/check-prices.mjs                     # 校验 + 打印每行在真实时刻的有效价
node scripts/check-prices.mjs my-prices.yaml      # 或指定文件（装成依赖后可用 npx dsh-meter-prices）
```

单位是**元/百万 tokens**（与价目页、设置页同一个数字）。优先级：**显式配置（profile patch / 设置页保存）> 价格文件 > 内置默认**，按行生效；设置卡片会显示价格来自哪个文件、覆盖了几行。格式规范、给 Agent 的配方（链接/截图）、自检与排错见 **[CONFIGURING.md](https://github.com/J-Chien/dsh-meter/blob/main/docs/CONFIGURING.md)**，可运行示例见 [prices.deepseek.yaml](https://github.com/J-Chien/dsh-meter/blob/main/docs/examples/prices.deepseek.yaml)。

```sh
pnpm verify   # typecheck + build + smoke（跑已构建产物）+ 全部测试
```

> 版本要求：v0.3.30 起 peer 区间为 `>=0.1.7-rc.2 <1.0.0`，覆盖 0.1.7-rc.2 到 0.9.x 的**整条 0.x 线**——DSH 后续 0.x 发版无需再改 peer 号，只有 1.0 需要重新核对一次。本仓库的**开发与验证基线**是 DSH `0.2.0-rc.2`（v0.3.32 起 devDependencies 与运行中的宿主同版）。仍停留在 0.1.7-rc.1 / 0.1.5-rc.2 的环境：本仓库**没有**为那些旧线发布可安装产物，如需请在对应提交上自行 `pnpm pack`（peer 区间会在安装时拒绝不匹配的组合）。

`plugin add` 会自动初始化 profile、`pnpm install`（`prepare` 脚本自动构建 `lib/`）并把 `dsh-meter` 追加进 `dsh.profile.bundles`。

### 迁移到另一台机器

插件是**独立包**，目标机器只需装好 pnpm 与 dsh，**不需要拉 deepseek-harness 仓库**：把 `dsh-meter/` 目录（不带 `node_modules/`）或 `pnpm pack` 的 `.tgz` 拷过去，按上面任一命令重新安装即可。注意：

- **迁移后务必重新安装一次**——profile 的 `package.json`/`pnpm-lock.yaml` 里写有本机 `link:`/`file:` 绝对路径，重装让 pnpm 重写为目标机路径。
- 运行数据（`~/.dsh/sessions`）按用户主目录解析，跨机器/跨平台（含 Windows）自动适配。计费配置本身保存在**当前 profile 的插件配置**里（profile `cordis.patch.yml` 中 `id: billing` 那一行），不再有 `~/.dsh/settings.yaml` 的旧命名空间。
- `@deepseek-ai/*` 依赖全部从 npm registry 解析（开发基线为已发布的 `0.2.0-rc.2`），无需内网/私有源。

**验证**：目标 `node_modules/dsh-meter/lib/` 存在 `index.js` + `client.js`；重启后会话右上角出现费用徽标；设置面板「插件」配置页出现「计费价格配置」页，价格表能编辑保存。

## 开发

### 环境准备

本项目是独立 pnpm workspace，**不依赖主仓库 checkout**，可在任意目录（含 Windows / Linux / macOS）直接开发：

```sh
pnpm install
```

### 常用命令

```sh
pnpm typecheck          # tsc --noEmit（src + tests 两个配置）
pnpm test               # 全部纯逻辑/夹具测试（node ≥22.18 原生跑 TS，无需 tsx）
pnpm build              # 一次性构建：tsc(lib/types) + tsdown(lib/index.js + lib/client.js)
pnpm smoke              # 跑已构建产物：host bundle 装载 + client bundle 经 module-loader 注册两个槽位
pnpm verify             # typecheck + build + smoke + test（发布前必跑）
pnpm dev:watch          # tsdown --watch：client 改动自动重建 → GUI 热更新
node scripts/verify-card.mjs   # 渲染回归 sanity：headless 打开 GUI 校验上下文进度条可见（需本机 Chrome + 运行中的 dsh web；见下）
```

> **UI/卡片改动后跑一遍 `node scripts/verify-card.mjs`**：它断言卡片上下文进度条的填充与轨道重叠且被绘制。纯逻辑测试（`pnpm test`）抓不到这类 CSS 布局回归（曾出现过：进度条渲染了但被 `overflow:hidden` 裁掉，见 [踩坑记录](https://github.com/J-Chien/dsh-meter/blob/main/docs/postmortem/2026-08-18-context-bar-regression.md)）。可配 `CHROME_BIN` / `DSH_URL` / `SESSION_HINT` / `--url` / `--session-hint`。
>
> `pnpm test` 故意**不含** `smoke`：smoke 需要先有 `lib/` 构建产物，把它并进 `test` 会让 `test` 变成依赖构建；`pnpm verify` 负责按正确顺序串起来。

### 热更新开发循环

`dsh` GUI 内置 client-hmr，会 stat-poll 每个 client bundle，内容变化即通过 SSE 热重载浏览器插件。

- **client 改动**（`src/client/*`）→ 跑 `pnpm dev:watch` 后**自动热更新，无需重启**。
- **host 改动**（`src/host/*`）→ host 进程无热重载，**需重启 `dsh web` 一次**。
- 若一段时间没有热更新，通常是 dev:watch 停了，重新跑一下即可。

## 技术架构

| 半区 | 机制 |
|---|---|
| Host | 插件行 id `billing`，其 volatile Config **就是**价格表（`ctx.settings` 命名空间 `billing`，内置默认表为 base 层）· `ctx.sessionProjections` 的 `billing` 单元（纯函数折叠会话日志）· fenced `/billing/api` 路由（`catalog` / `refresh` / `turns` / `subagents`）· 通过 `ctx.llm` 读取 provider/模型目录 · `ctx.get('sessionPersistence')` 读子代理日志 |
| Client | `conversation.session.header.actions` 槽位（常驻入口）· `settings.plugins.tab` 页面（key = `billing`）· `ctx.configForms.get('billing')` 读写价格表（原生 settings RPC）· `useProjection('billing')` 读 host 计算结果 · 自建 hover+click popover · `/billing/api` fetch 客户端 |

数据流：**会话日志 → host 纯函数折叠 → `billing` 投影单元 → `session/projection` 推送帧 → 客户端 `useProjection` → 卡片渲染**。价格表经原生 settings RPC 保存后，host 的 `scope.watch` 重新注册投影单元，所有会话按最新价格重算，各绑定端（含其他标签页）经 `settings/document-updated` 自动重播种。

### 内置默认价格

内置 wpsai、zai 以及 DeepSeek 自有两条路由（`deepseek-official` / `deepseek-account`）的官方参考价格表（按每百万 token）。zai（BigModel GLM）按官方分段计费写入（GLM-5.1、GLM-5-Turbo、GLM-4.5-Air 两/三档；GLM-4.7 三档含输出长度分段）；缓存写入列当前为「限时免费」（0）。两条 DeepSeek 路由同时挂内置 `cn` 法定节假日日历。用户可在设置页覆盖/增删；未配置价格的模型显示「未登记价格」并按 0 计价。

### 目录结构

```
dsh-meter/
├── package.json            # dsh bundle + dsh.client 清单，npm scripts
├── cordis.patch.yml        # bundle 的 patch：插入 billing 插件行
├── LICENSE                 # MIT
├── pnpm-workspace.yaml     # 独立 workspace（自含 node_modules 解析）
├── tsconfig.json           # typecheck（解析已安装 dsh 包类型 + react 类型）
├── tsconfig.build.json     # tsc 产出 lib/types（JS + d.ts）
├── tsconfig.tests.json     # tests 的 typecheck 配置
├── tsdown.config.ts        # 双 bundle：lib/index.js(host) + lib/client.js(浏览器)
├── README.md               # 本文档
├── docs/
│   ├── prd/                # PRD.md（当前规格）+ CHANGELOG.md（迭代记录）+ archive/（归档设计稿）
│   ├── postmortem/         # 踩坑记录（时间 / 问题 / 解决办法 / 经验教训，供后续开发参考）
│   ├── review/             # 代码审查记录
│   ├── CONFIGURING.md      # 价格表格式规范 + 给 Agent 的配方 + 自检排错
│   ├── examples/           # 可运行的价格表示例
│   └── screenshots/        # 效果截图
├── src/
│   ├── shared.ts           # 两侧共享的 wire 类型与纯函数（纯 JSON，无 dsh 依赖）
│   ├── calendar.ts         # 法定节假日日历（放假日日期表 + 展开）
│   ├── index.ts            # node 半区入口：re-export host 插件与纯逻辑
│   ├── invariant.ts        # 空态断言 invariant companion
│   ├── host/               # ── Host 半区（价格计算 + 路由）──
│   │   ├── index.ts        # 插件主体：settings ns + 投影单元 + /billing/api 路由
│   │   ├── price.ts        # 价格模型：精度、高峰窗口、按请求计价、未登记检测
│   │   ├── price-file.ts   # prices.yaml 加载/校验（全份拒绝语义 + 单位粘贴护栏）
│   │   ├── default-prices.ts # 内置默认价格表 + 内置日历
│   │   ├── session-stats.ts  # 纯会话折叠 → 每币种费用/未登记计数/逐轮明细/压缩历史
│   │   ├── subagent-pure.ts  # 子代理折叠的纯函数部分
│   │   ├── subagent-stats.ts # 子代理费用汇总（冷折预算 + 后台预热）
│   │   ├── wire.ts         # /billing/api 的 JSON 读写辅助
│   │   ├── fence.ts        # 路由 loopback 信任围栏（DNS-rebinding 防御）
│   │   ├── projection-types.ts # 投影单元的类型面
│   │   └── context-types.ts # host Context 结构型声明（settings/webServer/sessions/llm）
│   └── client/             # ── Client 半区（UI）──
│       ├── index.ts        # client 插件：绑定 configForms + 注册头部入口 + 设置页
│       ├── pricing-scope.ts # `billing` 命名空间的 configForms 共享绑定（徽标/卡片共用）
│       ├── settings-nav.ts  # 齿轮 → 设置页计费卡片的导航（走 shell store seat）
│       ├── settings-merge.ts # 保存时"只写改过的行"的纯决策函数
│       ├── BillingAction.tsx   # 入口徽标 + hover/click popover + 统计卡片
│       ├── BillingTurnsPanel.tsx # 逐轮消耗详情面板（图表 + 明细表）
│       ├── BillingSettings.tsx # 设置页：provider 分组 + 币种 + 分段 + 多高峰时段
│       ├── BillingLabel.tsx    # 共享字段标签（主词 + 小字括号 hint）
│       ├── Tooltip.tsx         # 统一 tooltip（替代原生 title）
│       ├── subagent-dot.ts     # 子代理状态 → 官方 StateDot 语义的纯映射
│       ├── *.module.css        # 各组件样式（只消费 --billing-* token）
│       ├── theme.module.css    # --billing-* 设计 token 层（跨主题单一事实源）
│       ├── interaction.ts      # 交互延迟常量（卡片/tooltip 单一事实源）
│       ├── billing-api.ts      # /billing/api 的 fetch 客户端（含响应形状校验）+ 目录类型
│       ├── format.ts           # 价格/单位/显示格式化 + 输入解析
│       ├── locales.ts          # zh/en 文案（命名顺序统一在此维护）
│       ├── preset.ts           # DeepSeek 官方峰谷规则一键预设
│       ├── timezones.ts        # 时区候选（可搜索下拉）
│       ├── locate.ts           # 「定位设置页模型」跨入口请求队列
│       ├── types.ts            # SessionProjectionMap 的 'billing' key 声明合并
│       └── context-types.ts    # client Context 结构型声明（slots/locale/configForms）
├── scripts/
│   ├── check-prices.mjs        # 价格表自检 CLI（bin: dsh-meter-prices）
│   ├── verify-card.mjs         # 渲染回归 sanity（headless Chrome）
│   └── generate-icon-preview.mjs # 图标预览页生成（开发用，输入来自主仓库 checkout）
└── tests/
    ├── pure-check.ts            # 纯逻辑断言：计价/时段/多币种/未登记/折叠/围栏/预设
    ├── price-file-check.ts      # 价格文件契约：单位误用、重复行、路径解析
    ├── settings-nav-check.ts    # 齿轮导航（jsdom）：seat 路径 + DOM 回退
    ├── host-regression-check.ts # host 回归：非有限价格、tier 对齐、无 turn 折叠等价性
    ├── client-regression-check.ts # client 回归：保存行筛选、预设窗口、响应校验
    └── smoke.ts                 # 已构建产物冒烟：host bundle 装载 + client bundle 注册两槽位
```

## 第三方插件要点（给后续开发）

- **不动主仓库**：所有能力都走现有扩展点（`ctx.settings`、`ctx.sessionProjections`、`conversation.session.header.actions`、`settings.plugins.tab`、`ctx.configForms`、`ctx.webServer` 自建路由、`ctx.llm` 目录）。
- **设置走原生 settings RPC（0.1.7-rc.1 起）**：0.1.6 及以前内置 settings RPC 有写死的暴露白名单，第三方命名空间不会暴露，因此当时仿 `dsh-better-sidebar` 自建了 fenced `/billing/api/settings.*` 路由；0.1.7-rc.1 移除白名单并新增 `configForms` 绑定 + `settings.plugins.tab` 卡片槽位，价格表读写已迁移——自建路由只保留 `catalog`/`turns`/`subagents`/`refresh`（活目录、全量明细与现场折叠，settings RPC 不覆盖）。`configForms` binder 经调用方 fiber 解析依赖，所以插件的 cordis `inject` 要带上 `slots`/`locale`/`configForms`。
- **设置页自带 chrome**：内置 `PluginCard`/`CardForm` 未对外导出（值不可导入），折叠头/保存栏/只读态需自实现；写入被拒（宿主校验/版本冲突）时 `configForms` 的 `set` 静默重读而不抛错，要比对 user 层确认落盘。
- **client bundle 必须是纯平台模块**：只能 import 平台表内的包（react / react-dom / jsx-runtime / `@deepseek-ai/dsh-client-ui-primitives` 等），否则 client bundle purity gate 报错。类型可用 `import type {}`（构建时擦除）。
- **Context 用结构型声明**：第三方包不在主仓库单例 cordis 内，收不到 `declare module` 增强；`context-types.ts` 里按需声明用到的服务面。
- **价格数据模型变更**要同步六处联动点——清单见 [PRD.md §6](https://github.com/J-Chien/dsh-meter/blob/main/docs/prd/PRD.md#6-数据模型)。

## 统一交互与设计规范

所有交互节奏与视觉 token 都是**单一事实源**，改一处全插件生效：

| 类别 | 位置 | 说明 |
|---|---|---|
| 交互延迟 | `src/client/interaction.ts` | `HOVER_OPEN_MS=200`（悬停打开卡片）、`HOVER_CLOSE_MS=300`（离开后关闭）、`CLICK_DELAY_MS=100`（点击取消悬停打开）、`TOOLTIP_DELAY_MS=400`（图表/按钮 tooltip）。卡片与 tooltip 共用同一套节奏 |
| Tooltip | `src/client/Tooltip.tsx` | 全插件唯一的 tooltip 实现（portaled、跟随锚点、Esc 关闭、z-index 1300 压过面板 mask 1200 与卡片 1100）。禁止原生 `title`：显示延迟不可控、触屏/读屏不可达 |
| 设计 token | `src/client/theme.module.css` | 全部 `--billing-*` 变量（文本/表面/边框/图表色/圆角/动效曲线）在此解析到 dsw token；组件 CSS 一律不得直接引用 `--dsw-*`。⚠️ dsw 主题变量定义在 `body`/`body[data-ds-dark-theme]` 上，引用它们的 `--billing-*` 也**必须声明在 `body`**（`:root` 不是 body 后代，挂 `:root` 会全部落到亮色 fallback、暗色模式失效）；z-index/圆角/动效等与主题无关的常量才放 `:root` |
| 动效 | `theme.module.css` 的 `--billing-motion-*` | 统一曲线 + 三档时长（fast 120ms 悬停反馈 / medium 160ms 表面进出 / slow 240ms 数据宽度） |

## 已知限制 / 后续

- host 改动无热重载，需重启（框架限制）。
- 高峰窗口默认按 `Asia/Shanghai`（北京时间）判定；旧配置未填 provider 时区时同样按北京时区——若你的 provider 实际按其他时区计费，请在设置页给该 provider 配置对应 IANA 时区。host 折叠与 client 标签共用同一判定，不会互相矛盾。
- `/billing/api` 的 fence 只认 loopback Host（另加 `sec-fetch-site` / JSON content-type 的 CSRF 检查）：`dsh web` 绑定 0.0.0.0 供局域网访问时，billing API 一律 403（DNS-rebinding 防御的取舍）。同理，远程/非本机浏览器上 settings RPC 是特权通道——设置卡片退化为只读/不可用（禁保存），徽标高峰标签不显示。
- 设置页编辑器只覆盖目录内模型的无 effort 价格行；目录外模型与 reasoningEffort 价格行不可编辑，但保存时会被**原样保留**（不会丢失）。若某 provider 未列目录，其模型不出现在编辑器（已配置的价格仍参与计价）。
- 「未登记价格」只区分「全部未登记 vs 部分登记」：部分登记时徽标显示已登记部分费用，不提示存在未登记部分。
- **上下文占用反映最近一次已完成请求**（非累计）：压缩/裁剪发生后、下一次请求上报 usage 之前，占用条不会立即下降（与主仓库 token-meter 的 `pressureTokens` 同口径）；`contextWindow` 是 provider 声明的**输入+输出合计**窗口。
- **压缩触发线是近似值**：80% 取自 compaction-basic 的默认 `thresholdRatio=0.8`，该值是私有 cordis patch 配置、运行时读不到；宿主若覆盖，此线为近似（tooltip 有说明）。
- **逐请求明细有界投影 + 全量按需路由**：投影帧按轮次保留最近 50 轮（一个轮次的工具调用 step 不拆散，多币种轮按轮号计一个名额）；全量明细在打开详情面板时走 `/billing/api/turns` 拉取。
- **缓存写入按 token 计、不估算时长费**；「缓存存储（每百万 tokens/小时）」这类按时长收费的模型因日志不含时长维度不建模。TTL 分档（Anthropic 5m/1h）待日志透传后启用，扩展方案见 [PRD.md §8](https://github.com/J-Chien/dsh-meter/blob/main/docs/prd/PRD.md#8-架构与关键技术)。
- 迷你图跨币种条长仅供趋势（按窗口内最大值归一，跨币种长度不可比；hover 显示精确值）。
- 价格精度固定 1/100000 币种单位，如需更高精度需调整 `PRICE_PRECISION` 并同步 schema/投影。
- `dsh.client.inject` 目前仍列着 `dsh-api-remotes` / `dsh-client-connection` / `dsh-client-ui-session`——它们来自已移除的 `settingsScope` 方案，现多为类型导入（构建时擦除）。保留是为了不改变 boot graph 的到达顺序；待有运行时验证手段后再收紧。
- 后续候选（跨会话报表、预算告警、费用导出等）见 [PRD.md §10](https://github.com/J-Chien/dsh-meter/blob/main/docs/prd/PRD.md#10-迭代记录与后续候选)。

## License

MIT — 见 [LICENSE](LICENSE)。
