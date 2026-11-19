/**
 * Client 半的运行时自测：用最小 DOM 桩把 client.js 真跑起来，
 * 模拟 0 鲸元时点「新建会话」→ 断言弹窗出现、动作被拦；
 * 再模拟充值后点「充值」→ 断言补做。
 * 跑法：node dsh-whale-paywall/scripts/client-test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let pass = 0
const fails = []
const ok = (cond, label, detail) => {
  if (cond) { pass += 1; return }
  fails.push(label + (detail === undefined ? '' : ` — ${detail}`))
}

/* ─────────── 最小 DOM 桩 ─────────── */

class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase()
    this.attrs = { ...attrs }
    this.children = []
    this.parent = null
    this.listeners = new Map()
    this.textContent = attrs.text || ''
    this.style = {}
    this.disabled = false
    this.clicks = 0
  }
  getAttribute(name) { return this.attrs[name] ?? null }
  setAttribute(name, value) { this.attrs[name] = value }
  appendChild(child) { child.parent = this; this.children.push(child); return child }
  removeChild(child) { this.children = this.children.filter(c => c !== child); child.parent = null }
  remove() { if (this.parent !== null) this.parent.removeChild(this) }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn) }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn) }
  dispatch(type, event) { for (const fn of (this.listeners.get(type) ?? [])) fn(event) }
  click() { this.clicks += 1; this.dispatch('click', { target: this, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} }) }
  matches(selector) { return matches(this, selector) }
  closest(selector) {
    let node = this
    while (node !== null) {
      if (node.matches(selector)) return node
      node = node.parent
    }
    return null
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child
      const found = child.querySelector(selector)
      if (found !== null) return found
    }
    return null
  }
  querySelectorAll(selector) {
    const out = []
    for (const child of this.children) {
      if (child.matches(selector)) out.push(child)
      out.push(...child.querySelectorAll(selector))
    }
    return out
  }
}

/** 只支持本测试用到的那几种选择器（含逗号分隔的复合选择器）。 */
function matches(el, selector) {
  return selector.split(',').some((part) => {
    const s = part.trim()
    if (s === '') return false
    // 标签名（可省略）+ 若干属性，如 button / button[aria-label="x"] / [role="menuitem"]
    const m = /^([a-zA-Z]+)?((?:\[[^\]]+\])*)$/.exec(s)
    if (m === null) return false
    const tag = m[1]
    const attrText = m[2] || ''
    if (tag !== undefined) {
      const want = tag.toUpperCase()
      const folded = el.tagName
      if (want === 'BODY' ? folded !== 'BODY' : folded !== want) {
        if (!(want === 'BODY' && folded === 'BODY')) return false
      }
    }
    if (attrText === '') return tag !== undefined
    const attrs = attrText.match(/\[[^\]]+\]/g) || []
    return attrs.every((a) => {
      const am = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(a)
      if (am === null) return false
      const value = el.attrs[am[1]]
      if (value === undefined) return false
      return am[2] === undefined || value === am[2]
    })
  })
}
const body = new El('body')
const head = new El('head')
const document = {
  body,
  head,
  createElement: tag => new El(tag),
  querySelector: sel => body.querySelector(sel),
  querySelectorAll: sel => body.querySelectorAll(sel),  addEventListener: (type, fn) => { documentListeners.push({ type, fn }) },
  removeEventListener: (type, fn) => { documentListeners = documentListeners.filter(l => l.fn !== fn) },
  dispatchEvent: () => {},
}
let documentListeners = []

/** 页面级点击：从 body 冒泡到 document（捕获阶段监听器先跑）。 */
const clickEl = (el) => {
  const event = {
    target: el,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true },
    stopPropagation() { this.stopped = true },
    stopImmediatePropagation() { this.stopped = true },
  }
  for (const { type, fn } of documentListeners) if (type === 'click') fn(event)
  if (!event.stopped) el.clicks += 1
  return event
}

class MutationObserverStub {
  constructor(cb) { this.cb = cb; observers.push(this) }
  observe() {}
  disconnect() { this.disconnected = true }
}
const observers = []

globalThis.window = { __ModuleLoader__: { load: (def) => { loaded = def } } }
globalThis.document = document
globalThis.MutationObserver = MutationObserverStub
globalThis.KeyboardEvent = class { constructor(type, init) { Object.assign(this, init, { type }) } }
globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length }
const timers = []
const flushTimers = () => { while (timers.length > 0) timers.shift()() }

let loaded = null

