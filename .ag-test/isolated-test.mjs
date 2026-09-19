/**
 * dsh-approval-gate 隔离功能测试（不影响主进程）
 *
 * 设计约束（对应「隔离一个测试环境，不要影响主进程」）：
 * - 独立 Node 进程：不加载、不重启主 DSH web 实例（web profile）。
 * - 临时 DSH_HOME（os.tmpdir() 下 mkdtemp）：插件写 allowlist/learning/audit/events
 *   全部落在临时目录，测试结束即删，不触碰 D:\dsharness\data 下的真实数据。
 * - 不绑定端口：webServer 用假桩；不发起真实 LLM 请求：llm.stream 用假桩。
 * - 复用本机已安装的 DSH v0.1.5-rc.2 真实运行时包（$DSH_HOME/profiles/node_modules）：
 *   @deepseek-ai/cordis 4.0.2、dsh-session、dsh-session-projection、
 *   dsh-permission-presets（真实 PermissionPresetService + 真实 Session）、
 *   cordis-plugin-timer（真实 ctx.timeout）。
 * - 若本机未安装该运行时（profiles/node_modules 缺失），打印 SKIP 并以 0 退出，
 *   保证不破坏裸克隆环境下的 npm test 类流程。
 *
 * 用法：
 *   node .ag-test/isolated-test.mjs
 *   # 指定被测插件源码（默认仓库内 src/index.mjs），可用于对旧版本做红/绿对照：
 *   AG_PLUGIN_PATH=C:\path\to\index.mjs node .ag-test/isolated-test.mjs
 */
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
const NM = join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai')
const P = (pkg, file = 'lib/index.js') => pathToFileURL(join(NM, pkg, file)).href

// 本机没有 DSH 运行时安装 → 跳过（不失败）
if (!existsSync(join(NM, 'cordis'))) {
  console.log('SKIP: 未找到 DSH 运行时安装（' + NM + '），跳过隔离测试')
  process.exit(0)
}

// 插件的数据目录隔离：必须先覆盖 DSH_HOME，再 import 插件模块（模块顶层按 DSH_HOME 定位数据文件）
const testHome = mkdtempSync(join(tmpdir(), 'dsh-approval-gate-test-'))
process.env.DSH_HOME = testHome

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n      ') : error}`)
  }
}
const checkAsync = async (name, fn) => {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n      ') : error}`)
  }
}

