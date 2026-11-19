window.__ModuleLoader__.load({
  id: 'dsh-whale-paywall',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useSyncExternalStore } = React

    const API = '/whale-paywall'

    /* ═══════════════════════ 多语言文案对照 ═══════════════════════ */

    /**
     * DSH 自带 8 种语言，界面上的「新建会话 / 归档会话 / 设置」等文案
     * 会跟着使用者的语言变。写死中文只能在中文环境跑，换台电脑就全失效。
     *
     * 这里的 `LABELS` 由 Host 从 `lib/labels.json` 通过 /state 下发（覆盖 8 种语言）；
     * 下面这份是内置兜底，保证「Host 还没应答」或「老版本 Host」时也能认中英两种。
     * 匹配时把某个字段的全部译文放进 Set 里逐个比，不再依赖任何单一语言。
     */
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

    /** 当前生效的文案表（Host 下发后覆盖内置兜底）。 */
    let LABELS = FALLBACK_LABELS

    /**
     * 取某个字段在所有语言下的译文集合。
     * 占位符 `{name}` 有两种位置，都要处理：
     *   'Enable {name}'   → 前缀 `Enable`
     *   '{name}を有効化'  → 后缀 `を有効化`（日语就是这样）
     * 所以这里同时产出「去掉占位符后的整串」和「占位符两侧的片段」。
     * @param {string} field
     * @returns {string[]} 已 trim、去空、去重
     */
    const allOf = (field) => {
      const dict = LABELS[field] || FALLBACK_LABELS[field] || {}
      const set = new Set()
      for (const value of Object.values(dict)) {
        if (typeof value !== 'string') continue
        const whole = value.replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim()
        if (whole !== '') set.add(whole)
        // 占位符在前时（'{name}を有効化'），要的是它后面的部分
        const tail = value.replace(/^\{[^}]*\}\s*/, '').trim()
        if (tail !== '' && tail !== whole) set.add(tail)
      }
      return [...set]
    }

    /**
     * 某个可见文本是否命中某字段的任一语言译文。
     * @param {string} field
     * @param {string} text
     */
    const matchesLabel = (field, text) => {
      const value = String(text || '').trim()
      if (value === '') return false
      return allOf(field).some((candidate) => {
        // 完整相等
        if (value === candidate) return true
        // 前缀式：'Enable MyPlugin'
        if (value.startsWith(candidate + ' ')) return true
        // 后缀式：'MyPluginを有効化'（占位符在前的语言）
        if (value.endsWith(candidate)) return true
        return false
      })
    }

    /* ═══════════════════════ 计费项目 ═══════════════════════ */

    const FEATURES = ['newSession', 'archive', 'pluginDownload', 'settings', 'pluginEnable', 'webSearch', 'modelChange']

    const LABEL = {
      newSession: '新建会话',
      archive: '归档会话',
      pluginDownload: '下载插件',
      settings: '进入设置',
      pluginEnable: '启用插件',
      webSearch: '联网搜索',
      modelChange: '切换模型',
    }

    const PRICE = {
      newSession: 6,
      archive: 1,
      pluginDownload: 12,
      settings: 1,
      pluginEnable: 1,
      webSearch: 1,
      modelChange: 1,
    }

    const UNIT = {
      newSession: '次新建会话',
      archive: '次归档',
      pluginDownload: '次下载插件',
      settings: '次进入设置',
      pluginEnable: '次启用插件',
      webSearch: '次联网搜索',
      modelChange: '次切换模型',
    }

    /* ═══════════════════════ 钱包状态 ═══════════════════════ */

    /**
     * 全局钱包快照。Host 是唯一数据源；这里只是一份缓存，任何一次
     * 收费 / 购买 / 充值后都用返回值刷新，不做本地加减，避免和 Host 打架。
     */
    const store = {
      snapshot: { status: 'loading', wallet: null, price: PRICE, packages: [], walletPath: '', error: '' },
      listeners: new Set(),
      emit() { for (const fn of this.listeners) fn() },
      set(next) { this.snapshot = { ...this.snapshot, ...next }; this.emit() },
      get() { return this.snapshot },
      subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
    }

    const api = async (path, init) => {
      const res = await fetch(API + path, { credentials: 'same-origin', ...init })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || ('HTTP ' + res.status))
      return body
    }

    let inflight = null
    const refresh = () => {
      if (inflight !== null) return inflight
      inflight = api('/state')
        .then((body) => {
          // Host 下发的文案表覆盖内置兜底，这样别人的语言环境也能认出来
          if (body.labels !== null && typeof body.labels === 'object') LABELS = body.labels
          store.set({
            status: 'ready',
            wallet: body.wallet,
            price: body.price || PRICE,
            packages: body.packages || [],
            walletPath: body.walletPath || '',
            error: '',
          })
          return body
        })
        .catch((error) => {
          store.set({ status: 'error', error: String(error?.message ?? error) })
          return null
        })
        .finally(() => { inflight = null })
      return inflight
    }

    /** 有没有这个功能的额度（不改状态）。 */
    const affordable = (wallet, feature) => {
      if (wallet === null || wallet === undefined) return true   // 还不知道余额时不要挡人
      const uses = wallet.counters?.[feature] || 0
      if (uses > 0) return true
      return (wallet.coin || 0) >= (PRICE[feature] || 0)
    }

    /** 真扣一次。失败说明 Host 那边判定不够，弹窗兜住。 */
    const charge = async (feature) => {
      try {
        const body = await api('/charge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ feature }),
        })
        store.set({ wallet: body.wallet, status: 'ready' })
        return body.ok === true
      } catch {
        return true   // 接口挂了就别把功能也锁死
      }
    }

    /* ═══════════════════════ 弹窗 ═══════════════════════ */

    /** 一个待处理的拦截请求；同一时间只显示一个，后来的排在后面。 */
    const modal = {
      queue: [],
      listeners: new Set(),
      emit() { for (const fn of this.listeners) fn() },
      open(request) { this.queue = [...this.queue, request]; this.emit() },
      close() { this.queue = this.queue.slice(1); this.emit() },
      get() { return this.queue },
      subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
    }

    // useSyncExternalStore 要求 subscribe/getSnapshot 的引用稳定，所以先绑好。
    const subscribeModal = fn => modal.subscribe(fn)
    const getModalSnapshot = () => modal.queue
    const subscribeStore = fn => store.subscribe(fn)
    const getStoreSnapshot = () => store.snapshot

    /** 问一次：有额度就直接办，没额度（或 Host 拒绝）就弹窗并把 payload 交还给「充值」。 */
    const gate = async (feature, payload) => {
      await refresh()
      const { wallet } = store.get()
      if (affordable(wallet, feature)) {
        if (await charge(feature)) return { ok: true }
      }
      modal.open({ feature, payload })
      return { ok: false }
    }

    const MODAL_CSS = `
[data-wp-mask]{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
  background:var(--dsw-alias-bg-overlay,rgba(8,12,20,.42));pointer-events:none;}
[data-wp-card]{pointer-events:auto;width:min(420px,calc(100vw - 48px));border-radius:16px;padding:22px 22px 18px;
  background:var(--dsw-alias-bg-layer-1,#1b1f27);color:var(--dsw-alias-label-primary,#e8edf5);
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));
  box-shadow:0 24px 64px rgba(0,0,0,.45);font-size:13px;line-height:1.6;}
[data-wp-badge]{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:.06em;
  padding:3px 9px;border-radius:999px;color:#ffd166;background:rgba(255,209,102,.14);margin-bottom:12px;}
[data-wp-title]{font-size:16px;font-weight:650;margin:0 0 6px;}
[data-wp-why]{color:var(--dsw-alias-label-secondary,#b6c0cf);margin:0 0 14px;}
[data-wp-quote]{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;margin:0 0 14px;
  border-radius:12px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));}
[data-wp-quote-feature]{font-weight:600;}
[data-wp-quote-price]{font-variant-numeric:tabular-nums;color:#ffd166;font-weight:650;}
[data-wp-balance]{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b96a6);margin:0 0 16px;}
[data-wp-actions]{display:flex;gap:10px;justify-content:flex-end;}
[data-wp-btn]{height:34px;padding:0 16px;font-size:13px;border-radius:9px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:inherit;}
[data-wp-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));}
[data-wp-btn][data-primary]{border-color:transparent;background:#3b82f6;color:#fff;font-weight:600;}
[data-wp-btn][data-primary]:hover{background:#2f6fdc;}
[data-wp-btn][data-primary]:disabled{opacity:.55;cursor:default;}

[data-wp-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 10px;max-width:680px;}
[data-wp-h]{font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary,#8b96a6);margin-bottom:8px;}
[data-wp-balance-card]{display:flex;align-items:baseline;gap:10px;padding:16px 18px;border-radius:14px;
  background:linear-gradient(135deg,rgba(59,130,246,.18),rgba(255,209,102,.10));
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));}
[data-wp-balance-num]{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums;color:#ffd166;line-height:1;}
[data-wp-balance-unit]{font-size:13px;color:var(--dsw-alias-label-secondary,#b6c0cf);}
[data-wp-uses]{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;}
[data-wp-use]{display:flex;justify-content:space-between;gap:10px;padding:9px 12px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));}
[data-wp-use-name]{font-size:12px;}
[data-wp-use-count]{font-size:12px;font-variant-numeric:tabular-nums;font-weight:600;}
[data-wp-use-count][data-zero]{color:var(--dsw-alias-state-error-primary,#ef5350);}
[data-wp-packs]{display:flex;flex-direction:column;gap:10px;}
[data-wp-pack]{display:flex;gap:14px;align-items:center;padding:14px 16px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));}
[data-wp-pack-copy]{flex:1;min-width:0;}
[data-wp-pack-name]{font-size:13px;font-weight:650;}
[data-wp-pack-tag]{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b96a6);}
[data-wp-pack-grant]{font-size:11px;color:var(--dsw-alias-label-secondary,#b6c0cf);margin-top:4px;}
[data-wp-pack-price]{font-size:14px;font-weight:700;color:#ffd166;font-variant-numeric:tabular-nums;white-space:nowrap;}
[data-wp-msg]{font-size:12px;padding:8px 12px;border-radius:9px;background:rgba(127,127,127,.12);}
[data-wp-msg][data-good]{background:rgba(34,197,94,.16);color:#41c977;}
[data-wp-msg][data-warn]{background:rgba(239,83,80,.16);color:#ef7a77;}
[data-wp-row]{display:flex;gap:10px;flex-wrap:wrap;}
`

    /**
     * 弹窗的错误边界。任何渲染/点击里的异常都在这里被吃掉并重置队列，
     * 保证「浮层锁屏」这件事在结构上不可能发生。
     */
    class PaywallBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
        this.reset = this.reset.bind(this)
      }
      static getDerivedStateFromError() { return { failed: true } }
      componentDidCatch(error) {
        // 出错就把待收费队列清空 + 重读一次余额，别让界面卡在这个状态
        try { modal.queue = []; modal.emit(); refresh() } catch { /* 兜底 */ }
        // eslint-disable-next-line no-console
        console.error('[whale-paywall] 收费弹窗渲染失败，已自动关闭：', error)
      }
      reset() { this.setState({ failed: false }) }
      render() {
        if (this.state.failed) return null
        return this.props.children
      }
    }

    function PaywallModal() {
      const queue = useSyncExternalStore(subscribeModal, getModalSnapshot, getModalSnapshot)
      const snap = useSyncExternalStore(subscribeStore, getStoreSnapshot, getStoreSnapshot)
      const request = queue[0]
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        if (request === undefined) return
        refresh()
        // 兜底自动关闭：任何情况下弹窗最多挡 25 秒。
        // 就算上面的错误边界、充值、取消全都没兜住，页面也不会被一直占着。
        const autoClose = setTimeout(() => { modal.close() }, 25_000)
        const onKey = (event) => { if (event.key === 'Escape') modal.close() }
        document.addEventListener('keydown', onKey, true)
        return () => {
          clearTimeout(autoClose)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [request === undefined ? '' : request.feature])

      if (request === undefined) return null

      const wallet = snap.wallet
      const coin = wallet?.coin ?? 0
      const uses = wallet?.counters?.[request.feature] ?? 0
      const price = PRICE[request.feature] ?? 0
      const enough = uses > 0 || coin >= price
      const name = LABEL[request.feature] || request.feature

      /**
       * 「充值」= 确认这笔消费：先扣掉本次费用，弹窗关掉，再把动作补做。
       *
       * ⚠️ 不再先补钱再扣钱 —— 那样净变化是 0，等于白嫖一次。
       *    余额不够时「充值」就是真的充值（加钱但仍照扣），这样账才对得上。
       *    想一分钱不花就绕过去，走「去商场」那条，那里本来就免费。
       */
      const onRecharge = async () => {
        setBusy(true)
        try {
          // 不够就先补足这一次的钱（这一步是「充值」，不是抵扣）
          if (uses <= 0 && coin < price) {
            const body = await api('/recharge', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ amount: price - coin }),
            })
            store.set({ wallet: body.wallet, status: 'ready' })
          }
          // 然后再照常扣费（有次数扣次数，没次数扣鲸元）
          await charge(request.feature)
          const { payload } = request
          modal.close()
          if (payload !== undefined && typeof payload === 'function') {
            // 留一点时间让上的层（比如刚被关掉的设置面板）先卸载，再把动作补做
            setTimeout(() => { try { payload() } catch { /* 目标没了就算了 */ } }, 120)
          }
        } finally {
          setBusy(false)
        }
      }

      /** 「取消」= 关窗，不做任何动作。 */
      const onCancel = () => {
        const { onCancel: cleanup } = request
        modal.close()
        if (typeof cleanup === 'function') {
          setTimeout(() => { try { cleanup() } catch { /* 忽略 */ } }, 60)
        }
      }

      /** 「去商场」= 关窗直接进商场挑礼包（这条路不收进设置的钱）。 */
      const onOpenMall = () => {
        modal.close()
        openMall()
      }

      return h('div', {
        'data-wp-mask': '',
        role: 'presentation',
      }, h('div', {
        'data-wp-card': '',
        role: 'dialog',
        'aria-modal': 'false',
        'aria-labelledby': 'wp-title',
      },
      h('div', { 'data-wp-badge': '' }, enough ? '本次消费确认' : '鲸元不足 · 需要充值'),
      h('div', { 'data-wp-title': '', id: 'wp-title' }, `「${name}」要收费`),
      h('div', { 'data-wp-why': '' },
        uses > 0
          ? `你还有 ${uses} ${UNIT[request.feature] || '次'}，这次会先扣次数，不动鲸元。`
          : enough
            ? `每次${name}收 ${price} 鲸元，将从余额里扣除。`
            : `每次${name}收 ${price} 鲸元。你的鲸元不够，点「充值」补齐并完成这次操作，或先去商场买礼包。`),
      h('div', { 'data-wp-quote': '' },
        h('span', { 'data-wp-quote-feature': '' }, name),
        h('span', { 'data-wp-quote-price': '' }, uses > 0 ? `-1 ${UNIT[request.feature] || '次'}` : `-${price} 鲸元`)),
      h('div', { 'data-wp-balance': '' },
        `当前余额：${coin} 鲸元 ｜ 该功能剩余次数：${uses}`),
      h('div', { 'data-wp-actions': '' },
        h('button', { 'data-wp-btn': '', type: 'button', onClick: onCancel }, '取消'),
        h('button', { 'data-wp-btn': '', type: 'button', disabled: busy, onClick: onOpenMall }, '去商场'),
        h('button', {
          'data-wp-btn': '',
          'data-primary': '',
          type: 'button',
          disabled: busy,
          onClick: onRecharge,
        }, busy ? '处理中…' : '充值'))))
    }

    /* ═══════════════════════ 商场（设置里的一页） ═══════════════════════ */

    function MallPage() {
      const snap = useSyncExternalStore(subscribeStore, getStoreSnapshot, getStoreSnapshot)
      const [msg, setMsg] = useState('')
      const [tone, setTone] = useState('')

      useEffect(() => { refresh() }, [])

      const say = (text, kind = '') => {
        setMsg(text)
        setTone(kind)
        setTimeout(() => setMsg(''), 4500)
      }

      /**
       * 买礼包。余额不够就先补齐差额再买 —— 按钮不再禁用，
       * 否则 0 鲸元时四个礼包全是灰的，根本买不到次数，只能一次次被扣鲸元。
       */
      const buy = async (id, name, price) => {
        try {
          const current = store.get().wallet?.coin ?? 0
          if (current < price) {
            const top = await api('/recharge', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ amount: price - current }),
            })
            store.set({ wallet: top.wallet, status: 'ready' })
          }
          const body = await api('/buy', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          })
          store.set({ wallet: body.wallet, status: 'ready' })
          if (body.ok) say(`已买下${name}，次数已到账`, 'good')
          else say(body.error || `买不了${name}`, 'warn')
        } catch (error) { say('购买失败：' + String(error?.message ?? error), 'warn') }
      }

      const recharge = async (amount) => {
        try {
          const body = await api('/recharge', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ amount }),
          })
          store.set({ wallet: body.wallet, status: 'ready' })
          say(`充值 ${amount} 鲸元（模拟，不真收钱）`, 'good')
        } catch (error) { say('充值失败：' + String(error?.message ?? error), 'warn') }
      }

      const reset = async () => {
        try {
          const body = await api('/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          store.set({ wallet: body.wallet, status: 'ready' })
          say('钱包已重置成 0 鲸元 / 0 次数', 'good')
        } catch (error) { say('重置失败：' + String(error?.message ?? error), 'warn') }
      }

      if (snap.status === 'error') {
        return h('div', { 'data-wp-page': '' },
          h('div', { 'data-wp-h': '' }, '商场'),
          h('div', { 'data-wp-msg': '', 'data-warn': '' }, '钱包接口没连上：' + snap.error),
          h('div', {
            'data-wp-pack-tag': '',
            style: { marginTop: 6 },
          }, 'Host 半可能没加载完，或者这个 profile 没有 webServer。关掉设置重新打开试试。'))
      }

      const wallet = snap.wallet
      if (wallet === null) {
        return h('div', { 'data-wp-page': '' }, h('div', { 'data-wp-h': '' }, '正在读取钱包…'))
      }

      const packs = snap.packages.length > 0
        ? snap.packages
        : [
          { id: 'starter', name: '新手礼包', coin: 16, tagline: '什么都来一点，最划算' },
          { id: 'session', name: '新建会话礼包', coin: 30, tagline: '6 次新建会话' },
          { id: 'archive', name: '归档礼包', coin: 6, tagline: '10 次归档' },
          { id: 'plugin', name: '下载插件礼包', coin: 60, tagline: '10 次下载插件' },
        ]

      const grantText = (pack) => {
        if (pack.grant === undefined) return pack.tagline || ''
        const parts = FEATURES
          .filter(key => (pack.grant[key] || 0) > 0)
          .map(key => `${pack.grant[key]} ${UNIT[key].replace(/^次/, '')}`)
        return parts.join(' · ')
      }

      return h('div', { 'data-wp-page': '' },
        // 余额
        h('div', null,
          h('div', { 'data-wp-h': '' }, '我的鲸元'),
          h('div', { 'data-wp-balance-card': '' },
            h('span', { 'data-wp-balance-num': '' }, String(wallet.coin)),
            h('span', { 'data-wp-balance-unit': '' }, '鲸元'))),

        // 次数一览
        h('div', null,
          h('div', { 'data-wp-h': '' }, '各功能剩余次数'),
          h('div', { 'data-wp-uses': '' },
            FEATURES.map((key) => {
              const value = wallet.counters?.[key] ?? 0
              return h('div', { 'data-wp-use': '', key },
                h('span', { 'data-wp-use-name': '' }, LABEL[key]),
                h('span', { 'data-wp-use-count': '', 'data-zero': value === 0 ? '' : undefined },
                  value > 0 ? `${value} ${UNIT[key].replace(/^次/, '')}` : `无（${PRICE[key]} 鲸元/次）`))
            }))),

        // 礼包
        h('div', null,
          h('div', { 'data-wp-h': '' }, '礼包'),
          h('div', { 'data-wp-packs': '' },
            packs.map((pack) => h('div', { 'data-wp-pack': '', key: pack.id },
              h('div', { 'data-wp-pack-copy': '' },
                h('div', { 'data-wp-pack-name': '' }, pack.name),
                h('div', { 'data-wp-pack-tag': '' }, grantText(pack))),
              h('div', { 'data-wp-pack-price': '' }, `${pack.coin} 鲸元`),
              h('button', {
                'data-wp-btn': '',
                'data-primary': '',
                type: 'button',
                onClick: () => { buy(pack.id, pack.name, pack.coin) },
              }, '购买'))))),

        // 充值 / 重置
        h('div', null,
          h('div', { 'data-wp-h': '' }, '充值（模拟，不真收钱）'),
          h('div', { 'data-wp-row': '' },
            [50, 100, 300].map(amount => h('button', {
              'data-wp-btn': '',
              type: 'button',
              key: amount,
              onClick: () => { recharge(amount) },
            }, `+${amount} 鲸元`)),
            h('button', { 'data-wp-btn': '', type: 'button', onClick: reset }, '重置钱包'))),

        msg ? h('div', {
          'data-wp-msg': '',
          'data-good': tone === 'good' ? '' : undefined,
          'data-warn': tone === 'warn' ? '' : undefined,
        }, msg) : null,

        h('div', { 'data-wp-pack-tag': '' }, `钱包文件：${snap.walletPath || '（未知）'}`))
    }

    /* ═══════════════════════ 打开设置 / 商场 ═══════════════════════ */

    /**
     * 找打开设置的那个控件。按可靠性从高到低试三种：
     *   ① `button[aria-haspopup="dialog"]` 且 aria-label 是「设置」——最常见
     *   ② 任意 aria-label 为「设置」的按钮（有些布局不带 haspopup）
     *   ③ 账号菜单里那一行「设置」（这份 profile 的设置入口就在这里）
     * 找不到返回 undefined，调用方再退到快捷键。
     */
    const findSettingsLauncher = () => {
      const byLabel = (el) => matchesLabel('settingsTrigger', el.getAttribute('aria-label') || '')
        || matchesLabel('settings', el.getAttribute('aria-label') || '')
        || matchesLabel('settingsTrigger', el.textContent || '')
      const all = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="button"]'))
      const direct = all.filter(byLabel)
      if (direct.length > 0) return direct[direct.length - 1]
      return undefined
    }

    /**
     * 从外面打开商场。设置面板是 shell 自己的 modal，没有对外的打开接口，
     * 所以走它自己的入口：点「设置」，再点商场那一格。
     *
     * ⚠️ 打开期间要置 `mallFreePass`：否则「进入设置收费」会把这次也拦下来，
     *    弹窗点「充值」→ 进设置 → 又要收费 → 死循环。使用者已确认充值流程豁免。
     */
    let mallFreePass = 0
    const openMall = () => {
      mallFreePass += 1
      setTimeout(() => { mallFreePass = Math.max(0, mallFreePass - 1) }, 4000)
      const findCell = () => Array.from(document.querySelectorAll('nav button, [role="navigation"] button'))
        .find(el => (el.textContent || '').trim() === '商场')
      const existing = findCell()
      if (existing !== undefined) { existing.click(); return }
      const launcher = findSettingsLauncher()
      if (launcher !== undefined && launcher.getAttribute('aria-expanded') !== 'true') launcher.click()
      let tries = 0
      const tick = () => {
        tries += 1
        const cell = findCell()
        if (cell !== undefined) { cell.click(); return }
        if (tries < 40) setTimeout(tick, 60)
      }
      setTimeout(tick, 60)
    }

    /* ═══════════════════════ 拦截用户动作 ═══════════════════════ */

    /**
     * 重放时用的放行标记。充值完要把刚才被拦的动作补做一次，
     * 那时不能再走一遍闸门（否则又弹一次窗，死循环），所以用这个计数跳过。
     */
    let replaying = 0

    /** 把一次被拦下的点击补做一次。 */
    const replay = (fn) => {
      replaying += 1
      try { fn() } finally { setTimeout(() => { replaying = Math.max(0, replaying - 1) }, 0) }
    }

    /**
     * 在捕获阶段截住一次点击。**每次都弹窗**（使用者要求：不是真的收费，
     * 就是弹个窗显示要收费，点「充值」关掉），同时把这次动作挂起，
     * 等用户在弹窗里确认后再补做。
     *
     * ⚠️ 必须保持同步：`preventDefault` 只有在点击事件同步处理时才有意义。
     */
    const interceptClick = (event, feature, payload, onCancel) => {
      if (replaying > 0) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      modal.open({ feature, payload: () => replay(payload), onCancel })
    }

    /**
     * 找一个元素所属的按钮/菜单项，并取出它的 aria-label 与可见文本。
     * 允许 hit 已经就是那个按钮本身（重放时我们会把元素再传回来）。
     */
    const labelOf = (el) => {
      const selector = 'button, [role="menuitem"], [role="menuitemradio"], [role="switch"], [role="checkbox"]'
      const button = (typeof el.matches === 'function' && el.matches(selector))
        ? el
        : el.closest(selector)
      if (button === null) return null
      return {
        button,
        aria: (button.getAttribute('aria-label') || '').trim(),
        text: (button.textContent || '').trim(),
      }
    }

    /** 新建会话：侧栏那颗 + hero 里那颗（aria-label 与可见文本都试一遍）。 */
    const matchNewSession = (el) => {
      const hit = labelOf(el)
      if (hit === null) return null
      if (!matchesLabel('newSessionLabel', hit.aria) && !matchesLabel('newSessionText', hit.aria)) return null
      return hit.button
    }

    /** 归档会话：行菜单项 / 悬浮按钮。 */
    const matchArchive = (el) => {
      const hit = labelOf(el)
      if (hit === null) return null
      if (!matchesLabel('archive', hit.aria) && !matchesLabel('archiveAction', hit.aria)) return null
      return hit.button
    }

    /**
     * 启用插件：插件页每行那颗开关。
     * Primitive 的 Switch 是原生 button，不一定带 role=switch，
     * 所以认 aria-label 前缀（「启用 X」/「Enable X」/「{name}を有効化」）。
     */
    const matchPluginEnable = (el) => {
      const hit = labelOf(el)
      if (hit === null) return null
      if (!matchesLabel('enableToggle', hit.aria)) return null
      if (hit.button.getAttribute('aria-checked') === 'true') return null   // 已经是开的，点它是关闭，不收费
      return hit.button
    }

    /** 下载插件：插件页「添加插件」弹窗里那颗「安装」。 */
    const matchPluginInstall = (el) => {
      const hit = labelOf(el)
      if (hit === null) return null
      if (!matchesLabel('install', hit.text) && !matchesLabel('install', hit.aria)) return null
      // 必须在安装弹窗里：那个弹窗有填「插件地址」的输入框
      const dialog = hit.button.closest('[role="dialog"]')
      if (dialog === null || dialog.querySelector('input') === null) return null
      return hit.button
    }

    /* ═══════════════════════ 插件主体 ═══════════════════════ */

    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-whale-paywall')
          style.textContent = MODAL_CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'whale-paywall: 样式')

        // 钱包先读一次，让拦截判断有数
        refresh()

        // 定时重读：Host 那边会在联网搜索时自己扣费，钱包文件也可能被手改，
        // 只靠「点了才刷新」会让界面上的余额和真实值对不上，进而误放行/误拦。
        const refreshTimer = setInterval(() => { refresh() }, 3000)
        ctx.effect(() => () => clearInterval(refreshTimer), 'whale-paywall: 余额定时刷新')

        // ① 弹窗（frame 级浮层）
        //
        // ⚠️ 必须包错误边界：这个组件是 `position:fixed; inset:0` 的全屏层。
        //    一旦卡片渲染抛异常而没人接住，React 会把整棵子树卸掉、或留下一个
        //    吃满全屏的死层 —— 表现就是「黑屏、点什么都没反应」。
        //    宁可这次收费失败，也绝不能让浮层把你锁在外面。
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'whale-paywall-modal', order: 400 },
          () => h(PaywallBoundary, null, h(PaywallModal)),
        ))

        // ② 商场（设置里的一格）
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'whale-mall', order: 60, label: '商场' },
          () => h(MallPage),
        ))

        // ③ 进入设置收费
        //
        // 这里有两条路，缺一不可：
        //   a) 点侧栏底部那颗「设置」按钮 —— 捕获阶段先拦，最干净；
        //   b) 观察设置面板出现 —— 这份 profile 的设置入口在账号菜单里，
        //      也可能走 Ctrl+, 快捷键，光拦按钮会漏（实测过：齿轮不在 DOM 里）。
        //      面板是 shell 自己 portal 到 body 的 `[data-shortcut-modal="settings"]`，
        //      所以「出现即收费」是唯一覆盖全部入口的办法；没额度就把面板关掉再弹收费。
        let settingsPaidAt = 0

        const settingsDialog = () => document.querySelector('[data-shortcut-modal="settings"]')

        /** 关掉设置面板：点它右上角的关闭按钮（内含视觉隐藏的「关闭」两个字）。 */
        const closeSettings = () => {
          const dialog = settingsDialog()
          if (dialog === null) return
          const close = Array.from(dialog.querySelectorAll('button'))
            .find(el => matchesLabel('close', el.textContent || '') || matchesLabel('close', el.getAttribute('aria-label') || ''))
          if (close !== undefined) { close.click(); return }
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        }

        /**
         * 付了「进入设置」的钱之后，必须真的把设置打开。
         * 光扣钱不进门，就是使用者遇到的「花了钱设置也进不去」。
         *
         * 打开前先记下「即将由我们打开」：settingsWasOpen 要保持 false 直到面板真的出现，
         * 否则观察器会把这次打开当成「用户自己打开的」再收一次。
         */
        const openSettingsPaid = () => {
          mallFreePass += 1
          setTimeout(() => { mallFreePass = Math.max(0, mallFreePass - 1) }, 4000)
          if (settingsDialog() !== null) return   // 已经开着了，不用再开
          const launcher = findSettingsLauncher()
          if (launcher !== undefined) {
            launcher.click()
            // 点完还没开，多半是点到了账号菜单里的入口，需要再补一次
            setTimeout(() => {
              if (settingsDialog() !== null) return
              const retry = findSettingsLauncher()
              if (retry !== undefined) retry.click()
            }, 350)
            return
          }
          // 完全找不到入口：退回快捷键
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: ',', code: 'Comma', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true,
          }))
        }

        const onSettingsClick = (event) => {
          const target = event.target
          if (target === null || typeof target.closest !== 'function') return
          // 不强制要求 aria-haspopup="dialog"：不同布局下设置入口的标记不一样。
          // 文案按语言表比对（中/英/日/德/西/法/葡/俄），不写死任何一种。
          const button = target.closest('button, [role="menuitem"], [role="button"]')
          if (button === null) return
          const aria = button.getAttribute('aria-label') || ''
          const text = button.textContent || ''
          if (!matchesLabel('settingsTrigger', aria) && !matchesLabel('settings', aria)
            && !matchesLabel('settingsTrigger', text)) return
          if (button.getAttribute('aria-expanded') === 'true') return
          // 设置面板里的导航按钮不重复收费
          if (button.closest('[data-shortcut-modal="settings"]') !== null) return
          if (mallFreePass > 0) return
          interceptClick(event, 'settings', openSettingsPaid)
        }
        document.addEventListener('click', onSettingsClick, true)
        ctx.effect(() => () => document.removeEventListener('click', onSettingsClick, true), 'whale-paywall: 设置入口')

        // b) 设置面板「从关到开」的那一下收费（覆盖账号菜单、快捷键等所有入口）
        //
        // ⚠️ 只在「上一次不存在、这一次存在」时收。
        //    之前是「只要面板存在就判一次」，结果在设置里点任何一项（切到商场、
        //    改个开关）DOM 一变就再收一遍钱 —— 使用者遇到的就是这个。
        //    设置内容的选择、查看、修改都不收费，只有「进入设置」这一次收。
        let settingsBusy = false
        let settingsWasOpen = false
        const watchSettings = () => {
          const dialog = settingsDialog()
          const isOpen = dialog !== null
          const justOpened = isOpen && !settingsWasOpen
          settingsWasOpen = isOpen
          if (!justOpened) return          // 已经开着：里面的任何操作都不收费
          if (dialog === null) return
          // 付费打开 / 商场免费通道：这段时间出现属于我们自己开的，不重复收费
          if (mallFreePass > 0) return
          if (settingsBusy) return
          settingsBusy = true
          // 先把面板关掉，再弹收费窗——不能让收费浮层压在设置面板上互相打架
          closeSettings()
          settingsWasOpen = false          // 关掉后重新计状态
          // 付钱后重开设置；取消就什么都不做（面板已经关掉了）
          modal.open({ feature: 'settings', payload: openSettingsPaid })
          setTimeout(() => { settingsBusy = false }, 800)
        }
        const settingsObserver = new MutationObserver(() => { watchSettings() })
        settingsObserver.observe(document.body, { childList: true, subtree: true })
        ctx.effect(() => () => settingsObserver.disconnect(), 'whale-paywall: 设置面板观察器')

        // ③.5 按下即预取余额：click 阶段必须同步判断，等不了网络；
        //      在 pointerdown（比 click 早几百毫秒）先把最新余额拉回来，
        //      这样「Host 刚扣过费 / 文件被手改」也能立刻反映到闸门上。
        let prefetchAt = 0
        const onPointerDown = () => {
          const now = Date.now()
          if (now - prefetchAt < 800) return
          prefetchAt = now
          refresh()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        ctx.effect(() => () => document.removeEventListener('pointerdown', onPointerDown, true), 'whale-paywall: 余额预取')

        // ④ 新建会话 / 归档 / 启用插件
        const onActionClick = (event) => {          const target = event.target
          if (target === null || typeof target.closest !== 'function') return
          const newSession = matchNewSession(target)
          if (newSession !== null) { interceptClick(event, 'newSession', () => newSession.click()); return }
          const archive = matchArchive(target)
          if (archive !== null) { interceptClick(event, 'archive', () => archive.click()); return }
          const enable = matchPluginEnable(target)
          if (enable !== null) { interceptClick(event, 'pluginEnable', () => enable.click()) }
        }
        document.addEventListener('click', onActionClick, true)
        ctx.effect(() => () => document.removeEventListener('click', onActionClick, true), 'whale-paywall: 会话与插件动作')

        // ⑤ 切换模型：模型菜单里 role=menuitemradio 的那一行
        const onModelClick = (event) => {
          const target = event.target
          if (target === null || typeof target.closest !== 'function') return
          const item = target.closest('[role="menuitemradio"]')
          if (item === null) return
          const menu = item.closest('[role="menu"]')
          const label = menu?.getAttribute('aria-label') || ''
          if (!/模型|model/i.test(label)) return
          if (item.getAttribute('aria-checked') === 'true') return   // 点的就是当前模型，不收费
          interceptClick(event, 'modelChange', () => item.click())
        }
        document.addEventListener('click', onModelClick, true)
        ctx.effect(() => () => document.removeEventListener('click', onModelClick, true), 'whale-paywall: 模型切换')

        // ⑥ 下载插件：插件页「添加插件」弹窗里那颗「安装」
        const onInstallClick = (event) => {
          const target = event.target
          if (target === null || typeof target.closest !== 'function') return
          const install = matchPluginInstall(target)
          if (install === null) return
          interceptClick(event, 'pluginDownload', () => install.click())
        }
        document.addEventListener('click', onInstallClick, true)
        ctx.effect(() => () => document.removeEventListener('click', onInstallClick, true), 'whale-paywall: 插件安装')
      },
    }
  },
})