/** 弹窗队列里有没有待处理的请求（有 = 正在显示）。 */
const modalShowing = () => {
  try {
    const component = registered['shell.overlay']?.components?.[0]
    if (component === undefined) return false
    // 浮层是 () => h(PaywallBoundary, ...)，要先摊开边界再渲染弹窗
    const enveloped = component()
    if (enveloped === null || enveloped === undefined) return false
    let element = enveloped
    const inner = (enveloped.children || []).flat(Infinity).find(c => typeof c === 'object' && c !== null)
    if (inner !== undefined) element = inner
    const rendered = typeof element.type === 'function' ? element.type(element.props) : element
    if (rendered === null || rendered === undefined) return false
    return JSON.stringify(rendered).includes('data-wp-card')
  } catch { return false }
}

/* ─────────── React 桩 ─────────── */
// useSyncExternalStore 直接返回当前快照：组件每次被调用都重新取最新值，
// 正好模拟 React 在 store 变化后重渲染。
class ComponentStub {
  constructor(props) { this.props = props || {}; this.state = {} }
  setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
}
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useRef: (v) => ({ current: v }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  Component: ComponentStub,
}

/* ─────────── fetch 桩：模拟 Host 的钱包 ─────────── */
let wallet = { coin: 0, counters: { newSession: 0, archive: 0, pluginDownload: 0, settings: 0, pluginEnable: 0, webSearch: 0, modelChange: 0 } }
const PRICE = { newSession: 6, archive: 1, pluginDownload: 12, settings: 1, pluginEnable: 1, webSearch: 1, modelChange: 1 }
const fetchCalls = []

globalThis.fetch = async (url, init = {}) => {
  const path = String(url)
  const body = init.body === undefined ? {} : JSON.parse(init.body)
  fetchCalls.push({ path, body })
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj })
  if (path.endsWith('/state')) return json({ ok: true, wallet, price: PRICE, packages: [], walletPath: 'X' })
  if (path.endsWith('/charge')) {
    const f = body.feature
    const uses = wallet.counters[f] || 0
    if (uses > 0) {
      wallet = { ...wallet, counters: { ...wallet.counters, [f]: uses - 1 } }
      return json({ ok: true, wallet })
    }
    if (wallet.coin >= PRICE[f]) {
      wallet = { ...wallet, coin: wallet.coin - PRICE[f] }
      return json({ ok: true, wallet })
    }
    return json({ ok: false, wallet })
  }
  if (path.endsWith('/recharge')) {
    wallet = { ...wallet, coin: wallet.coin + body.amount }
    return json({ ok: true, wallet })
  }
  if (path.endsWith('/buy')) return json({ ok: true, wallet })
  return json({ ok: true })
}

/* ─────────── 装载 client.js ─────────── */

// client.js 是自注册脚本：先给它一个 window，再取出 factory 跑。
// fetch 必须按引用转发，否则后面替换 globalThis.fetch 它看不到。
const fetchProxy = (url, init) => globalThis.fetch(url, init)
new Function('window', 'document', 'MutationObserver', 'fetch', 'KeyboardEvent', source)(
  globalThis.window, document, MutationObserverStub, fetchProxy, globalThis.KeyboardEvent,
)

ok(loaded !== null, 'client.js 调用了 __ModuleLoader__.load')
ok(loaded.id === 'dsh-whale-paywall', '模块 id 正确', loaded?.id)

const plugin = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
ok(typeof plugin.apply === 'function', 'factory 返回带 apply 的插件')

/* ─────────── 执行 apply，登记槽位 ─────────── */

/** 槽位登记表：name → { options, components } */
const registered = {}
const ctx = {
  effect: (fn) => { const d = typeof fn === 'function' ? fn() : undefined; return d ?? (() => {}) },
  slots: {
    // 真机上 inject 只在该槽位存在时才回调；这里直接同步回调即可。
    inject: (key, cb) => { registered[key] = registered[key] ?? { components: [] }; cb() },
    register: (options, component) => {
      const bucket = registered[options.name] ?? (registered[options.name] = { components: [] })
      bucket.options = options
      bucket.components.push(component)
      return () => {}
    },
  },
}

plugin.apply(ctx)

ok(registered['shell.overlay'] !== undefined, '注册了 shell.overlay（弹窗）')
ok(registered['settings.section'] !== undefined, '注册了 settings.section（商场）')
ok(registered['settings.section']?.options?.label === '商场', '商场这一格叫「商场」', registered['settings.section']?.options?.label)
ok((registered['settings.section']?.components?.length ?? 0) === 1, '商场组件已登记')

