/**
 * dsh-whale-paywall —— Host 半
 * ============================================================================
 * 两件事：
 *   ① 计费闸门：`web_search` / `web_fetch` 每次扣 1（有次数扣次数，否则扣鲸元），
 *      不够就 deny，让模型把「去商场买礼包」的话原样转告使用者。
 *   ② HTTP 接口：Client 半（商场页、弹窗）靠这几个路由读写同一份钱包。
 *
 * 为什么联网搜索必须在 Host 拦：它是模型的工具调用，浏览器侧根本没有那个时机。
 * 其余六个功能（新建会话 / 归档 / 进设置 / 启用插件 / 下载插件 / 切换模型）
 * 都是纯前端交互，在 client.js 里拦（Host 没有对应的「用户动作」事件）。
 *
 * ⚠️ webServer 只在有 Web GUI 的 profile 里存在，而且**异步就绪**：
 *    写进 `inject` 会让 headless profile 整条插件不激活（计费闸门跟着一起没），
 *    所以用 `ctx.inject([...], cb)` 运行时注入。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LABEL, PACKAGES, PRICE, openWallet } from './lib/wallet.mjs'

/** 联网类工具：这两个都算「一次联网搜索」。 */
const WEB_TOOLS = new Set(['web_search', 'web_fetch'])

/** 文案对照表的兜底（读不到 labels.json 时用，保证中英可用）。 */
const FALLBACK_LABELS = {
  newSessionLabel: { zh: '新建会话', en: 'New session' },
  newSessionText: { zh: '新会话', en: 'New Session' },
  archive: { zh: '归档会话', en: 'Archive session' },
  archiveAction: { zh: '归档会话', en: 'Archive' },
  settings: { zh: '设置', en: 'Settings' },
  settingsTrigger: { zh: '设置', en: 'Settings' },
  enableToggle: { zh: '启用 {name}', en: 'Enable {name}' },
  install: { zh: '安装', en: 'Install' },
  close: { zh: '关闭', en: 'Close' },
}

/**
 * 读 lib/labels.json（由 scripts/build-labels.mjs 从 DSH 自带文案生成）。
 * 读不到就退回中英兜底 —— 别人的电脑上也不会因此崩。
 */
function labelsForClient() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = JSON.parse(readFileSync(join(here, 'lib', 'labels.json'), 'utf8'))
    if (raw !== null && typeof raw === 'object' && raw.fields !== null && typeof raw.fields === 'object') {
      return raw.fields
    }
  } catch { /* 用兜底 */ }
  return FALLBACK_LABELS
}

/** Host 半不依赖任何服务；webServer / connection 都是运行时注入。 */
export function apply(ctx, config = {}) {
  const wallet = openWallet(config.walletFile || undefined)

  /* ─────────────── ① 联网工具计费闸门 ─────────────── */

  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    if (!WEB_TOOLS.has(exec.name)) return next()
    const q = wallet.quote('webSearch')
    if (!q.ok) {
      // deny 的 reason 会以 `Error: <reason>` 出现在模型看到的工具结果里，
      // 所以这句话是写给模型看的：让它如实转告，别自己编。
      return {
        kind: 'deny',
        reason: `鲸元不足：联网搜索每次 ${PRICE.webSearch} 鲸元，当前余额 ${q.costCoin === 0 ? 0 : wallet.read().coin} 鲸元。`
          + '请如实告诉使用者：到「设置 → 商场」购买新手礼包或礼包后重试，不要伪造搜索结果。',
        info: { name: 'WhaleWalletError', code: 'WHALE_QUOTA_EXHAUSTED', reason: 'webSearch quota = 0' },
      }
    }
    const paid = await wallet.spend('webSearch')
    if (!paid.ok) {
      return {
        kind: 'deny',
        reason: `鲸元不足：联网搜索每次 ${PRICE.webSearch} 鲸元。请提示使用者到「设置 → 商场」购买礼包后重试。`,
        info: { name: 'WhaleWalletError', code: 'WHALE_QUOTA_EXHAUSTED', reason: 'webSearch quota = 0' },
      }
    }
    return next()
  }, { prepend: true }), 'whale-paywall: web_search 计费闸门')

  /* ─────────────── ② HTTP 接口（Client 半读写钱包） ─────────────── */

  const sendJson = (res, code, body) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch { /* 客户端断了就算了 */ }
  }

  /** 只接本机同源：别的网页也能往 127.0.0.1 打，必须自己比一遍 Host / Origin。 */
  const sameOriginOk = (req) => {
    try {
      const host = String(req.headers?.host || '')
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
      const site = req.headers?.origin || req.headers?.referer
      if (!site) return true
      const url = new URL(site)
      if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(url.hostname)) return false
      return !url.port || url.port === String(host).split(':')[1]
    } catch { return false }
  }

  const readBody = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64 * 1024) req.destroy()
    })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })

  /** 商场页要的东西：钱包 + 价目表 + 礼包表。 */
  const snapshot = () => ({
    ok: true,
    wallet: wallet.read(),
    price: PRICE,
    label: LABEL,
    packages: PACKAGES,
    walletPath: wallet.path,
    // 界面文案对照表（8 种语言）。Client 用它在别人的语言环境里认出
    // 「新建会话 / Settings / Einstellungen」这些按钮，而不是只认中文。
    labels: labelsForClient(),
  })

  const mountRoutes = (ws) => {
    if (typeof ws?.register !== 'function') return
    ctx.effect(() => ws.register({
      kind: 'prefix',
      path: '/whale-paywall',
      handler: async (req, res) => {
        if (!sameOriginOk(req)) { sendJson(res, 403, { ok: false, error: '只接受本机同源请求' }); return }
        const url = new URL(req.url, 'http://127.0.0.1')
        const path = url.pathname.replace(/\/+$/, '')
        try {
          if (req.method === 'GET' && (path === '/whale-paywall' || path === '/whale-paywall/state')) {
            return sendJson(res, 200, snapshot())
          }
          if (req.method === 'POST' && path === '/whale-paywall/charge') {
            const body = await readBody(req)
            const feature = String(body?.feature || '')
            if (!(feature in PRICE)) return sendJson(res, 400, { ok: false, error: `未知功能：${feature}` })
            const result = await wallet.spend(feature)
            return sendJson(res, 200, { ok: result.ok, result, wallet: wallet.read() })
          }
          if (req.method === 'POST' && path === '/whale-paywall/buy') {
            const body = await readBody(req)
            const result = await wallet.buy(String(body?.id || ''))
            return sendJson(res, 200, { ...result, wallet: wallet.read() })
          }
          if (req.method === 'POST' && path === '/whale-paywall/recharge') {
            const body = await readBody(req)
            const result = await wallet.recharge(Number(body?.amount) || 0)
            return sendJson(res, 200, { ok: true, wallet: result.wallet })
          }
          if (req.method === 'POST' && path === '/whale-paywall/reset') {
            const body = await readBody(req)
            const result = body?.wallet === undefined ? await wallet.reset() : await wallet.replace(body.wallet)
            return sendJson(res, 200, { ok: true, wallet: result.wallet })
          }
          return sendJson(res, 404, { ok: false, error: `没有这个接口：${req.method} ${path}` })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }), 'whale-paywall: /whale-paywall 路由')
    ctx.logger?.('whale-paywall: 钱包接口已挂载 /whale-paywall')
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (sub) => {
        mountRoutes((typeof sub.get === 'function' ? sub.get('webServer') : undefined) || sub.webServer)
      })
    } catch { /* 没有 webServer 就只保留计费闸门 */ }
  }
}
