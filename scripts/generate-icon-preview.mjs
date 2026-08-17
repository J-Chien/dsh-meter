/**
 * Dev helper: render the dsh primitives icon set plus hand-drawn money-icon
 * candidates into a single HTML preview page (scratch-billing/icon-preview.html)
 * so icon choices can be reviewed in a browser before any code changes.
 * Reads the primitives icon source from the main repo checkout.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ICONS_SRC = resolve(
  import.meta.dirname,
  '../../packages/client/ui-primitives/src/icons/index.tsx',
)
const OUT = resolve(import.meta.dirname, '../icon-preview.html')

const src = readFileSync(ICONS_SRC, 'utf8')
const re = /export const (Icon\w+) = \(\{[^}]*size = (\d+)[^}]*\}[^)]*\) => \(\s*(<svg[\s\S]*?<\/svg>)/g
const icons = []
for (const m of src.matchAll(re)) {
  const svg = m[3].replace(/\{size\}/g, '28').replace(/\{className\}/g, '')
  icons.push({ name: m[1], size: Number(m[2]), svg })
}

/** Money-icon candidates: stroke-based 16x16 glyphs (final impl would inline these). */
const candidates = [
  {
    name: '方案 A · ¥ 圆形',
    note: '圆环内 ¥，人民币语义最直接',
    svg: `<svg viewBox="0 0 16 16" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.9"/><path d="M8 4.4v6.4"/><path d="M5.2 7.2h5.6"/><path d="M8 4.4 5.4 8.2"/><path d="M8 4.4 10.6 8.2"/></svg>`,
  },
  {
    name: '方案 B · ¥ 圆角方块',
    note: '圆角矩形内 ¥（更接近"价格标签"）',
    svg: `<svg viewBox="0 0 16 16" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1.4" y="1.4" width="13.2" height="13.2" rx="3.2"/><path d="M8 4.2v6.4"/><path d="M5.2 7.2h5.6"/><path d="M8 4.2 5.4 8"/><path d="M8 4.2 10.6 8"/></svg>`,
  },
  {
    name: '方案 C · 账单/收据',
    note: '收据 + 三条明细线（账单语义）',
    svg: `<svg viewBox="0 0 16 16" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 1.8h10v12.4l-2.5-1.7-2.5 1.7-2.5-1.7-2.5 1.7z"/><path d="M5.2 4.9h5.6"/><path d="M5.2 7.3h5.6"/><path d="M5.2 9.7h3.4"/></svg>`,
  },
  {
    name: '方案 D · 硬币',
    note: '硬币轮廓 + 币面 ¥',
    svg: `<svg viewBox="0 0 16 16" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="4.6" rx="6.2" ry="3.3"/><path d="M1.8 4.6v6.8c0 1.8 2.8 3.3 6.2 3.3s6.2-1.5 6.2-3.3V4.6"/><path d="M8 3v3.2"/><path d="M6.2 4.3h3.6"/><path d="M8 3 6.5 5.1"/><path d="M8 3 9.5 5.1"/></svg>`,
  },
  {
    name: '方案 E · 钱包',
    note: '钱包 + 搭扣（账户/余额语义）',
    svg: `<svg viewBox="0 0 16 16" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 4.8h11.6v6.8a1.8 1.8 0 0 1-1.8 1.8H4a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M4 4.8V3.5A1.5 1.5 0 0 1 5.5 2h4.6"/><circle cx="10.6" cy="8.4" r="1"/><path d="M8 8.4h4.6"/></svg>`,
  },
  {
    name: '方案 F · ¥ 符号',
    note: '纯 ¥ 字符（等宽字体），最朴素',
    svg: `<span style="font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:22px;line-height:28px;color:currentColor">¥</span>`,
  },
]

const cell = (label, note, body) => `
  <div class="cell">
    <div class="glyph">${body}</div>
    <div class="name">${label}</div>
    <div class="note">${note}</div>
  </div>`

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>dsh-meter 图标预览</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; margin: 24px; color: #1f2329; background: #fff; }
  h1 { font-size: 18px; } h2 { font-size: 15px; margin-top: 28px; border-bottom: 1px solid #e5e6eb; padding-bottom: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; }
  .cell { border: 1px solid #e5e6eb; border-radius: 10px; padding: 12px 8px; text-align: center; }
  .glyph { height: 40px; display: flex; align-items: center; justify-content: center; color: #1f2329; }
  .name { font-size: 12px; margin-top: 8px; word-break: break-all; }
  .note { font-size: 11px; color: #8f959e; margin-top: 4px; }
  .cand { background: #f7f8fa; }
</style>
</head>
<body>
<h1>dsh-meter 设置页图标预览</h1>
<h2>货币/账单候选（新画，方案 A–F）</h2>
<div class="grid">${candidates.map(c => cell(c.name, c.note, c.svg)).join('')}</div>
<h2>现有 primitives 图标集（${icons.length} 个，看有没有能直接用的）</h2>
<div class="grid">${icons.map(i => cell(`${i.name} (${i.size}px)`, '', i.svg)).join('')}</div>
</body>
</html>
`

writeFileSync(OUT, html)
console.log(`wrote ${OUT} with ${icons.length} primitives icons + ${candidates.length} candidates`)