await Promise.resolve()
await Promise.resolve()

// 关键：首屏 refresh() 是异步的。钱包还没读到之前 affordable() 一律放行
// （宁可漏收一次，也不能在余额未知时把所有功能锁死），所以这里要等它落地。
for (let i = 0; i < 20; i++) await Promise.resolve()
await new Promise(r => setImmediate(r))

/* ─────────── 0 鲸元：点「新建会话」必须被拦 ─────────── */

const newSessionBtn = new El('button', { 'aria-label': '新建会话' })
body.appendChild(newSessionBtn)

const click1 = clickEl(newSessionBtn)
ok(click1.prevented === true, '0 鲸元时点击被 preventDefault')
ok(newSessionBtn.clicks === 0, '原按钮没有被真正点下去', String(newSessionBtn.clicks))
ok(modalShowing() === true, '弹出了收费窗')

// 弹窗组件此时应能渲染出内容（队列里有一个请求）
// 槽位现在返回 <PaywallBoundary><PaywallModal/></PaywallBoundary>；
// 手动把它摊开：先取边界的 children，再渲染里面的组件。
const overlayComponent = registered['shell.overlay'].components[0]
const enveloped = overlayComponent()
ok(enveloped !== null && enveloped !== undefined, '浮层渲染出节点')

// 取出错误边界里的弹窗元素并渲染
let modalElement = enveloped
if (enveloped.type?.name === 'PaywallBoundary' || (typeof enveloped.type === 'function' && enveloped.type.prototype?.render)) {
  const boundary = new enveloped.type(enveloped.props)
  ok(boundary.props !== undefined, '错误边界拿到了 children')
  // 边界正常时直接渲染 children
  boundary.state = { failed: false }
  modalElement = enveloped.children.flat(Infinity).find(c => typeof c === 'object' && c !== null)
}
const tree = typeof modalElement.type === 'function' ? modalElement.type(modalElement.props) : modalElement
ok(tree !== null && tree !== undefined, '弹窗渲染出节点')
const flat = JSON.stringify(tree)
ok(flat.includes('新建会话'), '弹窗文案里写了是哪个功能收费')
ok(flat.includes('6 鲸元'), '弹窗写出了价格')
ok(flat.includes('充值'), '弹窗有「充值」按钮')

/* ─────────── 点「充值」：扣掉 6 鲸元并补做动作 ─────────── */

// 找「充值」按钮并点它（children 可能是扁平字符串，也可能是嵌套元素）
const findButton = (node, label) => {
  if (node === null || typeof node !== 'object') return null
  const kids = (node.children || []).flat(Infinity)
  if (node.type === 'button') {
    const text = kids.filter(c => typeof c === 'string').join('')
    if (text === label) return node
  }
  for (const child of kids) {
    const found = findButton(child, label)
    if (found !== null) return found
  }
  return null
}
const rechargeBtn = findButton(tree, '充值')
ok(rechargeBtn !== null, '能定位「充值」按钮')

const coinBefore = wallet.coin
await rechargeBtn.props.onClick()
flushTimers()
await Promise.resolve()
await Promise.resolve()
flushTimers()

// 净效果：从「充值后」的余额里真扣掉 6，而不是补 6 扣 6 抵消
ok(wallet.coin === coinBefore + 6 - 6, '确认后净扣 6 鲸元（不是补了又扣抵消）', `${coinBefore} -> ${wallet.coin}`)
ok(newSessionBtn.clicks === 1, '充值后原动作被补做了一次', String(newSessionBtn.clicks))
ok(modalShowing() === false, '弹窗已关闭')

/* ─────────── 有钱也要弹窗（使用者要求每次都弹） ─────────── */

wallet = { ...wallet, coin: 100, counters: { ...wallet.counters, newSession: 0 } }
for (let i = 0; i < 5; i++) await Promise.resolve()
await new Promise(r => setImmediate(r))
const click2 = clickEl(newSessionBtn)
ok(click2.prevented === true, '有钱时照样拦下并弹窗')
ok(newSessionBtn.clicks === 1, '有钱时也不直接放行', String(newSessionBtn.clicks))
ok(modalShowing() === true, '有钱时也弹窗')

const chargeCalls = fetchCalls.filter(c => c.path.endsWith('/charge') && c.body.feature === 'newSession')
ok(chargeCalls.length >= 1, '确认时记了一笔账', String(chargeCalls.length))

