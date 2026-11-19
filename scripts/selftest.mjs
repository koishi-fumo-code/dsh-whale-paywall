/**
 * 钱包逻辑自测（隔离 DSH_HOME，绝不碰真库）。
 * 跑法：node dsh-whale-paywall/scripts/selftest.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'whale-paywall-selftest-'))
process.env.DSH_HOME = home

const { openWallet, PACKAGES, PRICE, FEATURES } = await import('../lib/wallet.mjs')

let pass = 0
const fails = []
const ok = (cond, label, detail) => {
  if (cond) { pass += 1; return }
  fails.push(label + (detail === undefined ? '' : ` — ${detail}`))
}

const walletPath = join(home, 'whale-paywall.wallet.json')
const w = openWallet(walletPath)

// ① 新钱包：初始 50 鲸元，0 次数
ok(w.read().coin === 50, '新钱包初始 50 鲸元', String(w.read().coin))
ok(FEATURES.every(k => w.read().counters[k] === 0), '新钱包次数全为 0')

// ② 次数为 0，但鲸元够 ⇒ 按单价扣鲸元
ok(w.quote('newSession').ok === true, '有 50 鲸元时新建会话放行')
const paidFirst = await w.spend('newSession')
ok(paidFirst.via === 'coin', '首次走鲸元（没有次数）')
ok(w.read().coin === 50 - PRICE.newSession, '扣了 6 鲸元', String(w.read().coin))

// ②b 钱花光后必须拦
const broke = openWallet(join(home, 'broke.json'))
await broke.replace({ version: 1, coin: 0, counters: {} })
ok(broke.quote('newSession').ok === false, '0 鲸元时新建会话被拦')
ok((await broke.spend('newSession')).ok === false, 'spend 在不够时返回 false')
ok(broke.read().coin === 0, 'spend 失败不改状态')

// ③ 充值后按价格扣鲸元
await w.recharge(100)
ok(w.read().coin === 44 + 100, '充值 100 到账', String(w.read().coin))
const paid = await w.spend('newSession')
ok(paid.ok === true && paid.via === 'coin', '新建会话走鲸元')
ok(paid.costCoin === PRICE.newSession, `扣了 ${PRICE.newSession} 鲸元`, String(paid.costCoin))
ok(w.read().coin === 144 - PRICE.newSession, '鲸元余额正确', String(w.read().coin))

// ④ 买礼包：拿次数，且之后优先扣次数而不是鲸元
const coinBefore = w.read().coin
const bought = await w.buy('session')
ok(bought.ok === true, '买新建会话礼包')
ok(w.read().coin === coinBefore - 30, '礼包扣 30 鲸元')
ok(w.read().counters.newSession === 6, '礼包给 6 次新建会话')
const useSpend = await w.spend('newSession')
ok(useSpend.via === 'uses', '有次数时优先扣次数')
ok(w.read().counters.newSession === 5, '次数减到 5')
ok(w.read().coin === coinBefore - 30, '扣次数时不动鲸元')

// ⑤ 鲸元不够买礼包（把初始 50 清掉再试）
const poor = openWallet(join(home, 'poor.json'))
await poor.replace({ version: 1, coin: 0, counters: {} })
ok((await poor.buy('plugin')).ok === false, '0 鲸元买不了下载插件礼包')

// ⑥ 新手礼包给的是混合次数（初始 50 已经够 16，直接买）
const rich = openWallet(join(home, 'rich.json'))
ok(rich.read().coin === 50, 'rich 钱包也是初始 50 鲸元', String(rich.read().coin))
const starter = await rich.buy('starter')
ok(starter.ok === true, '50 鲸元买得起新手礼包')
ok(rich.read().coin === 50 - 16, '买新手礼包后剩 34 鲸元', String(rich.read().coin))
const c = rich.read().counters
ok(c.newSession === 3 && c.archive === 9 && c.pluginDownload === 1, '新手礼包：3 会话 / 9 归档 / 1 插件', JSON.stringify(c))
ok(c.webSearch === 3 && c.modelChange === 1 && c.pluginEnable === 1, '新手礼包：3 搜索 / 1 换模型 / 1 启用插件', JSON.stringify(c))

// ⑦ 串行：并发扣费不能超支
const race = openWallet(join(home, 'race.json'))
await race.replace({ version: 1, coin: 3, counters: {} })
const results = await Promise.all([race.spend('webSearch'), race.spend('webSearch'), race.spend('webSearch'), race.spend('webSearch')])
const succeeded = results.filter(r => r.ok).length
ok(succeeded === 3, '并发 4 次只有 3 次成功（3 鲸元）', `成功 ${succeeded} 次`)
ok(race.read().coin === 0, '并发后余额正好 0', String(race.read().coin))

// ⑧ 落盘 + 重新打开能读回来
const persisted = JSON.parse(readFileSync(walletPath, 'utf8'))
ok(persisted.version === 1, '钱包写了版本号')
ok(persisted.counters.newSession === 5, '磁盘上的次数字段正确', String(persisted.counters.newSession))
const reopened = openWallet(walletPath)
ok(reopened.read().counters.newSession === 5, '重新打开读到同样的次数')

// ⑨ 坏文件不炸（当成新钱包 ⇒ 初始 50 鲸元）
const { writeFileSync } = await import('node:fs')
writeFileSync(join(home, 'broken.json'), '{ this is not json', 'utf8')
const broken = openWallet(join(home, 'broken.json'))
ok(broken.read().coin === 50, '坏文件当成新钱包（初始 50），不抛异常', String(broken.read().coin))

// ⑩ 负数/垃圾数据被归一化
const dirty = openWallet(join(home, 'dirty.json'))
await dirty.replace({ coin: -50, counters: { webSearch: -3, archive: 'abc' } })
ok(dirty.read().coin === 0, '负鲸元归零')
ok(dirty.read().counters.webSearch === 0, '负次数归零')
ok(dirty.read().counters.archive === 0, '非数字次数归零')

rmSync(home, { recursive: true, force: true })

console.log(`\n${pass} 条通过，${fails.length} 条失败`)
for (const f of fails) console.log('  FAIL ' + f)
process.exit(fails.length === 0 ? 0 : 1)
