# 高峰/低谷规则迭代：工作日 vs 周末 + 时区支持

> 状态：**已实现**（v0.3.19）。对应 DeepSeek 2026-08-23 峰谷计费新规则。

## 0. 需求一句话

- 工作日（周一至五）沿用现有高峰/低谷分段计费；
- 周末（周六日）全天不区分高峰，一律按低谷价（= 无高峰窗口命中时的基础价）；
- 高峰窗口的生效要按**北京时区**而非机器本地时区判定——因为可能同时有多个 provider，各 provider 的高峰窗口属于各自时区。

## 1. 结论先行（已拍板）

| 项 | 决定 |
|---|---|
| 时区存储位置 | **provider 级**：`ProviderCurrency` 平级加 `timezone` 字段（`Asia/Shanghai`），其下所有高峰窗口共用 |
| 旧配置迁移 | 无 `timezone` 的 provider **默认按 `Asia/Shanghai` 判定**（对齐 DeepSeek 习惯） |
| 一键预设 | **仅 DeepSeek 模型**：对 provider 内匹配 DeepSeek 的模型批量配置「工作日窗口 + Asia/Shanghai」 |
| 跨天窗口 | **维持现状不动**（按窗口起始日归属）；DeepSeek 官方是日内时段，实际不会撞周末边界 |

## 2. 现状与缺口

### 引擎已能表达新规则
- `PeakPeriod.days`（0=周日…6=周六）**已存在**且 `inPeakWindow` 已实现工作日掩码（`shared.ts:108-129`）——**「周末无高峰」无需新引擎逻辑**，基础价即低谷价，天然成立。
- 跨天窗口语义已定义（按窗口起始日归属）。

### 真正的缺口是两处
1. **时区**：`inPeakWindow` 用 `date.getHours()/getDay()`（机器本地时区）。host 折叠用宿主机时区、client 标签用浏览器时区，**两者不一致时归属与标签矛盾**（K3 审阅 P1-6 已留痕）。
2. **设置页没有 `days` 的编辑 UI**：`PeriodEditor` 只有起止小时，无法表达「仅工作日」。

## 3. 数据模型（向后兼容，无迁移脚本）

```ts
// src/shared.ts
export interface ProviderCurrency {
  currency: 'CNY' | 'USD'
  currencySymbol: string
  timezone?: string   // 新增：IANA 时区名，如 "Asia/Shanghai"；缺省 = Asia/Shanghai
}

// PeakPeriod 不变（days 已存在，缺省=每天）
export interface PeakPeriod {
  startHour: number
  endHour: number
  days?: number[]       // 0=周日 … 6=周六；缺省 = 每天
  input/output/cacheInput/cacheWrite/tiers
}
```

- `PeakPeriod` 无需加字段；`days` 已支持。
- `ProviderCurrency.timezone` 为可选；窗口判定时取 `table.providers[providerId].timezone ?? 'Asia/Shanghai'`。

## 4. 引擎判定（`shared.ts::inPeakWindow`，单一事实源）

host 折叠、client 高峰标签共用这一个函数。改动为：**小时 + 星期几按 provider 时区计算**，而非机器本地。

```
timeMs → provider 的 timezone（表里查，缺省 'Asia/Shanghai'）
       → Intl.DateTimeFormat('en-US', { timeZone, weekday:'short', hour:'2-digit', hourCycle:'h23' })
         .formatToParts(timeMs) 取 weekday + hour
       → 复用现有 days / 跨天 / 起止相等逻辑
```

- `Intl.DateTimeFormat` 实例按 tz 缓存（Map），避免每次请求重建。
- 跨天窗口「按窗口起始日」逻辑不变，只是星期几改为时区内星期几。
- **收益**：host 折叠与 client 标签在配置时区下自动一致，K3 P1-6 的已知限制对配置了时区的 provider 消失。

## 5. 设置页 UI

### 5.1 Provider 头部（`ProviderGroup`）
「币种」选择旁新增**时区**字段：
- 文本输入（IANA 名，如 `Asia/Shanghai`），提交时用 `Intl.DateTimeFormat('en-US', { timeZone })` 校验合法性，非法 → 红字报错拒存。
- 快捷下拉：`本机时区` / `Asia/Shanghai (UTC+8)` / `UTC`。
- 时区为空 = 用 `Asia/Shanghai`（缺省语义）。

### 5.2 高峰窗口（`PeriodEditor`）
「开始/结束」下方新增**星期**一行（`days` 编辑）：
- 三个快捷 chip：`每天` / `工作日(周一–五)` / `周末(周六日)`，映射 `[1,2,3,4,5]` / `[0,6]` / 空；
- 或七个日复选框（日一二三四五六），自由组合；
- 文案小字：「按窗口起始日判定：周五 22:00–06:00 覆盖周六凌晨」。
- 时区不在此显示（已上移到 provider 级）。

## 6. 一键预设（DeepSeek 官方新规则）

在设置页 provider 头部或模型区提供一个按钮，对**当前 provider 内匹配 DeepSeek 的模型**批量应用：
- 每个匹配模型添加/更新一个高峰窗口：**工作日（`days=[1,2,3,4,5]`）**，起止按官方原有时段（缺省取现有第一窗口的时段，用户可改），**时区 = `Asia/Shanghai`**。
- 价格不预填官方价（沿用用户现有/基础价），窗口只是「哪些天高峰」的开关——符合「价格用户自维护」现状。

### 匹配口径
DeepSeek 官方模型的 provider id 是 **`deepseek-official`**（用户实测确认；wpsai 是用户自有代理，不参与匹配）。预设按钮按 **provider id === `deepseek-official`** 匹配，命中后：
- 该 provider 的时区置为 `Asia/Shanghai`；
- 其下每个模型添加/更新工作日高峰窗口。

## 7. 展示层（几乎零改动）

- 徽标「高峰/空闲」、卡片「空闲/高峰时段」拆分全部走共享 `inPeakWindow` → 自动正确：北京周末全天「空闲」、费用全入 off-peak。
- 可选加分（暂缓）：周末时标签/时段行给「周末」弱提示。

## 8. 兼容性与测试

- 旧配置（无 `days`、无 `timezone`）：唯一行为变化是「无 timezone 缺省由本机时区 → Asia/Shanghai」，需在 CHANGELOG 明示（这是拍板决定，接受）。
- `tests/pure-check.ts` 新增：
  - Asia/Shanghai 窗口在 UTC+0 机器的归属；
  - 工作日掩码：周六请求 off-peak、周一请求 peak；
  - 跨天×时区×星期组合（周五 22:00 北京 = 周六凌晨 off-peak，按起始日判）；
  - 非法时区拒存；
  - 预设匹配（provider id `deepseek-official`）。

## 9. 影响文件

| 文件 | 改动 |
|---|---|
| `src/shared.ts` | `ProviderCurrency.timezone`；`inPeakWindow` 时区换算 |
| `src/host/index.ts` | `providerCurrencySchema` 加 `timezone`；freezeTable 透传 |
| `src/host/price.ts` | 无（走 shared） |
| `src/client/BillingSettings.tsx` | provider 时区输入 + PeriodEditor 星期 chips + 预设按钮 |
| `src/client/locales.ts` | zh/en 新文案 |
| `tests/pure-check.ts` | 上述测试 |
| `README.md` / `docs/prd/PRD.md` / `CHANGELOG.md` | 文档同步 |
