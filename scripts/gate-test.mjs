/**
 * Host 半闸门的隔离自测：用一个假 ctx 把 apply() 跑起来，
 * 直接喂 tools/pre-execute 事件看它 allow / deny。
 * 跑法：node dsh-whale-paywall/scripts/gate-test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'whale-gate-'))
process.env.DSH_HOME = home
process.env.WHALE_TEST_WALLET = join(home, 'wallet.json')

const { apply } = await import('../index.js')
const { openWallet } = await import('../lib/wallet.mjs')

let pass = 0
const fails = []
const ok = (cond, label, detail) => {
  if (cond) { pass += 1; return }
  fails.push(label + (detail === undefined ? '' : ` — ${detail}`))
}

// ── 假 ctx：只实现 apply() 用到的那几样
const listeners = []
const effects = []
const ctx = {
  effect(fn, label) {
    const dispose = typeof fn === 'function' ? fn() : undefined
    effects.push({ label, dispose })
    return dispose ?? (() => {})
  },
  on(event, handler) {
    listeners.push({ event, handler })
    return () => {}
  },
  inject(_services, callback) { callback({ get: () => undefined }) },
}

apply(ctx, { walletFile: process.env.WHALE_TEST_WALLET })

const preExecute = listeners.find(l => l.event === 'tools/pre-execute')
ok(preExecute !== undefined, '注册了 tools/pre-execute 监听')
if (preExecute === undefined) { console.log('FAIL 没有监听，后面没法测'); process.exit(1) }

/** 跑一次工具调用，返回决策。 */
const run = async (name) => preExecute.handler(
  { name, callId: 'c1', arguments: {}, agent: undefined, signal: new AbortController().signal },
  async () => ({ kind: 'allow' }),
)

// ① 非联网工具直接放行，不扣钱
const wallet = openWallet(process.env.WHALE_TEST_WALLET)
const before = wallet.read().coin
const readDecision = await run('read')
ok(readDecision.kind === 'allow', 'read 工具放行')
ok(wallet.read().coin === before, '非联网工具不扣钱')

// ② 先把钱清零，验证「什么都没有时」被 deny
await wallet.replace({ version: 1, coin: 0, counters: {} })
const denied = await run('web_search')
ok(denied.kind === 'deny', '0 鲸元时 web_search 被拦', JSON.stringify(denied))
ok(typeof denied.reason === 'string' && denied.reason.includes('商场'), 'deny 文案指向商场', denied.reason)
ok(denied.info?.code === 'WHALE_QUOTA_EXHAUSTED', 'deny 带稳定错误码', JSON.stringify(denied.info))

// ③ 充值后放行，且扣了 1 鲸元
await wallet.recharge(10)
const allowed = await run('web_search')
ok(allowed.kind === 'allow', '有鲸元时 web_search 放行')
ok(wallet.read().coin === 9, '每次联网搜索扣 1 鲸元', String(wallet.read().coin))

// ④ web_fetch 也算一次
const fetchDecision = await run('web_fetch')
ok(fetchDecision.kind === 'allow', 'web_fetch 放行')
ok(wallet.read().coin === 8, 'web_fetch 也扣 1 鲸元', String(wallet.read().coin))

// ⑤ 有次数时优先扣次数、不动鲸元
await wallet.recharge(100)
await wallet.buy('starter')
const coinAfterBuy = wallet.read().coin
const usesBefore = wallet.read().counters.webSearch
ok(usesBefore === 3, '新手礼包给 3 次联网搜索', String(usesBefore))
const useDecision = await run('web_search')
ok(useDecision.kind === 'allow', '有次数时放行')
ok(wallet.read().counters.webSearch === 2, '扣的是次数', String(wallet.read().counters.webSearch))
ok(wallet.read().coin === coinAfterBuy, '扣次数时不动鲸元', String(wallet.read().coin))

// ⑥ 并发：3 次额度并发 5 次调用，只能过 3 次
await wallet.replace({ version: 1, coin: 0, counters: { webSearch: 3 } })
const results = await Promise.all([run('web_search'), run('web_search'), run('web_search'), run('web_search'), run('web_search')])
const allowedCount = results.filter(r => r.kind === 'allow').length
ok(allowedCount === 3, '并发 5 次只有 3 次通过', `通过 ${allowedCount} 次`)
ok(wallet.read().counters.webSearch === 0, '并发后次数归零', String(wallet.read().counters.webSearch))

rmSync(home, { recursive: true, force: true })
console.log(`\n${pass} 条通过，${fails.length} 条失败`)
for (const f of fails) console.log('  FAIL ' + f)
process.exit(fails.length === 0 ? 0 : 1)
