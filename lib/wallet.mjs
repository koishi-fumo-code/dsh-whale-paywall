/**
 * 鲸元钱包 —— 唯一数据源（Host 与 Client 都读写这一份）
 * ============================================================================
 * 放 `$DSH_HOME/whale-paywall.wallet.json`，用 Node 的 fs 直接读写：
 *   · Host 半（付钱门槛、web_search 拦截）直接调 read()/spend()；
 *   · Client 半走 HTTP（/whale-paywall/*）读写同一个文件。
 *
 * 为什么不用 storageDomain / settings：这个插件的 Host 半只需要一个很小的
 * JSON，两条路径都能跑（headless 没有 webServer 也不影响计费）；且文件坏了
 * 能直接手改。写用「临时文件 + rename」保证不会读到半个 JSON。
 *
 * 计费规则（2026-11-18 使用者确认）：
 *   有次数先用次数 → 没次数再扣鲸元 → 都不够才拦。
 *   单次价格：新建会话 6 / 归档 1 / 下载插件 12 / 进入设置 1 /
 *             启用插件 1 / 联网搜索 1 / 切换模型 1（单位：鲸元）
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 七个收费功能：键名同时是次数键名和 HTTP 接口里的字面量。 */
export const FEATURES = /** @type {const} */ ([
  'newSession', 'archive', 'pluginDownload', 'settings', 'pluginEnable', 'webSearch', 'modelChange',
])

/** 每个功能的单次鲸元价格。 */
export const PRICE = {
  newSession: 6,
  archive: 1,
  pluginDownload: 12,
  settings: 1,
  pluginEnable: 1,
  webSearch: 1,
  modelChange: 1,
}

/** 中文名，用于弹窗与 Host 侧 deny 文案。 */
export const LABEL = {
  newSession: '新建会话',
  archive: '归档会话',
  pluginDownload: '下载插件',
  settings: '进入设置',
  pluginEnable: '启用插件',
  webSearch: '联网搜索',
  modelChange: '切换模型',
}

/**
 * 商场礼包。`grant` 是买到手的次数（按功能分）；`coin` 是礼包价格。
 * 新手礼包是唯一带「混合」次数的礼包，其余都是单功能。
 */
export const PACKAGES = [
  {
    id: 'starter',
    name: '新手礼包',
    coin: 16,
    tagline: '什么都来一点，最划算',
    grant: { newSession: 3, archive: 9, pluginDownload: 1, webSearch: 3, modelChange: 1, pluginEnable: 1, settings: 0 },
  },
  {
    id: 'session',
    name: '新建会话礼包',
    coin: 30,
    tagline: '6 次新建会话',
    grant: { newSession: 6, archive: 0, pluginDownload: 0, webSearch: 0, modelChange: 0, pluginEnable: 0, settings: 0 },
  },
  {
    id: 'archive',
    name: '归档礼包',
    coin: 6,
    tagline: '10 次归档',
    grant: { newSession: 0, archive: 10, pluginDownload: 0, webSearch: 0, modelChange: 0, pluginEnable: 0, settings: 0 },
  },
  {
    id: 'plugin',
    name: '下载插件礼包',
    coin: 60,
    tagline: '10 次下载插件',
    grant: { newSession: 0, archive: 0, pluginDownload: 10, webSearch: 0, modelChange: 0, pluginEnable: 0, settings: 0 },
  },
]

/** 新钱包的初始鲸元。使用者 2026-11-18 定：初始 50 鲸元。 */
export const INITIAL_COIN = 50

const emptyCounters = () => Object.fromEntries(FEATURES.map(key => [key, 0]))