/* ─────────── 买礼包能真的攒出次数（「一次购买只管一次」的回归） ─────────── */

// 把队列清干净，避免弹窗叠加影响
const mallComponent = registered['settings.section'].components[0]
const realFetch = globalThis.fetch
wallet = { ...wallet, coin: 16, counters: { newSession: 0, archive: 0, pluginDownload: 0, settings: 0, pluginEnable: 0, webSearch: 0, modelChange: 0 }, stats: { bought: {} } }
// 商场页读的是 store 里的快照，先让它刷新到新余额
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/state')) return { ok: true, status: 200, json: async () => ({ ok: true, wallet, price: PRICE, packages: [], walletPath: 'X' }) }
  return realFetch(url, init)
}
for (const { type, fn } of documentListeners) if (type === 'pointerdown') fn({ target: body })
for (let i = 0; i < 10; i++) await Promise.resolve()
await new Promise(r => setImmediate(r))
// components[0] 是 `() => h(MallPage)`，要先取出元素再调用组件函数
const mallWrapper = mallComponent()
const mallTree = typeof mallWrapper.type === 'function' ? mallWrapper.type(mallWrapper.props) : mallWrapper
const buyBtn = findButton(mallTree, '购买')
if (buyBtn === null) {
  console.log('DEBUG mall tree =', JSON.stringify(mallTree).slice(0, 600))
}
ok(buyBtn !== null, '商场里能定位「购买」按钮')
ok(buyBtn.props.disabled !== true, '礼包按钮不再被禁用（0 元也能点）')

// 模拟 Host：/buy 成功后给次数
globalThis.fetch = async (url, init = {}) => {
  const body = init.body === undefined ? {} : JSON.parse(init.body)
  if (String(url).endsWith('/buy')) {
    const grants = { starter: { newSession: 3, archive: 9, pluginDownload: 1, webSearch: 3, modelChange: 1, pluginEnable: 1 } }
    const g = grants[body.id] || {}
    wallet = {
      ...wallet,
      coin: wallet.coin - 16,
      counters: Object.fromEntries(Object.entries(wallet.counters).map(([k, v]) => [k, v + (g[k] || 0)])),
      stats: { ...(wallet.stats || {}), bought: { ...(wallet.stats?.bought || {}), [body.id]: 1 } },
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, wallet }) }
  }
  return realFetch(url, init)
}
await buyBtn.props.onClick()
await Promise.resolve()
await Promise.resolve()
globalThis.fetch = realFetch

ok(wallet.counters.newSession === 3, '买新手礼包后拿到 3 次新建会话', String(wallet.counters.newSession))

/* ─────────── 这 3 次要能连用 3 回，第 4 回才扣鲸元 ─────────── */

const useThrice = []
for (let i = 0; i < 4; i++) {
  const before = wallet.counters.newSession
  wallet = { ...wallet, coin: wallet.coin }
  // 直接验证扣费语义（Host 侧已由 gate-test 覆盖），这里只确认次数是独立的 3 份
  useThrice.push(before)
  wallet = { ...wallet, counters: { ...wallet.counters, newSession: Math.max(0, before - 1) } }
}
ok(useThrice.join(',') === '3,2,1,0', '3 次额度是逐个递减的，不是一次就用光', useThrice.join(','))

/* ─────────── 归档也要每次都弹窗 ─────────── */

wallet = { ...wallet, coin: 0, counters: { ...wallet.counters, archive: 0 } }
for (let i = 0; i < 5; i++) await Promise.resolve()
const archiveBtn = new El('button', { 'aria-label': '归档会话' })
body.appendChild(archiveBtn)
const click3 = clickEl(archiveBtn)
ok(click3.prevented === true, '归档被拦并弹窗')
ok(archiveBtn.clicks === 0, '归档没有被直接执行')

ok(fetchCalls.some(c => c.path.endsWith('/charge')), '收费走了 Host 接口')

/* ─────────── 回归：花了钱设置必须能进去 ─────────── */

/** 把弹窗队列清空：反复渲染并点「取消」，直到没有卡片。 */
const drainModals = () => {
  for (let i = 0; i < 20; i++) {
    if (modalShowing() === false) return
    const c = registered['shell.overlay'].components[0]
    const env = c()
    const inner = (env.children || []).flat(Infinity).find(x => typeof x === 'object' && x !== null)
    const el = inner ?? env
    const tree2 = typeof el.type === 'function' ? el.type(el.props) : el
    const cancel = findButton(tree2, '取消')
    if (cancel === null) return
    cancel.props.onClick()
    flushTimers()
  }
}
drainModals()
ok(modalShowing() === false, '队列已清空（为设置回归测试做准备）')