try {
  const { Context } = await import(P('cordis'))
  const { default: SessionStore, SessionId } = await import(P('dsh-session'))
  const { default: SessionProjectionRegistry } = await import(P('dsh-session-projection'))
  const { default: PermissionPresetService } = await import(P('dsh-permission-presets'))
  const { default: TimerPlugin } = await import(P('cordis-plugin-timer'))

  // 可切换的 llm 桩：默认输出 SAFE；用例可改成 RISKY:<category>
  let llmVerdict = 'SAFE'
  // 同类验证（verifySimilarity）单独的输出（按 system prompt 区分两次调用）
  let similarityVerdict = 'SAME'
  // 模型是否声明支持 reasoningEffort 'off'（默认支持，等同 deepseek-official）
  let reasoningOffSupported = true
  // 是否先发一段 reasoning-delta 再给结论（模拟带思考的模型；思考文本可能含 RISKY/SAFE 字样）
  let emitReasoning = false
  let lastStreamOptions = null
  // 可切换的「当前模型选择」（模拟 agentDefaultModel.currentSelection）；按 provider/model 缓存 reasoningEffort 支持度
  let selectedModel = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const fakeLlm = {
    async resolveModelInfo(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        reasoning: {
          efforts: reasoningOffSupported ? [{ id: 'off', name: 'Off' }] : [],
          ...reasoningOffSupported ? { defaultEffort: 'off' } : {},
        },
      }
    },
    async *stream(options) {
      lastStreamOptions = options
      if (emitReasoning) {
        yield { type: 'reasoning-delta', index: 0, text: '这个操作看起来有 RISKY:deletion 的风险，但再想一下其实只是常规修改...' }
      }
      // 按 system prompt 区分风险判定（judgeOnce）与同类验证（verifySimilarity）
      const isSimilarity = String(options.system || '').includes('操作意图一致性判断器')
      yield { type: 'text-delta', index: 0, text: isSimilarity ? similarityVerdict : llmVerdict }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('隔离测试不执行 bash') },
    run() { throw new Error('隔离测试不执行 bash') },
    start() { throw new Error('隔离测试不执行 bash') },
  })
  ctx.provide('approval', { config: { policy: 'ask' } })
  await ctx.plugin(TimerPlugin)
  ctx.provide('llm', fakeLlm)
  ctx.provide('agentDefaultModel', { currentSelection: () => selectedModel })
  ctx.provide('webServer', { register: () => () => {} })

  // 真实 PermissionPresetService，预设表与生产 cordis.patch.yml 一致（auto-approve 最后声明，
  // 让同捆 (workspace-write, ask) 的派生默认仍是 workspace-write）
  await ctx.plugin(PermissionPresetService, {
    presets: {
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask', name: 'workspace-write' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: 'danger-full-access' },
      'auto-approve': { sandbox: 'workspace-write', approval: 'ask', name: '自动审批（Flash）' },
    },
    defaultPreset: 'workspace-write',
  })

  // 预置学习状态（在插件模块加载前写入，触发「确认满阈值 → 同类验证」分支）：
  // key = bash|danger-full-access|neutral 已确认 3 次（= 阈值），有 2 个样本、无指纹 → verifySimilarity 接管
  // （用 bash 而非 edit，避免与「RISKY:neutral 中立→人工确认」用例的 key 冲突）
  mkdirSync(join(testHome, 'auto-approve'), { recursive: true })
  writeFileSync(join(testHome, 'auto-approve', 'learning.json'), JSON.stringify({
    enabled: true,
    stats: { 'bash|danger-full-access|neutral': 3 },
    history: {
      'bash|danger-full-access|neutral': [
        { fp: null, ctx: '例行修改个人配置文件' },
        { fp: null, ctx: '调整工作区外工具配置' },
      ],
    },
  }), 'utf8')

  // 被测插件（默认仓库内 src/index.mjs；可用 AG_PLUGIN_PATH 指向旧版本做红/绿对照）
  const pluginPath = process.env.AG_PLUGIN_PATH || resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.mjs')
  const gateModule = await import(pathToFileURL(pluginPath).href)
  await ctx.plugin(gateModule.default)

  // ---- 契约断言：v0.1.5-rc2 的 permissionPresets API ----
  check('permissionPresets.current 存在且为函数', () => {
    assert.equal(typeof ctx.permissionPresets.current, 'function')
  })
  check('permissionPresets.currents 不存在（回归：issue#15/PR#1 的错改）', () => {
    assert.equal(typeof ctx.permissionPresets.currents, 'undefined')
  })

  // ---- 会话准备 ----
  const sessions = ctx.sessions
  const auto = sessions.create(SessionId('sess-auto-approve'))
  ctx.permissionPresets.set(auto, 'auto-approve')
  const plain = sessions.create(SessionId('sess-workspace-write'))

  check('真实服务：set 后 current(session) 返回 auto-approve', () => {
    assert.equal(ctx.permissionPresets.current(auto), 'auto-approve')
  })
  check('真实服务：默认会话 current(session) 返回 workspace-write', () => {
    assert.equal(ctx.permissionPresets.current(plain), 'workspace-write')
  })

  const fallback = async () => 'unavailable'
  const req = (session, reason, toolName = 'edit') => ({
    agent: { session },
    toolName,
    reason: reason || 'escalate sandbox to workspace-write: 修改项目配置文件以适配新版本',
    callId: undefined,
    signal: undefined,
  })
  const dispatch = (session, reason, toolName) => ctx.waterfall('approval/request', req(session, reason, toolName), fallback)

  // ---- 审批瀑布用例 ----
  await checkAsync('非 auto-approve 会话：不抛错，直接放行下游（unavailable）', async () => {
    const out = await dispatch(plain)
    assert.equal(out, 'unavailable')
  })

  await checkAsync('auto-approve + flash SAFE：自动放行 allowed-once', async () => {
    llmVerdict = 'SAFE'
    const out = await dispatch(auto)
    assert.equal(out, 'allowed-once')
  })

  await checkAsync('auto-approve + flash RISKY:deletion：硬类别转人工（unavailable，不抛错）', async () => {
    llmVerdict = 'RISKY:deletion'
    const out = await dispatch(auto, 'escalate sandbox to danger-full-access: 删除不可再生的旧版数据目录')
    assert.equal(out, 'unavailable')
  })

  await checkAsync('auto-approve + flash RISKY:neutral：中立类别转人工确认（unavailable）', async () => {
    llmVerdict = 'RISKY:neutral'
    const out = await dispatch(auto, 'escalate sandbox to danger-full-access: 修改工作区外的个人配置文件')
    assert.equal(out, 'unavailable')
  })

  await checkAsync('auto-approve + DENY 危险词（rm -rf）：转人工（unavailable，不抛错）', async () => {
    llmVerdict = 'SAFE'
    const out = await dispatch(auto, 'escalate sandbox to danger-full-access: 需要 rm -rf 清理目录')
    assert.equal(out, 'unavailable')
  })

  await checkAsync('auto-approve + 命中默认白名单（workspace-write 越界）：直接放行 allowed-once', async () => {
    llmVerdict = 'SAFE'
    const out = await dispatch(auto, 'escalate sandbox to workspace-write: 写入项目 src/index.mjs 完成适配')
    assert.equal(out, 'allowed-once')
  })

  // ---- reasoningEffort 兼容（v0.1.5-rc2 第三方 provider 不支持 'off' 时不能硬传） ----
  await checkAsync('模型不支持 reasoningEffort off：flash 省略该字段仍能判定 SAFE → allowed-once', async () => {
    // 用第三方 provider 模型（同用户实际报错的 huoshan-186/DeepSeek-V4-Flash），与 deepseek 缓存键区分
    selectedModel = { provider: 'huoshan-186', model: 'DeepSeek-V4-Flash' }
    reasoningOffSupported = false
    llmVerdict = 'SAFE'
    lastStreamOptions = null
    const out = await dispatch(auto, 'escalate sandbox to danger-full-access: 修改工作区外的个人配置文件')
    assert.equal(out, 'allowed-once')
    assert.equal(lastStreamOptions.reasoningEffort, undefined, '不支持 off 时不应发送 reasoningEffort')
    selectedModel = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  })

  await checkAsync('模型支持 reasoningEffort off：发送 off 档位', async () => {
    reasoningOffSupported = true
    llmVerdict = 'SAFE'
    lastStreamOptions = null
    const out = await dispatch(auto, 'escalate sandbox to danger-full-access: 修改工作区外的个人配置文件')
    assert.equal(out, 'allowed-once')
    assert.equal(lastStreamOptions.reasoningEffort, 'off')
  })

  await checkAsync('模型带思考（reasoning-delta 含 RISKY 字样）：思考文本不污染结论解析 → SAFE', async () => {
    reasoningOffSupported = false
    emitReasoning = true
    llmVerdict = 'SAFE'
    lastStreamOptions = null
    const out = await dispatch(auto, 'escalate sandbox to danger-full-access: 修改工作区外的个人配置文件')
    assert.equal(out, 'allowed-once')
    emitReasoning = false
  })

  await checkAsync('模型带思考且结论为 RISKY:deletion：仍能正确识别硬类别 → 转人工', async () => {
    reasoningOffSupported = false
    emitReasoning = true
    llmVerdict = 'RISKY:deletion'
    lastStreamOptions = null
    const out = await dispatch(auto, 'escalate sandbox to danger-full-access: 删除不可再生的旧版数据目录')
    assert.equal(out, 'unavailable')
    emitReasoning = false
    reasoningOffSupported = true
  })

  // ---- 判定词解析加固（防误自动放行：只认末尾结论，正文里的 SAFE/RISKY 字样不算数） ----
  await checkAsync('正文含“SAFE”但结论不是 SAFE：不得自动放行 → 转人工（防误放行回归）', async () => {
    reasoningOffSupported = false
    llmVerdict = '该操作并不SAFE，需要人工确认'
    const out = await dispatch(auto, 'escalate sandbox to danger-full-access: 修改工作区外的个人配置文件')
    assert.equal(out, 'unavailable', '正文提到 SAFE 不应被误判为 safe 自动放行')
    reasoningOffSupported = true
  })

  await checkAsync('正文含“RISKY”但无末尾结论：不得判为 risky 硬类别放行/计数 → 转人工', async () => {
    reasoningOffSupported = false
    llmVerdict = '这个操作确实有 RISKY:deletion 的可能性，但需要进一步确认'
    const out = await dispatch(auto, 'escalate sandbox to danger-full-access: 修改工作区外的个人配置文件')
    assert.equal(out, 'unavailable')
    reasoningOffSupported = true
  })

  await checkAsync('末尾结论带标点（SAFE。）：正常判定为 safe → allowed-once', async () => {
    llmVerdict = 'SAFE。'
    const out = await dispatch(auto, 'escalate sandbox to danger-full-access: 修改工作区外的个人配置文件')
    assert.equal(out, 'allowed-once')
  })

  // ---- 同类验证（阈值已满 + 有样本 + 无指纹 → verifySimilarity；key = bash|danger-full-access|neutral） ----
  await checkAsync('同类验证 SAME（末尾结论）：flash 判同类 → 自动放行 allowed-once', async () => {
    llmVerdict = 'RISKY:neutral'
    similarityVerdict = 'SAME'
    const out = await dispatch(auto, 'escalate sandbox to danger-full-access: 修改工作区外的个人配置文件', 'bash')
    assert.equal(out, 'allowed-once')
  })

  await checkAsync('同类验证 DIFFERENT：判不同类 → 转人工 unavailable', async () => {
    llmVerdict = 'RISKY:neutral'
    similarityVerdict = 'DIFFERENT'
    const out = await dispatch(auto, 'escalate sandbox to danger-full-access: 修改工作区外的个人配置文件', 'bash')
    assert.equal(out, 'unavailable')
  })

  await checkAsync('同类验证正文含“SAME”但结论 DIFFERENT：不得误判同类 → 转人工', async () => {
    llmVerdict = 'RISKY:neutral'
    similarityVerdict = '两者有 SAME 之处，但整体 DIFFERENT'
    const out = await dispatch(auto, 'escalate sandbox to danger-full-access: 修改工作区外的个人配置文件', 'bash')
    assert.equal(out, 'unavailable')
  })

  // 事件文件已写入隔离目录（证明记录链路可用）
  check('事件记录已写入隔离 DSH_HOME（events.jsonl 存在）', () => {
    const eventsPath = join(testHome, 'auto-approve', 'events.jsonl')
    assert.equal(existsSync(eventsPath), true)
  })
} finally {
  rmSync(testHome, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`)
  process.exit(1)
}
console.log('\n全部用例通过（隔离环境，未触碰主进程）')
