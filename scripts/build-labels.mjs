/**
 * 从 DSH 自带的 locales.ts 里挖出我们需要的文案，生成多语言对照表。
 * 输出：dsh-whale-paywall/lib/labels.json
 *
 * DSH 的文案不在 locale/*.json（那里只有 meta），而是在
 * src/client/locales.ts 里按语言分成 `export const en = { ... }` 这样的块。
 * 这个脚本把每个块解析出来，取出我们关心的那几个 key。
 *
 * 跑法：node dsh-whale-paywall/scripts/build-labels.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outPath = join(here, '..', 'lib', 'labels.json')

const DUMP = 'D:\\dsh工作区\\_tmp\\n2\\dump'

/** DSH 源码里语言块的变量名。 */
const LANGS = ['zh', 'en', 'ja', 'de', 'es', 'fr', 'pt', 'ru']

/** 我们关心的文案：field → 哪个包、哪个 key。 */
const WANTED = {
  newSessionLabel: { pkg: 'dsh-client-ui-sidebar', key: 'session.new.label' },
  newSessionText: { pkg: 'dsh-client-ui-sidebar', key: 'session.new' },
  archive: { pkg: 'dsh-client-ui-workspace', key: 'menu.archiveSession' },
  archiveAction: { pkg: 'dsh-client-ui-workspace', key: 'actions.archive' },
  settings: { pkg: 'dsh-client-ui-settings-general', key: 'title' },
  settingsTrigger: { pkg: 'dsh-client-ui-settings-general', key: 'trigger' },
  enableToggle: { pkg: 'dsh-client-ui-plugin-manager', key: 'enableToggle' },
  install: { pkg: 'dsh-client-ui-plugin-manager', key: 'installRun' },
  close: { pkg: 'dsh-client-ui-settings-general', key: 'close' },
}

/**
 * 从 locales.ts 里抽出某个语言块的所有 'key': 'value' 对。
 * 只认单行、单引号的写法（DSH 就是这么写的）。
 * @param {string} text 文件内容
 * @param {string} lang 语言变量名
 */
function parseLangBlock(text, lang) {
  const start = text.indexOf(`export const ${lang} = {`)
  if (start < 0) return {}
  const open = text.indexOf('{', start)
  // 找到这个块的结束：从 { 开始数括号，遇到配对的 } 为止
  let depth = 0
  let end = open
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  const body = text.slice(open + 1, end)
  const dict = {}
  // 两种写法都要认：
  //   'session.new': '新会话'   —— 带引号的 key（sidebar / workspace）
  //   enableToggle: '启用 {name}' —— 不带引号的 key（plugin-manager）
  const re = /(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*'((?:[^'\\]|\\.)*)'/g
  let m
  while ((m = re.exec(body)) !== null) {
    const key = m[1] ?? m[2]
    dict[key] = m[3].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  }
  return dict
}

/** 读一个包的 locales.ts 并解析出所有语言。 */
function readPackage(pkg) {
  const file = join(DUMP, pkg, 'src', 'client', 'locales.ts')
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const out = {}
  for (const lang of LANGS) {
    const dict = parseLangBlock(text, lang)
    if (Object.keys(dict).length > 0) out[lang] = dict
  }
  return out
}

const cache = {}
const result = {
  generatedFrom: 'DSH shipped src/client/locales.ts',
  langs: LANGS,
  fields: {},
}

for (const [field, { pkg, key }] of Object.entries(WANTED)) {
  if (!(pkg in cache)) cache[pkg] = readPackage(pkg)
  const dicts = cache[pkg]
  result.fields[field] = {}
  if (dicts === null) continue
  for (const lang of LANGS) {
    const value = dicts[lang]?.[key]
    if (value !== undefined) result.fields[field][lang] = value
  }
}

writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8')
console.log('wrote ' + outPath)
for (const [field, dict] of Object.entries(result.fields)) {
  const langs = Object.keys(dict)
  console.log(`${field}: ${langs.length} langs  ${langs.map(l => `${l}=${JSON.stringify(dict[l])}`).join(' ')}`)
}
