# dsh-billing 插件审查报告

> 审查人：k3 审查 agent · 日期：2026-08-16 · 范围：`scratch-billing/` 全部源码（host/client 半区、构建配置、测试）+ 实证验证
> **状态：已全部修复（v0.2.5，见 PRD §10 迭代记录）**，修复中额外发现并修复：`tsconfig.json` 的 `ignoreDeprecations: "6.0"` 在 TS 5.9 下让 typecheck 直接报错。下方每条保留作审查记录与验收依据。

## 总体评价

架构选型正确（settings 命名空间 + 投影单元 + fenced 自建路由 + 纯平台 client bundle，复用 dsh-better-sidebar 第三方模式）；核心计价逻辑 `src/host/price.ts` / `src/host/session-stats.ts` 干净、纯函数、可测；JSDoc 覆盖良好。但存在 6 个真 bug（含 1 个数据丢失、1 个功能可能完全失效）和一批设计/工程问题。

实证验证记录：

- `tests/pure-check.ts` 借主仓库的 tsx 跑通，**全部断言通过**（计价核心逻辑本身正确）；
- 在 `scratch-billing/` 下直接跑 vitest，它捡到的是主仓库根配置，`tests/pure-check.ts` 不匹配任何 include 模式，**不会被执行**；
- 主仓 DOM 中 `aria-haspopup="dialog"` 的按钮至少 3 个（见 P0-1）。

---

## P0 — Bug（影响功能正确性，第一批修）

### P0-1. 设置页跳转的 DOM 选择器会点错按钮

- 位置：`src/client/BillingAction.tsx:386`（`openBillingSettings`）
- 问题：`document.querySelector('button[aria-haspopup="dialog"]')` 在当前 GUI 至少匹配 3 个按钮：
  - 真正的设置触发器：`packages/client/ui-settings-general/src/client/SettingsRoot.tsx:147`
  - 输入栏 ContextMeter：`packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx:98`
  - **插件自己的徽标按钮**：`src/client/BillingAction.tsx:134`（trigger 也写了 `aria-haspopup="dialog"`）
- `querySelector` 取 DOM 序第一个，命中设置按钮纯属巧合；DOM 顺序一变就永远打不开设置页。后续 `setTimeout(..., 50)` + 按文本匹配 nav 按钮（:391-399）同样脆弱（语言切换、文案撞车、时序竞争）。
- 修法：
  - 短期：限定选择器上下文（如限定在侧栏/顶栏容器内、排除自身 trigger），把固定 50ms 改为轮询/ MutationObserver 等 nav 出现；
  - 中期：推动主仓 settings 插件暴露稳定程序化入口（专用 `data-*` 属性、slot 或 command），插件改走该入口。
- 验收：点齿轮稳定打开设置页并定位当前模型；切换 zh/en 后仍可用；连续开关多次不串。

### P0-2. 保存价格表会静默删除"目录外"的已有价格行（数据丢失）

- 位置：`src/client/BillingSettings.tsx:78`（`buildEditor` 只从 catalog 构建）、`:220`（`save` 只从编辑器状态重建 `models`）
- 问题：任何不在 `ctx.llm.listProviders()/listModels()` 目录里的 provider/model（目录接口失败、provider 下线、历史手配、README 自己承诺"已配置的价格仍参与计价"的行），用户点一次"保存"即被永久删除。
- 修法：`save` 前重新 `getPriceTable()`，把其中未出现在编辑器（按 `provider/model` key）的 `models` 行原样合并进提交负载。
- 验收：手工往 settings 文档写一行目录外模型的价格 → 设置页保存 → 该行仍在。

### P0-3. `reasoningEffort` 在编辑/保存链路丢失

- 位置：`src/client/BillingSettings.tsx:79`（Map key 为 `${provider}/${model}`，不含 effort）、`ModelEdit`（:44-55，无 effort 字段）、`save`（:246-256，不写回 effort）
- 问题：`ModelPrice.reasoningEffort` 参与 host 端行匹配（`src/host/price.ts:103`），但两个仅 effort 不同的行在编辑器 Map 里互相覆盖，保存后全部退化为无 effort 行。
- 修法：编辑器 key 改为含 effort 的三元组并在 `ModelEdit` 保留/回写 `reasoningEffort`；最低限度也要在保存时保留编辑器未展示的 effort 行（与 P0-2 同一合并逻辑覆盖）。
- 验收：配置同一模型两个 effort 档价格 → 保存 → 两行都保留且计价按 effort 匹配。

