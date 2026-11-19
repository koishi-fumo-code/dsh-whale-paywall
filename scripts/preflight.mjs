/**
 * 打包前自检：确认这个插件离开本机也能装、能跑。
 *
 * 检查项：
 *   ① package.json 声明的导出文件都存在
 *   ② dsh.client 有 exports["./client"] 且文件在（漏了会让别人整个 DSH 起不来）
 *   ③ cordis.patch.yml 是合法 YAML 数组
 *   ④ 不引用工作区外的绝对路径
 *   ⑤ client.js 没有残留的单一语言硬编码
 *   ⑥ lib/labels.json 存在且覆盖 ≥2 种语言
 *
 * 跑法：node dsh-whale-paywall/scripts/preflight.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
const fails = []
const ok = (cond, label, detail) => {
  if (cond) { pass += 1; return }
  fails.push(label + (detail === undefined ? '' : ` — ${detail}`))
}

const read = (rel) => readFileSync(join(root, rel), 'utf8')
const exists = (rel) => existsSync(join(root, rel))

/* ① 清单与导出 */
const pkg = JSON.parse(read('package.json'))
ok(typeof pkg.name === 'string' && pkg.name.length > 0, 'package.json 有 name')
ok(pkg.type === 'module', 'package.json type = module')

const exportTargets = []
for (const [key, value] of Object.entries(pkg.exports || {})) {
  if (typeof value === 'string' && !value.includes('*')) exportTargets.push([key, value])
}
for (const [key, value] of exportTargets) {
  ok(exists(value), `导出的 ${key} → ${value} 存在`)
}

/* ② dsh.client 必须有 ./client（这条漏了会让别人整个 DSH 起不来） */
if (pkg.dsh?.client !== undefined) {
  ok(pkg.exports?.['./client'] !== undefined, '声明了 dsh.client ⇒ 必须有 exports["./client"]')
  const clientPath = pkg.exports?.['./client']
  ok(typeof clientPath === 'string' && exists(clientPath), 'client 文件真的存在', String(clientPath))
}

/* ③ bundle patch 是合法 YAML 数组 */
ok(pkg.dsh?.bundle?.patch !== undefined, '声明了 dsh.bundle.patch')
const patchText = read('cordis.patch.yml')
ok(/^\s*-\s/m.test(patchText), 'cordis.patch.yml 是 YAML 数组（以 - 开头）')
ok(!patchText.includes('\t'), 'cordis.patch.yml 没有制表符')
ok(/name:\s*['"]?dsh-whale-paywall/.test(patchText), 'patch 里插的是本包名')

/* ④ 不许引用本机绝对路径 */
for (const f of ['index.js', 'client.js', 'lib/wallet.mjs', 'cordis.patch.yml', 'package.json']) {
  const text = read(f)
  const bad = /[A-Za-z]:\\\\dsh|[A-Za-z]:\\dsh|D:\\\\dsh/.test(text)
  ok(!bad, `${f} 不含本机绝对路径`)
}

/* ⑤ client.js 不许再有单一语言硬编码（除了兜底表） */
const clientText = read('client.js')
const hardcoded = [
  [/\/\^\(新会话\|/, '新会话硬编码正则'],
  [/\/\^\(归档会话\|/, '归档会话硬编码正则'],
  [/\/\^\(设置\|Settings\)\$/, '设置硬编码正则'],
]
for (const [re, label] of hardcoded) {
  ok(!re.test(clientText), `client.js 没有${label}`)
}
ok(clientText.includes('matchesLabel'), 'client.js 走 I18N 匹配函数')
ok(clientText.includes('FALLBACK_LABELS'), 'client.js 有语言兜底表')

/* ⑥ labels.json */
ok(exists('lib/labels.json'), 'lib/labels.json 存在')
if (exists('lib/labels.json')) {
  const labels = JSON.parse(read('lib/labels.json'))
  const fields = Object.keys(labels.fields || {})
  ok(fields.length >= 6, 'labels.json 至少 6 个字段', `${fields.length} 个`)
  for (const field of fields) {
    const n = Object.keys(labels.fields[field]).length
    ok(n >= 2, `${field} 至少覆盖 2 种语言`, `${n} 种`)
  }
}

/* ⑦ files 数组要包含运行必需的文件 */
const required = ['index.js', 'client.js', 'cordis.patch.yml', 'lib/wallet.mjs', 'lib/labels.json', 'locale/zh.json', 'icon.svg']
const files = pkg.files || []
for (const rel of required) {
  const covered = files.some((pattern) => {
    if (pattern === rel) return true
    if (pattern.endsWith('/*.json') && rel.endsWith('.json') && rel.startsWith(pattern.slice(0, -6))) return true
    if (pattern === 'lib' && rel.startsWith('lib/')) return true
    if (pattern === 'locale/*.json' && rel.startsWith('locale/') && rel.endsWith('.json')) return true
    return false
  })
  ok(covered, `files 覆盖 ${rel}`, files.join(','))
}

/* ⑧ 图标可读且是 SVG */
ok(exists('icon.svg'), 'icon.svg 存在')
if (exists('icon.svg')) {
  ok(statSync(join(root, 'icon.svg')).size < 256 * 1024, 'icon.svg 小于 256 KiB')
  ok(read('icon.svg').trimStart().startsWith('<svg'), 'icon.svg 是 SVG')
}

console.log(`\n${pass} 条通过，${fails.length} 条失败`)
for (const f of fails) console.log('  FAIL ' + f)
process.exit(fails.length === 0 ? 0 : 1)
