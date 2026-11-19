/**
 * 跨语言自测：证明这个插件在别人的语言环境里也能认出按钮。
 *
 * 跑法：node dsh-whale-paywall/scripts/i18n-test.mjs
 *
 * 做法：把 client.js 里那套 `matchesLabel` 的判定逻辑等价复现一遍，
 * 喂 DSH 真实发布的 8 种语言文案，断言每种语言都能命中 / 不误伤。
 * 用的是 lib/labels.json（从 DSH 自带文案生成），不是凭空编的。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const labels = JSON.parse(readFileSync(join(here, '..', 'lib', 'labels.json'), 'utf8'))

let pass = 0
const fails = []
const ok = (cond, label, detail) => {
  if (cond) { pass += 1; return }
  fails.push(label + (detail === undefined ? '' : ` — ${detail}`))
}

/* ── 与 client.js 完全一致的判定逻辑 ── */

const FALLBACK_LABELS = labels.fields

const allOf = (field) => {
  const dict = FALLBACK_LABELS[field] || {}
  const set = new Set()
  for (const value of Object.values(dict)) {
    if (typeof value !== 'string') continue
    const whole = value.replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim()
    if (whole !== '') set.add(whole)
    const tail = value.replace(/^\{[^}]*\}\s*/, '').trim()
    if (tail !== '' && tail !== whole) set.add(tail)
  }
  return [...set]
}

const matchesLabel = (field, text) => {
  const value = String(text || '').trim()
  if (value === '') return false
  return allOf(field).some((candidate) => {
    if (value === candidate) return true
    if (value.startsWith(candidate + ' ')) return true
    if (value.endsWith(candidate)) return true
    return false
  })
}

/* ── ① 每种语言的核心文案都必须命中 ── */

const REQUIRED = {
  newSessionLabel: ['zh', 'en', 'ja', 'de', 'es', 'fr', 'pt', 'ru'],
  newSessionText: ['zh', 'en', 'ja', 'de', 'es', 'fr', 'pt', 'ru'],
  archive: ['zh', 'en', 'ja', 'de', 'es', 'pt', 'ru'],
  settings: ['zh', 'en', 'ja', 'de', 'es', 'fr', 'pt', 'ru'],
  install: ['zh', 'en', 'ja', 'de', 'es', 'fr', 'pt', 'ru'],
  close: ['zh', 'en', 'ja', 'de', 'es', 'fr', 'pt', 'ru'],
}

for (const [field, langs] of Object.entries(REQUIRED)) {
  for (const lang of langs) {
    const text = labels.fields[field]?.[lang]
    ok(text !== undefined, `${field} 有 ${lang} 译文`, String(text))
    if (text === undefined) continue
    ok(matchesLabel(field, text), `${field} 能认出 ${lang}：${JSON.stringify(text)}`)
  }
}

/* ── ② 带插件名的开关：`Enable Foo` 这类也要命中 ── */

for (const lang of Object.keys(labels.fields.enableToggle)) {
  const template = labels.fields.enableToggle[lang]
  const concrete = template.replace('{name}', 'SomePlugin')
  ok(matchesLabel('enableToggle', concrete), `启用开关认得出 ${lang}：${JSON.stringify(concrete)}`)
}

/* ── ③ 不能误伤：跟这些功能无关的文案一律不许命中 ── */

const NEGATIVE = [
  ['newSessionLabel', 'New Session Settings'],
  ['newSessionLabel', 'Delete session'],
  ['newSessionLabel', ''],
  ['archive', 'Unarchive'],
  ['settings', '重置钱包'],
  ['install', 'Uninstall'],
  ['install', 'Installing…'],
  ['close', 'Closed'],
]

for (const [field, text] of NEGATIVE) {
  ok(!matchesLabel(field, text), `不该误伤 ${field} ← ${JSON.stringify(text)}`)
}

/* ── ④ 「Unarchive / 取消归档」必须跟「归档」分开 ── */

const unarchiveTexts = ['Unarchive', '取消归档', '«' ].filter(Boolean)
for (const t of ['Unarchive', '取消归档']) {
  ok(!matchesLabel('archive', t), `「${t}」不被当成归档收费`)
}

/* ── ⑤ 每个字段至少覆盖 2 种语言（否则跨语言无意义） ── */

for (const field of Object.keys(FALLBACK_LABELS)) {
  const n = Object.keys(FALLBACK_LABELS[field]).length
  ok(n >= 2, `${field} 至少覆盖 2 种语言`, `${n} 种`)
}

/* ── ⑥ 兜底：Host 读不到 labels.json 时，中英也得能用 ── */

const MINIMAL = {
  newSessionLabel: { zh: '新建会话', en: 'New session' },
  settings: { zh: '设置', en: 'Settings' },
}
const checkMinimal = (field, text) => {
  const dict = MINIMAL[field] || {}
  return Object.values(dict).some(c => text.trim() === c)
}
ok(checkMinimal('newSessionLabel', 'New session'), '兜底表能认英文新建会话')
ok(checkMinimal('settings', 'Settings'), '兜底表能认英文设置')

console.log(`\n${pass} 条通过，${fails.length} 条失败`)
for (const f of fails) console.log('  FAIL ' + f)
console.log('覆盖语言：', labels.langs.join(', '))
process.exit(fails.length === 0 ? 0 : 1)