### P0-4. 测试链路断裂：跑不起来 + 导入错误隐形

- 证据（已实证）：
  - `pnpm test`（vitest）不执行 `tests/pure-check.ts`：文件名不匹配 vitest 默认 include，目录下跑 vitest 会捡到主仓库根配置（其 include 是 `packages/*/*/tests/**`）；
  - PRD 写"tsx 直接跑"，但 **tsx 不在 devDependencies**；
  - `tests/pure-check.ts:5` 从 `../src/shared.ts` 导入 `SessionEvent`——shared.ts 无此导出（正确来源是 `@deepseek-ai/dsh-session`，见 `src/host/session-stats.ts:9`）。因 `tsconfig.json` 的 `include` 只有 `src`，tests 从不被 typecheck，错误隐形。
- 修法：
  1. `tests/pure-check.ts:5` 的 `SessionEvent` 改从 `@deepseek-ai/dsh-session` 导入；
  2. devDependencies 加 `tsx`，`"test": "tsx tests/pure-check.ts"`；
  3. 新增 `tsconfig.tests.json`（extends 主配置、include `tests`），`typecheck` 串联两个配置。
- 验收：在干净环境（无主仓 node_modules）`pnpm install && pnpm test && pnpm typecheck` 全绿。

### P0-5. host 生命周期：watcher 泄漏 + 单会话刷新误伤全局

- 位置：`src/host/index.ts`
- 问题：
  1. :148 `scope.watch(() => mountProjection())` 的 disposer 被丢弃（未包进 `ctx.effect`）——插件卸载后 watcher 仍活，设置变更会在已 dispose 的注册表上再 register；
  2. 每次 `mountProjection` 都 `ctx.inject(...)`（:114）新建 fiber，旧 fiber 只手动 dispose 了注册、fiber 随每次保存累积；
  3. :183 `refresh` 路由调 `mountProjection()`——单会话刷新 dispose+重注册投影单元，**所有会话**的缓存 cell 全部作废重算。设置变更路径本就被 `scope.watch` 覆盖，此处只为刷新 `holder.table`，代价过大。
- 修法：
  - `ctx.inject(['sessionProjections'], ...)` 提到 apply 顶层一次（effect 内），拿到 registry 引用；`mountProjection` 只做 `disposeProjection?.()` + `registry.register(...)`；
  - `scope.watch` 包进 `ctx.effect` 持有 disposer；
  - `refresh` 路由改为 `holder.table = freezeTable(scope.get())` 后仅 `foldBilling` 单会话返回，不再 remount 全局投影（投影帧会随后自然推送）。
- 验收：点卡片刷新只重算当前会话；连续保存 N 次价格表，fiber/watcher 数量不增长（可用 cordis 诊断或日志确认）。

### P0-6. `settings.update` schema 校验过松，可打挂投影管道

- 位置：`src/host/index.ts:31-73`（`priceTableSchema`）
- 问题：价格无 `.min(0)`、`startHour/endHour` 无 0–23/1–24 约束。UI 层 HourInput 会 clamp，但直接 POST `/billing/api/settings.update` 可写入 `startHour: 99` 或负价格；负价格会让投影 zod schema（:132-136 的 `nonnegative()`）校验失败。
- 修法：tierSchema/periodSchema/modelPriceSchema 的价格字段加 `.min(0)`；`startHour` 限 0–23、`endHour` 限 1–24（`days` 元素 0–6 已有）。与主仓规范"misconfiguration fails loud at parser boundary"一致。
- 验收：POST 负价格/非法小时 → 400；合法负载不受影响。

---

## P1 — 设计不合理（第二批修）

### P1-1. 每条消息都重新 fetch 价格表

- 位置：`src/client/BillingAction.tsx:95-112`（effect 依赖 `[stats]`）
- 问题：每条 assistant 消息产生一帧投影 → 重新 POST `getPriceTable()`，并销毁重建 60s interval。
- 修法：拆成两个 effect——价格表只在 mount / 设置保存后 / 手动刷新时取；60s interval 只跑 `inPeakNow`（依赖 `tableRef` 与 `stats.peakModels`）。

### P1-2. 多币种徽标只显示最大子合计

- 位置：`src/client/BillingAction.tsx:367-375`（`badgeText`）
- 问题：会话同时用 ¥ 和 $ provider 时只显示金额最大的币种，与 US-3「多币种不混算」精神相悖，有误导性。
- 修法：多币种显示 `¥1.20 + $0.35`（或主币种 + `+N`），更新 PRD/README 对应描述。

