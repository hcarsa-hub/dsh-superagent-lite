import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export async function smokeSteer({ apply, makeCtx, mkTmp, ok, eq, byName }) {
  console.log('sa_steer：schema / owner / message / routing / failures / isolation')
  const rootDir = mkTmp('superagent-lite-steer-')
  const stateDir = join(rootDir, 'state')
  const owner = { agent: { id: 'steer-owner' } }
  let lookupCalls = 0
  let resolveCalls = 0
  let currentAgent
  let lookupError
  let resolveError
  const calls = []
  const provider = { async resolve(sid) {
    resolveCalls++
    eq('解析目标 sessionId 已 trim', sid, 'target')
    if (resolveError) throw resolveError
    return currentAgent
  } }
  const typert = { lookups: { get(kind) {
    lookupCalls++
    eq('typert lookup kind', kind, 'agent')
    if (lookupError) throw lookupError
    return provider
  } } }
  const { ctx, registered, disposeAll } = makeCtx({ typert })
  apply(ctx, { stateDir, ownerSessions: [owner.agent.id] })
  try {
    const tools = byName(registered)
    const steer = tools.sa_steer
    eq('steer schema 禁止额外字段', steer.parameters.additionalProperties, false)
    eq('steer schema 字段精确匹配', Object.keys(steer.parameters.properties).sort().join(','), 'mode,sessionId,text')
    eq('steer schema 必填字段', [...steer.parameters.required].sort().join(','), 'sessionId,text')
    for (const key of ['sessionId', 'text', 'mode']) eq('steer schema ' + key + ' 为字符串', steer.parameters.properties[key].type, 'string')
    eq('steer mode enum', steer.parameters.properties.mode.enum.join(','), 'auto,steer,followup')
    eq('steer 测试建单', (await tools.sa_submit.execute({ title: 'steer isolation fixture' }, owner)).ok, true)
    for (const role of ['worker', 'judge', 'ops']) {
      eq('steer 测试登记 ' + role, (await tools.sa_role.execute({ sessionId: 'steer-' + role, role }, owner)).ok, true)
    }
    const snapshot = () => {
      const entries = []
      const walk = (dir, rel = '') => {
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
          const name = rel + ent.name
          if (name === 'state/lite.log') continue // Denials intentionally write an audit log.
          if (ent.isDirectory()) { entries.push(name + '/'); walk(join(dir, ent.name), name + '/') }
          else entries.push(name + ':' + readFileSync(join(dir, ent.name)).toString('base64'))
        }
      }
      walk(rootDir)
      return entries.sort().join('\n')
    }
    const before = snapshot()
    const args = { sessionId: ' target ', text: '  保留文本空格\n纠偏  ' }
    for (const exec of [undefined, {}, { agent: { id: 'unknown' } }, ...['worker', 'judge', 'ops'].map(role => ({ agent: { id: 'steer-' + role } }))]) {
      const r = await steer.execute(args, exec)
      ok('steer 非 owner 被拒', r.ok === false && r.detail.includes('forbidden'), r.detail)
    }
    eq('非 owner 不触达 typert', lookupCalls, 0)
    for (const bad of [undefined, [], {}, { ...args, session_id: 'target' }, { ...args, ticketId: 'sa-001' },
      { ...args, sessionId: 1 }, { ...args, text: 1 }, { ...args, sessionId: ' ' }, { ...args, text: '\n ' },
      { ...args, mode: 'invalid' }, { ...args, mode: '' }, { ...args, mode: null }]) {
      const r = await steer.execute(bad, owner)
      ok('steer 非法参数返回失败', r.ok === false && r.detail.startsWith('sa_steer:'), r.detail)
    }
    eq('非法参数不触达 typert', lookupCalls, 0)
    const get = ctx.get
    for (const tp of [undefined, {}, { lookups: {} }, { lookups: { get: () => null } }, { lookups: { get: () => ({}) } }]) {
      ctx.get = (name) => name === 'typert' ? tp : get(name)
      const r = await steer.execute(args, owner)
      ok('steer typert/解析器缺失返回明确错误', r.ok === false && r.detail.includes('agent 解析器'), r.detail)
    }
    ctx.get = (name) => { if (name === 'typert') throw new Error('service-boom'); return get(name) }
    let r = await steer.execute(args, owner)
    ok('steer ctx.get 异常受控', r.ok === false && r.detail.includes('service-boom'), r.detail)
    ctx.get = get
    lookupError = new Error('lookup-boom')
    r = await steer.execute(args, owner)
    ok('steer lookup.get 异常受控', r.ok === false && r.detail.includes('lookup-boom'), r.detail)
    lookupError = null
    resolveError = new Error('resolve-boom')
    r = await steer.execute(args, owner)
    ok('steer resolve rejection 受控', r.ok === false && r.detail.includes('解析会话失败') && r.detail.includes('resolve-boom'), r.detail)
    resolveError = null
    currentAgent = null
    r = await steer.execute(args, owner)
    ok('steer 空 Agent 受控', r.ok === false && r.detail.includes('空 Agent'), r.detail)
    for (const [status, mode, method] of [
      ['running', undefined, 'steer'], ['idle', undefined, 'followup'], ['unknown', 'auto', 'followup'],
      ['idle', 'steer', 'steer'], ['running', 'followup', 'followup'], ['running', 'auto', 'steer'],
    ]) {
      currentAgent = { status, steer(msg) { calls.push({ method: 'steer', msg }) }, followup(msg) { calls.push({ method: 'followup', msg }) } }
      r = await steer.execute({ ...args, ...(mode === undefined ? {} : { mode }) }, owner)
      ok('steer 路由 ' + status + '/' + mode, r.ok === true && calls.at(-1).method === method && r.detail.includes(method), r.detail)
    }
    const ids = new Set()
    for (const { msg } of calls) {
      ok('message UUID v4 可用', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(msg.id))
      ids.add(msg.id)
      eq('message 字段精确', Object.keys(msg).sort().join(','), 'content,id,role,source')
      eq('message role', msg.role, 'user')
      eq('message content', JSON.stringify(msg.content), JSON.stringify([{ type: 'text', text: args.text }]))
      eq('message source', JSON.stringify(msg.source), JSON.stringify({ kind: 'user' }))
      ok('message 全层深冻结', [msg, msg.content, msg.content[0], msg.source].every(Object.isFrozen))
      let blocked = 0
      for (const mutate of [() => { msg.role = 'system' }, () => { msg.content.push({}) }, () => { msg.content[0].text = 'mutated' }, () => { msg.source.kind = 'other' }]) {
        try { mutate() } catch (e) { if (e instanceof TypeError) blocked++ }
      }
      eq('message 每层修改均被阻止', blocked, 4)
    }
    eq('message UUID 不重复', ids.size, calls.length)
    for (const method of ['steer', 'followup']) {
      for (const deliver of [undefined, () => { throw new Error('sync-boom') }, async () => { throw new Error('async-boom') }]) {
        currentAgent = { status: 'running', [method]: deliver }
        r = await steer.execute({ ...args, mode: method }, owner)
        ok('steer ' + method + ' 缺失/同步/异步投递失败受控', r.ok === false && r.detail.includes('投递失败'), r.detail)
      }
      let finish
      currentAgent = { [method]: () => new Promise(resolve => { finish = resolve }) }
      let settled = false
      const pending = steer.execute({ ...args, mode: method }, owner).then(r => { settled = true; return r })
      await new Promise(resolve => setImmediate(resolve))
      eq('steer 等待 ' + method + ' 投递完成', settled, false)
      finish()
      eq('steer 异步 ' + method + ' 成功', (await pending).ok, true)
    }
    ok('steer 解析成功/失败路径均运行', resolveCalls > 0)
    eq('steer 所有路径不改账本/工单/角色/队列（允许拒绝日志）', snapshot(), before)
  } finally { disposeAll() }
}