/** @returns 一份全新的钱包对象 */
export function newWallet() {
  return {
    version: 1,
    coin: INITIAL_COIN,
    counters: emptyCounters(),
    /** 累计统计，只用于商场页展示。 */
    stats: { spentCoin: 0, spentUses: 0, bought: {} },
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 把任意读到的对象修补成合法钱包（缺字段补 0 / 负数归零 / 类型不对就丢）。
 * @param {unknown} raw 从磁盘或 HTTP 读到的原始值
 * @returns 合法钱包
 */
export function normalize(raw) {
  const base = newWallet()
  if (raw === null || typeof raw !== 'object') return base
  const src = /** @type {Record<string, any>} */ (raw)
  const coin = Number(src.coin)
  if (Number.isFinite(coin)) base.coin = Math.max(0, Math.trunc(coin))
  for (const key of FEATURES) {
    const value = Number(src.counters?.[key])
    if (Number.isFinite(value)) base.counters[key] = Math.max(0, Math.trunc(value))
  }
  const spentCoin = Number(src.stats?.spentCoin)
  if (Number.isFinite(spentCoin)) base.stats.spentCoin = Math.max(0, Math.trunc(spentCoin))
  const spentUses = Number(src.stats?.spentUses)
  if (Number.isFinite(spentUses)) base.stats.spentUses = Math.max(0, Math.trunc(spentUses))
  if (src.stats?.bought !== null && typeof src.stats?.bought === 'object') {
    for (const [id, n] of Object.entries(src.stats.bought)) {
      const value = Number(n)
      if (Number.isFinite(value) && value > 0) base.stats.bought[id] = Math.trunc(value)
    }
  }
  if (typeof src.updatedAt === 'string') base.updatedAt = src.updatedAt
  return base
}

/**
 * 打开一个钱包文件。所有读改写都进同一条串行队列：
 * `web_search` 可能在一步里并发好几次，读-改-写不串行会超支。
 * @param {string} [file] 钱包文件绝对路径；省略时用 `$DSH_HOME/whale-paywall.wallet.json`
 */
export function openWallet(file) {
  const path = file || defaultWalletPath()
  /** @type {ReturnType<typeof newWallet>} */
  let state = normalize(readRaw(path))
  let queue = Promise.resolve()
  /** 上次读到/写下的文件 mtime：变了说明文件被外部改过，要重读。 */
  let stamp = mtimeOf(path)

  const persist = () => {
    state.updatedAt = new Date().toISOString()
    try {
      mkdirSync(join(path, '..'), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      renameSync(tmp, path)
      stamp = mtimeOf(path)
    } catch {
      /* 写盘失败就只留在内存里：宁可本次会话能继续，也不要因为磁盘问题把功能全锁死 */
    }
  }

  /**
   * 外部改了文件（手改、另一个进程写的）就重读一次。
   * 每次读写前都调，这样「自己改 json 加钱」也立刻生效。
   */
  const syncFromDisk = () => {
    const now = mtimeOf(path)
    if (now === stamp) return
    stamp = now
    const raw = readRaw(path)
    if (raw !== null) state = normalize(raw)
  }

  /** 串行执行一个读改写操作。 */
  const serial = (fn) => {
    const run = queue.then(() => { syncFromDisk(); return fn() }, () => { syncFromDisk(); return fn() })
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    path,

    /** @returns 钱包的只读快照（深拷贝，外面改不动内部状态）。 */
    read() {
      syncFromDisk()
      return JSON.parse(JSON.stringify(state))
    },

    /**
     * 能不能做这个功能（不改状态）。
     * @param {keyof PRICE} feature
     * @returns {{ ok: boolean, via: 'uses' | 'coin' | 'blocked', costCoin: number, uses: number }}
     */
    quote(feature) {
      syncFromDisk()
      const uses = state.counters[feature] || 0
      if (uses > 0) return { ok: true, via: 'uses', costCoin: 0, uses }
      const price = PRICE[feature]
      if (state.coin >= price) return { ok: true, via: 'coin', costCoin: price, uses: 0 }
      return { ok: false, via: 'blocked', costCoin: price, uses: 0 }
    },

    /**
     * 真扣一次。有次数扣次数，没次数扣鲸元；都不够返回 false 且不动状态。
     * @param {keyof PRICE} feature
     * @returns {Promise<{ ok: boolean, via: 'uses' | 'coin' | 'blocked', costCoin: number, coin: number, uses: number }>}
     */
    spend(feature) {
      return serial(() => {
        const q = this.quote(feature)
        if (!q.ok) return { ok: false, via: /** @type {const} */ ('blocked'), costCoin: q.costCoin, coin: state.coin, uses: 0 }
        if (q.via === 'uses') {
          state.counters[feature] = q.uses - 1
          state.stats.spentUses += 1
        } else {
          state.coin -= q.costCoin
          state.stats.spentCoin += q.costCoin
        }
        persist()
        return { ok: true, via: q.via, costCoin: q.costCoin, coin: state.coin, uses: state.counters[feature] }
      })
    },

    /**
     * 买一个礼包：扣鲸元、加次数。
     * @param {string} packageId
     * @returns 结果；鲸元不够时 ok:false
     */
    buy(packageId) {
      return serial(() => {
        const pack = PACKAGES.find(p => p.id === packageId)
        if (pack === undefined) return { ok: false, error: '没有这个礼包', wallet: this.read() }
        if (state.coin < pack.coin) {
          return { ok: false, error: `鲸元不足（还差 ${pack.coin - state.coin} 鲸元）`, wallet: this.read() }
        }
        state.coin -= pack.coin
        for (const [key, n] of Object.entries(pack.grant)) {
          if (n > 0) state.counters[key] = (state.counters[key] || 0) + n
        }
        state.stats.bought[pack.id] = (state.stats.bought[pack.id] || 0) + 1
        persist()
        return { ok: true, pack: pack.id, wallet: this.read() }
      })
    },

    /**
     * 充值鲸元（弹窗里的「充值」按钮）。不真收钱，只是加数字。
     * @param {number} amount
     */
    recharge(amount) {
      return serial(() => {
        const n = Math.max(0, Math.trunc(Number(amount) || 0))
        state.coin += n
        persist()
        return { ok: true, added: n, wallet: this.read() }
      })
    },

    /** 重置成初始钱包（商场页的调试入口）。 */
    reset() {
      return serial(() => {
        state = newWallet()
        persist()
        return { ok: true, wallet: this.read() }
      })
    },

    /** 重置成任意指定状态（自测用）。 */
    replace(next) {
      return serial(() => {
        state = normalize(next)
        persist()
        return { ok: true, wallet: this.read() }
      })
    },
  }
}

/** `$DSH_HOME/whale-paywall.wallet.json`，没有 DSH_HOME 时退回 `~/.dsh`。 */
export function defaultWalletPath() {
  const home = process.env.DSH_HOME
    || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return join(home, 'whale-paywall.wallet.json')
}

/** 读文件；不存在或坏了都返回 null（上层会当成新钱包）。 */
function readRaw(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 文件的 mtime；不存在返回 -1。 */
function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return -1
  }
}