### P1-3. 常量/纯函数重复定义

- 位置：`PRICE_PRECISION`、`formatPrice` 同时存在于 `src/host/price.ts:13,165` 与 `src/client/format.ts:7,10`；`EMPTY_STATS`（`src/host/session-stats.ts:16`）与 `EMPTY`（`src/client/BillingAction.tsx:33`）重复。
- 问题：改一处忘另一处即两侧不一致（精度漂移直接算错钱）。
- 修法：全部移入 `src/shared.ts`（它本来就是为两侧共享、过 purity gate 设计的），host 侧 re-export 保持现有导入兼容。

### P1-4. package.json 工程问题

- `"prepare": "tsdown"`（:29）：首次 `pnpm install` 时 `lib/types/index.js`（tsc 产物）尚不存在 → prepare 失败。改为完整 `build` 或删除；
- 版本号 `0.1.0` 与 PRD 声称的 v0.2.4 不一致，对齐；
- `watch`/`dev:watch`/`bundle` 三脚本冗余，收敛为 `build / typecheck / test / dev:watch`。

### P1-5. client 注入声明含死项

- 位置：`src/client/index.ts:23` `inject = ['slots', 'locale', 'remote']`
- 问题：`remote` 从未使用，`context-types.ts` 也未声明。删除或补齐声明。

### P1-6. 高峰窗口时区语义未定义

- 位置：`src/shared.ts:99`（`inPeakWindow` 用 `new Date(timeMs).getHours()` 本地时区）
- 问题：host 折叠用宿主机时区、client 标签用浏览器时区，两者不同时归属与标识不一致。
- 修法：短期在 README/PRD 写明"按运行机器本地时区"；中期如需严谨，价格表加可选 `timezone` 字段并用 Intl 换算。

### P1-7. fence 仅 loopback 的限制未文档化

- 位置：`src/host/fence.ts`
- 问题：`dsh web` 绑 0.0.0.0 供局域网访问时，billing API 全部 403，无任何文档说明。
- 修法：README「已知限制」补一条；或读取 webServer 实际 bind 地址动态放行（注意保持 DNS-rebinding 防御语义）。

---

## P2 — 小毛病（第三批，可与 P1 合并）

1. `src/client/BillingSettings.tsx:800`：`fmt` 两分支完全相同（死条件），直接 `String(v / 1000)`；同文件 `tierLabel`（:801）的 `'全部'` 硬编码中文，en 界面也显示"全部"——进 locales。
2. `PriceInput`（BillingSettings.tsx:377）失焦才提交：编辑中折叠 provider / 关分段开关，焦点中的修改静默丢失——unmount 时 commit 或折叠前先 blur。
3. `src/host/index.ts:138`：`init` 返回共享的 `EMPTY_STATS` 引用（当前安全因为 fold 全 clone），建议 `Object.freeze(EMPTY_STATS)` 防御。
4. `src/host/session-stats.ts` `foldEvent` 的 `request/header` 分支无条件 clone 产新 stats 引用 → config 没变也推新投影帧；可加相等判断提前返回原 state（低频，可选）。
5. `icon-preview.html`、`scripts/generate-icon-preview.mjs` 为开发残留；package.json 无 `files` 字段，发布会带出——删除或加 `files` 白名单。
6. `src/host/index.ts:252` `body.sessionId as never` 绕过 branded 类型——第三方可接受，补注释说明原因。

---

## 修复执行顺序建议

| 批次 | 内容 | 验证 |
|---|---|---|
| 1 | P0-1 ~ P0-6 全部 | 每条的验收点 + `pnpm test && pnpm typecheck && pnpm build` |
| 2 | P1-1 ~ P1-4（+ P1-5） | 行为回归：卡片/设置页/刷新/保存/多币种 |
| 3 | P1-6、P1-7、P2 全部 | 文档同步（README/PRD 迭代记录追加新版本条目） |

注意联动点（README「第三方插件要点」已声明）：价格数据模型变更要同步 `src/shared.ts`、`src/host/index.ts`（schemastery schema + 投影 zod schema + stateVersion）、`src/client/billing-api.ts`、`tests/pure-check.ts` 五处。若 P0-6 改了 schema 语义导致旧数据不兼容，投影 `stateVersion`（当前 5）需 +1。
