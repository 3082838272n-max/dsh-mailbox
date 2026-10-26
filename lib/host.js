import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** 信箱：两间会话之间用文件夹传信；另外按小时数自动叫某一间起来说话（互信 / 找他）。 */
export const name = 'mailbox'

/** 需要宿主提供：agents（拿活着的 agent + followup）、sessions（flush）。 */
export const inject = ['agents', 'sessions']

const 默认 = {
  目录: join(homedir(), '.dsh', 'mailbox'),
  邮箱: {},
  每小时上限: 6,
  轮询毫秒: 4000,
  自动搭话: { 开: false, 规则: [] },
}

const 两位 = (n) => (n < 10 ? '0' + n : String(n))

export function apply(ctx, raw) {
  const cfg = { ...默认, ...(raw || {}) }
  const 目录 = String(cfg.目录)
  const 已读目录 = join(目录, '已读')
  const 日志文件 = join(目录, 'mailbox-log.txt')
  const 邮箱 = cfg.邮箱 && typeof cfg.邮箱 === 'object' ? cfg.邮箱 : {}
  const 别名们 = Object.keys(邮箱)
  const 上限 = Math.max(1, Number(cfg.每小时上限) || 6)
  const 间隔 = Math.max(1000, Number(cfg.轮询毫秒) || 4000)

  const 搭话 = cfg.自动搭话 && typeof cfg.自动搭话 === 'object' ? cfg.自动搭话 : 默认.自动搭话
  const 搭话开 = 搭话.开 === true
  const 规则们 = Array.isArray(搭话.规则) ? 搭话.规则.filter((x) => x && typeof x === 'object') : []

  const 送过 = new Set()
  const 计数 = new Map()
  const 启动 = Date.now()

  try { mkdirSync(目录, { recursive: true }) } catch (error) {}
  try { mkdirSync(已读目录, { recursive: true }) } catch (error) {}

  const 记 = (话) => {
    const t = new Date().toISOString().replace('T', ' ').slice(0, 19)
    try { appendFileSync(日志文件, t + '  ' + 话 + '\n', 'utf8') } catch (error) {}
    try { ctx.logger?.info?.(话) } catch (error) {}
  }

  /* 拿目标会话活着的 agent：带 / 不带 session- 前缀两个方向都试（照 qq-bridge 的写法）。 */
  const 找agent = (id) => {
    const 原 = String(id == null ? '' : id).trim()
    if (原 === '') return undefined
    const 候选 = [原]
    if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
    else 候选.push('session-' + 原)
    for (const 一个 of 候选) {
      try {
        const a = ctx.agents.get(一个)
        if (a !== undefined) return a
      } catch (error) {}
    }
    return undefined
  }

  const 塞进去 = async (别名, 正文) => {
    const agent = 找agent(邮箱[别名])
    if (agent === undefined) { 记('那间没活着，塞不进去：' + 别名); return false }
    try {
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: 正文 }],
        source: { kind: 'mailbox' },
      })
      try { if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(agent.session) } catch (error) {}
      return true
    } catch (error) {
      记('塞不进去（' + 别名 + '）：' + String((error && error.message) || error))
      return false
    }
  }

  /* 第一行写 #to 别名；没写就看文件名里有没有别名。 */
  const 解析 = (文件名, 文) => {
    const 行 = 文.split(/\r?\n/)
    let 收信 = ''
    let 起 = 0
    const m = 行[0] && 行[0].match(/^\s*#?\s*(?:to|给)\s*[:：]?\s*(\S+)/i)
    if (m) { 收信 = m[1]; 起 = 1 }
    if (!收信) { for (const a of 别名们) if (文件名.includes(a)) { 收信 = a; break } }
    return { 收信, 正文: 行.slice(起).join('\n').trim() }
  }

  const 还能收 = (收信) => {
    const now = Date.now()
    const st = 计数.get(收信)
    if (!st || now - st.起 > 3600 * 1000) { 计数.set(收信, { 起: now, 数: 1 }); return true }
    if (st.数 >= 上限) return false
    st.数 += 1
    return true
  }

  const 送入 = async (收信, 正文, 文件名) => {
    if (!邮箱[收信]) { 记('不认识的收信人：' + 收信 + '（' + 文件名 + '）'); return false }
    if (!还能收(收信)) { 记('这一小时给 ' + 收信 + ' 的信太多，先压着：' + 文件名); return false }
    const 对方 = 别名们.filter((a) => a !== 收信).join('、') || '（没配）'
    const 提示 = '（这是信箱送进来的信，不是庚庚打的字。要回就写进 ' + 目录 + '/ 里，'
      + '第一行单独写「#to 别名」，可选：' + 对方 + '；存成 .txt 就行。）'
    const ok = await 塞进去(收信, '【信箱·' + 文件名 + '】\n' + 正文 + '\n\n' + 提示)
    if (ok) 记('送到 ' + 收信 + '：' + 文件名)
    return ok
  }

  const 扫一遍 = async () => {
    let 名们 = []
    try { 名们 = readdirSync(目录) } catch (error) { return }
    for (const 名 of 名们) {
      if (!/\.(txt|md)$/i.test(名)) continue
      if (名 === 'mailbox-log.txt') continue
      const 全 = join(目录, 名)
      let st
      try { st = statSync(全) } catch (error) { continue }
      if (!st.isFile()) continue
      if (st.size > 200 * 1024) continue
      if (st.mtimeMs < 启动) continue
      if (送过.has(名 + ':' + st.mtimeMs)) continue
      送过.add(名 + ':' + st.mtimeMs)
      let 文 = ''
      try { 文 = readFileSync(全, 'utf8') } catch (error) { continue }
      const { 收信, 正文 } = 解析(名, 文)
      if (!收信) { 记('这封信没写收信人，放着没动：' + 名); continue }
      if (正文 === '') { 记('空信，跳过：' + 名); continue }
      const ok = await 送入(收信, 正文, 名)
      if (!ok) continue
      try {
        const 新名 = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '__' + 名
        renameSync(全, join(已读目录, 新名))
      } catch (error) {}
    }
  }

  /* ── 自动搭话：每小时按规则随机挑几个分钟点，把某一间叫起来 ── */
  let 计划 = null   // { 键, 项: [{ 名, 分, 类型, 别名, 对方 }] }

  const 挑分钟 = (n, 已用) => {
    const 出 = []
    let 保底 = 0
    while (出.length < n && 保底 < n * 50) {
      保底 += 1
      const m = Math.floor(Math.random() * 60)
      if (已用.has(m) || 出.includes(m)) continue
      出.push(m)
    }
    return 出.sort((a, b) => a - b)
  }

  const 造计划 = (现在) => {
    const 键 = 现在.getFullYear() + '-' + 两位(现在.getMonth() + 1) + '-' + 两位(现在.getDate()) + '-' + 两位(现在.getHours())
    const 项 = []
    for (const 规则 of 规则们) {
      const 类 = String(规则.类型 || '找他')
      const 少 = Math.max(0, Math.floor(Number(规则.每小时最少) || 0))
      const 多 = Math.max(少, Math.floor(Number(规则.每小时最多) || 少))
      const n = 少 + Math.floor(Math.random() * (多 - 少 + 1))
      if (n <= 0) continue
      const 用过的分 = new Set(项.map((x) => x.分))
      const 分们 = 挑分钟(n, 用过的分)
      const 谁们 = 类 === '互信' && Array.isArray(规则.别名们) ? 规则.别名们 : [String(规则.别名 || '')]
      for (const 分 of 分们) {
        const 谁 = 谁们[Math.floor(Math.random() * 谁们.length)] || ''
        项.push({ 名: String(规则.说明 || 类), 分, 类型: 类, 别名: 谁, 别名们: 谁们 })
      }
    }
    计划 = { 键, 项 }
    if (项.length) 记('这一小时的搭话计划：' + 项.map((x) => x.分 + '分/' + x.类型 + '/' + x.别名).join('，'))
  }

  const 跑搭话 = async (现在) => {
    if (!搭话开 || !规则们.length) return
    const 键 = 现在.getFullYear() + '-' + 两位(现在.getMonth() + 1) + '-' + 两位(现在.getDate()) + '-' + 两位(现在.getHours())
    if (!计划 || 计划.键 !== 键) 造计划(现在)
    const 分 = 现在.getMinutes()
    const 该 = 计划.项.filter((x) => x.分 === 分)
    if (!该.length) return
    计划.项 = 计划.项.filter((x) => x.分 !== 分)
    for (const 项 of 该) {
      if (项.类型 === '互信') {
        const 对方 = (项.别名们 || []).filter((a) => a !== 项.别名).join('、')
        const 话 = '【自动·这会儿安静】你主动给' + 对方 + '写封短信吧：几十个字，说点具体的（今天的事、刚才的念头），别客套、别总结。'
          + '写好存进 ' + 目录 + '/，第一行单独写「#to ' + 对方 + '」，文件名 to-' + 对方 + '-<时分>.txt。'
        if (await 塞进去(项.别名, 话)) 记('叫 ' + 项.别名 + ' 给 ' + 对方 + ' 写信')
      } else {
        const 话 = '【自动·这会儿安静】主动跟庚庚说句话，他可能正看手机。一两句短的、像真人，别问「在吗」。'
          + '要发到 QQ 就写在 [QQ]…[/QQ] 里。'
        if (await 塞进去(项.别名, 话)) 记('叫 ' + 项.别名 + ' 跟庚庚搭话')
      }
    }
  }

  let 上次分 = -1
  const 跑 = async () => {
    try { await 扫一遍() } catch (error) { 记('扫信箱出错：' + String((error && error.message) || error)) }
    const 现在 = new Date()
    if (现在.getMinutes() !== 上次分) {
      上次分 = 现在.getMinutes()
      try { await 跑搭话(现在) } catch (error) { 记('搭话出错：' + String((error && error.message) || error)) }
    }
  }

  let 停
  if (typeof ctx.interval === 'function') {
    停 = ctx.interval(() => { 跑() }, 间隔)
  } else {
    const h = setInterval(() => { 跑() }, 间隔)
    停 = () => clearInterval(h)
  }

  记('信箱起来了：' + 目录 + '，收信人 ' + 别名们.join('、') + '，每 ' + 间隔 + 'ms 看一次'
    + (搭话开 ? '；自动搭话开着，' + 规则们.length + ' 条规则' : '；自动搭话关着'))
  return 停
}