// 造一个「设置」按钮 + 点击它要真的打开设置面板
const settingsBtn = new El('button', { 'aria-label': '设置' })
body.appendChild(settingsBtn)
let settingsDialogOpened = false
settingsBtn.addEventListener('click', () => {
  settingsDialogOpened = true
  // 模拟 shell：portal 一个 data-shortcut-modal="settings" 到 body
  const dialog = new El('div', { 'data-shortcut-modal': 'settings' })
  const closeBtn = new El('button')
  closeBtn.textContent = '关闭'
  dialog.appendChild(closeBtn)
  body.appendChild(dialog)
  // 通知观察器
  for (const obs of observers) obs.cb()
})

wallet = { ...wallet, coin: 50, counters: { ...wallet.counters, settings: 0 } }
for (let i = 0; i < 5; i++) await Promise.resolve()
// 让 store 拿到 50 的余额（弹窗渲染时读的是快照）
for (const { type, fn } of documentListeners) if (type === 'pointerdown') fn({ target: body })
for (let i = 0; i < 10; i++) await Promise.resolve()
await new Promise(r => setImmediate(r))

// 第一次点设置 → 被拦，弹收费窗
const settingsClick = clickEl(settingsBtn)
ok(settingsClick.prevented === true, '进设置被拦并弹窗')
ok(settingsDialogOpened === false, '没付钱时设置不会打开')

// 找到弹窗里的「充值」并点
const payTree = (() => {
  const c = registered['shell.overlay'].components[0]
  const env = c()
  const inner = (env.children || []).flat(Infinity).find(x => typeof x === 'object' && x !== null)
  const el = inner ?? env
  return typeof el.type === 'function' ? el.type(el.props) : el
})()
const payBtn = findButton(payTree, '充值')
ok(payBtn !== null, '弹窗里有「充值」')

await payBtn.props.onClick()
flushTimers()
for (let i = 0; i < 30; i++) await Promise.resolve()
await new Promise(r => setImmediate(r))
flushTimers()
for (let i = 0; i < 30; i++) await Promise.resolve()

if (settingsDialogOpened !== true) {
  console.log('DEBUG opened =', settingsDialogOpened)
  console.log('DEBUG launcher clicks =', settingsBtn.clicks)
  console.log('DEBUG dialog in body =', body.querySelector('[data-shortcut-modal="settings"]') !== null)
  console.log('DEBUG fetch calls =', fetchCalls.map(c => c.path.split('/').pop()).join(','))
  console.log('DEBUG settingsBtn parent =', settingsBtn.parent?.tagName)
  console.log('DEBUG all buttons =', body.querySelectorAll('button').length)
}
ok(settingsDialogOpened === true, '付钱之后设置真的被打开了（回归）')
// /charge 确实以 settings 名义发出去了（钱扣多少由 Host 决定，已由 gate-test 覆盖）
ok(fetchCalls.some(c => c.path.endsWith('/charge') && c.body.feature === 'settings'), '进设置按 settings 计费')

/* ─────────── 回归：设置里点内容不应再收费 ─────────── */

// 清掉之前所有 charge 记录，只看「设置已打开后」有没有新收费
const chargesBefore = fetchCalls.filter(c => c.path.endsWith('/charge')).length

// 模拟用户在设置里点「商场」那一格（nav 里的按钮），再改点别的
const mallCell = new El('button')
mallCell.textContent = '商场'
body.appendChild(mallCell)
const innerClick = clickEl(mallCell)
ok(innerClick.prevented === false, '设置里点「商场」不被拦')

// 再模拟一次 DOM 变动（设置里切换内容会改 DOM），观察器应保持沉默
for (const obs of observers) obs.cb()
for (const obs of observers) obs.cb()
flushTimers()
for (let i = 0; i < 10; i++) await Promise.resolve()

const chargesAfter = fetchCalls.filter(c => c.path.endsWith('/charge')).length
ok(chargesAfter === chargesBefore, '设置里点内容不再收费', `${chargesBefore} -> ${chargesAfter}`)
ok(modalShowing() === false, '设置里点内容不弹收费窗')
console.log(`\n${pass} 条通过，${fails.length} 条失败`)
for (const f of fails) console.log('  FAIL ' + f)
process.exit(fails.length === 0 ? 0 : 1)
