// 用例覆盖：src/probe-verdict.ts 的失败分类与两级短路判据、src/probe-plan.ts 的请求计划展开（验证每模型一条 /
// 探测逐档展开 / 入参校验与配额）与按提供方分组、src/probe-report.ts 的逐组汇报与汇总求和，以及 src/verify.ts
// 带桩跑通的整条执行链（每模型一条请求 + 分组串行 + provider 级短路，含「本组首个请求超时即短整组」
// 与进度帧的 done 不变量），以及 src/probe-engine.ts 的 probeOnce 超时兜底（软超时发中止信号、宽限期满即硬兜底返回、
// 命中即返回时中止先于迭代器关闭发出、被放弃的循环不再消费分片也不产未处理拒绝）
import { verifyModels } from '@/verify'
import { probeOnce, runProbeGroups, type GroupRunner } from '@/probe-engine'
import { groupProbesByProvider, planProbes } from '@/probe-plan'
import { reportProvider, summarizeProviders } from '@/probe-report'
import { classifyFailure, providerBlockReason, shouldSkipModelTail } from '@/probe-verdict'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm/types'
import { decodeProgressFrame, encodeProgressFrame, isProviderBlocking, isTransientOutcome } from '@/shared/verify-progress'
import type { ProbeOutcome, ProviderBlockReason, VerifyFailureFacts, VerifyProbe, VerifyProbeResult, VerifyProbedFrame, VerifyProgressFrame, VerifyProviderReport } from '@/shared/verify-progress'
import { check, stable } from '@test/helper'

/** 一个模型的载荷；参数收 unknown 以便构造非法入参用例（RPC 入参按不可信输入校验） */
const entry = (provider: unknown, model: unknown, efforts?: unknown): Record<string, unknown> =>
    efforts === undefined ? { provider, model } : { provider, model, efforts }

/** 失败事实桩：message 各厂商不同，分类不得依赖它 */
const failure = (code: string, status?: number): LlmFailure =>
    ({ code, message: '文案随便写，各厂商都不一样', ...(status === undefined ? {} : { status }) }) as LlmFailure

/** 分片桩：成功流先吐 block-start，终止流只吐 finish */
const BLOCK_START = { type: 'block-start', index: 0, blockType: 'text' }
const FINISH_STOP = { type: 'finish', reason: { kind: 'stop' } }
const finishError = (code: string, status?: number): StreamChunk =>
    ({ type: 'finish', reason: { kind: 'error', failure: failure(code, status) } }) as unknown as StreamChunk

/** 宿主归一出的中止终帧（`signal?.aborted || code === 'ABORTED'` → `aborted`，见 docs/host-api.md） */
const FINISH_ABORTED = { type: 'finish', reason: { kind: 'aborted', failure: failure('ABORTED') } } as unknown as StreamChunk

/** 失败事实（`VerifyFailureFacts`）桩：只给 code 与 message，status 恒缺（pi-ai 路径即如此） */
const failureFacts = (code: string): VerifyFailureFacts => ({ code, status: undefined, message: '文案随便写' })

/** probeOnce 用的探测入参（所有用例都探同一个「a/m1@off」） */
const probeOf = (): Pick<VerifyProbe, 'provider' | 'model' | 'effort'> =>
    ({ provider: 'a', model: 'm1', effort: 'off' })

/** 永不 settle 且不理会 signal 的流桩：模拟「适配器忽略 signal 并停在未决 await 上」这一宿主回归形态。`probeOnce` 若没有硬兜底，读流就会永远挂在这里 */
const deafStream = (): Pick<LlmRuntime, 'stream'> => ({
    stream: () => ({
        [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<StreamChunk>>(() => {}),
        }),
    }) as AsyncIterable<StreamChunk>,
})

/** 不理 signal 但持续产出的流桩：每 5ms 给一块 text-delta、永不 finish，并记录被消费的块数与是否被请求关闭。用来观测「硬兜底之后被放弃的循环是否还在后台继续消费」——没修的话它会一直读下去 */
const endlessStream = (): { llm: Pick<LlmRuntime, 'stream'>; chunks: () => number; closed: () => boolean } => {
    let chunks = 0
    let closed = false
    const stream = (): AsyncIterable<StreamChunk> => ({
        [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<StreamChunk>> => {
                await new Promise((resolve) => { setTimeout(resolve, 5) })
                chunks += 1
                return { done: false, value: { type: 'text-delta', index: 0, delta: 'x' } as unknown as StreamChunk }
            },
            return: async (): Promise<IteratorResult<StreamChunk>> => { closed = true; return { done: true, value: undefined } },
        }),
    })
    return { llm: { stream } as unknown as Pick<LlmRuntime, 'stream'>, chunks: () => chunks, closed: () => closed }
}

/** 先给一块 `block-start`（命中「已开始产出」的提前返回），此后 `next()` 与迭代器 `return()` 都永不 settle，并按发生顺序记录「中止信号发出」与「迭代器被请求关闭」。用来钉住 #19：命中时 abort 必须立刻发出——不排在被放弃的迭代器关闭之后，更不等它 settle。旧写法（`for await` 的隐式关闭）会一直挂在关闭上，`probeOnce` 永不返回 */
const hitThenHangStream = (): { llm: Pick<LlmRuntime, 'stream'>; order: string[] } => {
    const order: string[] = []
    let nextCalls = 0
    const stream = (options: { signal?: AbortSignal }): AsyncIterable<StreamChunk> => {
        options.signal?.addEventListener('abort', () => { order.push('abort') })
        return {
            [Symbol.asyncIterator]: () => ({
                next: (): Promise<IteratorResult<StreamChunk>> => {
                    nextCalls += 1
                    if (nextCalls === 1) return Promise.resolve({ done: false, value: BLOCK_START as unknown as StreamChunk })
                    return new Promise<IteratorResult<StreamChunk>>(() => {})
                },
                return: (): Promise<IteratorResult<StreamChunk>> => {
                    order.push('close')
                    return new Promise<IteratorResult<StreamChunk>>(() => {})
                },
            }),
        }
    }
    return { llm: { stream } as unknown as Pick<LlmRuntime, 'stream'>, order }
}

/** 等待指定毫秒（真定时器，供「块数停止增长」这类时间相关的断言留出余量） */
const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** 执行本文件的全部用例 */
export async function run(): Promise<void> {
    // ---------- planProbes：验证每模型一条请求（不带档位参数）；探测档位条目按档位逐条展开 ----------
    check(
        'planProbes 探测档位条目逐档展开，验证条目一条',
        stable(planProbes({ models: [entry('a', 'm1'), entry('a', 'm2', ['low'])] })) === stable([
            { provider: 'a', model: 'm1' },
            { provider: 'a', model: 'm2', effort: 'low' },
        ]),
    )
    check(
        'planProbes 空数组与缺省同形（一次不带档位的请求）',
        stable(planProbes({ models: [entry('a', 'plain', []), entry('a', 'x', ['max'])] })) === stable([
            { provider: 'a', model: 'plain' },
            { provider: 'a', model: 'x', effort: 'max' },
        ]),
    )
    // ---------- planProbes：入参校验一律拒绝 ----------
    check('planProbes 非对象拒绝', planProbes(undefined) === undefined)
    check('planProbes models 非数组拒绝', planProbes({ models: {} }) === undefined)
    check('planProbes models 空数组拒绝', planProbes({ models: [] }) === undefined)
    check('planProbes 条目非对象拒绝', planProbes({ models: ['a'] }) === undefined)
    check('planProbes provider 非字符串拒绝', planProbes({ models: [entry('', 'm')] }) === undefined)
    check('planProbes model 非字符串拒绝', planProbes({ models: [entry('a', 1)] }) === undefined)
    check('planProbes efforts 非数组拒绝', planProbes({ models: [entry('a', 'm', 'low')] }) === undefined)
    check('planProbes 档位非字符串拒绝', planProbes({ models: [entry('a', 'm', [1])] }) === undefined)
    // 档位必须落在 harness 支持的取值内（'none' 是目录侧拼写，写入配置时已归一为 'off'）
    check('planProbes 未知档位拒绝', planProbes({ models: [entry('a', 'm', ['turbo'])] }) === undefined)
    check('planProbes 目录拼写 none 拒绝', planProbes({ models: [entry('a', 'm', ['none'])] }) === undefined)
    // ---------- planProbes：请求总数超上限即拒绝（逐档位展开会累积条目，静默截断会漏验） ----------
    const many = Array.from({ length: 100 }, (_, i) => entry('a', `m${i}`, ['low', 'medium', 'high']))
    check('planProbes 超上限拒绝', planProbes({ models: many }) === undefined)
    // 清单一条即一次请求：40 个四档模型 = 160 条，验证侧则是勾选模型数
    const atLimit = Array.from({ length: 40 }, (_, i) => entry('a', `m${i}`, ['low', 'medium', 'high', 'off']))
    check('planProbes 恰在上限放行', planProbes({ models: atLimit })?.length === 160)
    check('planProbes 验证 200 个模型恰在上限放行', planProbes({ models: Array.from({ length: 200 }, (_, i) => entry('a', `m${i}`)) })?.length === 200)
    // 再多一个即 201 > 200
    check('planProbes 验证 201 个模型拒绝', planProbes({ models: Array.from({ length: 201 }, (_, i) => entry('a', `m${i}`)) }) === undefined)

    // ---------- groupProbesByProvider：同 provider 归一组、组内原序、下标回填 ----------
    const interleaved: VerifyProbe[] = [
        { provider: 'a', model: 'm1', effort: 'off' },
        { provider: 'b', model: 'n1', effort: 'low' },
        { provider: 'a', model: 'm2', effort: 'high' },
    ]
    check(
        'groupProbesByProvider 按 provider 归组并保序',
        stable(groupProbesByProvider(interleaved)) === stable([
            { provider: 'a', indexes: [0, 2], probes: [interleaved[0], interleaved[2]] },
            { provider: 'b', indexes: [1], probes: [interleaved[1]] },
        ]),
        groupProbesByProvider(interleaved),
    )
    check('groupProbesByProvider 空输入得空组', groupProbesByProvider([]).length === 0)

    // ---------- classifyFailure：只认 code 与 status，绝不比对文案 ----------
    check('classifyFailure 档位不被支持', classifyFailure(failure('UNSUPPORTED_REASONING_EFFORT')) === 'unsupported-effort')
    check('classifyFailure 额度耗尽', classifyFailure(failure('QUOTA', 429)) === 'quota')
    // 宿主给账户余额不足定的字面量就是 ACCOUNT_QUOTA（宿主 `error.js`），写成 ACCOUNT_QUOTA_EXCEEDED 永不命中
    check('classifyFailure 余额耗尽', classifyFailure(failure('ACCOUNT_QUOTA', 402)) === 'quota')
    check('classifyFailure 凭据无效', classifyFailure(failure('INVALID_CREDENTIAL', 401)) === 'credential')
    check('classifyFailure 凭据缺失', classifyFailure(failure('MISSING_CREDENTIAL', 401)) === 'credential')
    // 不可达只认传输层失败码。pi-ai 侧错误一律不带 status（宿主抛错只给 message + code），
    // 故「无 status」不能当不可达——那会把一次 400 或一次 5xx 误报成断线并短路整个 provider，这是实测踩过的坑
    check('classifyFailure 传输层失败码判端点不可达', classifyFailure(failure('TRANSPORT')) === 'unreachable')
    check('classifyFailure 流被截断亦判不可达', classifyFailure(failure('STREAM_CLOSED')) === 'unreachable')
    check('classifyFailure 未识别的码归其它而非不可达', classifyFailure(failure('PI_AI_ERROR')) === 'other')
    check('classifyFailure 有 status 归其它', classifyFailure(failure('MODEL_NOT_FOUND', 404)) === 'other')
    // 档位码优先：它由宿主在派发前本地抛出，本就没有 HTTP 响应
    check('classifyFailure 档位码不被 status 盖过', classifyFailure(failure('UNSUPPORTED_REASONING_EFFORT', 400)) === 'unsupported-effort')
    // 零内容完成：请求成功抵达却无内容块，归其它（退化完成），不参与任何短路
    check('classifyFailure 零内容完成归其它而非不可达', classifyFailure(failure('EMPTY_RESPONSE')) === 'other')
    // 瞬态：本次没跑成，不是否定模型或档位的证据。实测 429 挡掉的那一档，隔一会儿就通了，
    // 当成「不可用」还顺手跳过后续档位，等于把一次抖动固化成结论
    check('classifyFailure 上游限流归瞬态而非不可用', classifyFailure(failure('RATE_LIMIT', 429)) === 'rate-limit')
    check('classifyFailure 上游超时归瞬态而非不可用', classifyFailure(failure('TIMEOUT')) === 'timeout')
    // 中止不是失败：用户按的停止与上游主动中止都归到它，落到「其它」会把停止说成厂商拒绝
    check('classifyFailure 中止单列一态', classifyFailure(failure('ABORTED')) === 'aborted')

    // ---------- isProviderBlocking：单看自身就否定整个提供方的只有端点不通与凭据无效 ----------
    check('isProviderBlocking 端点不可达', isProviderBlocking('unreachable') === true)
    check('isProviderBlocking 额度耗尽不短路（额度可能只覆盖其中某个模型）', isProviderBlocking('quota') === false)
    check('isProviderBlocking 凭据无效', isProviderBlocking('credential') === true)
    check('isProviderBlocking 档位不支持不短路', isProviderBlocking('unsupported-effort') === false)
    check('isProviderBlocking 其它失败不短路', isProviderBlocking('other') === false)
    check('isProviderBlocking 可用不短路', isProviderBlocking('usable') === false)
    check('isProviderBlocking 限流不短路（换个时间可能就通）', isProviderBlocking('rate-limit') === false)

    // ---------- providerBlockReason：判据只有「能断定后续请求必然失败」 ----------
    check('providerBlockReason 端点不通与凭据无效照旧短路', providerBlockReason('unreachable', false) === 'unreachable' && providerBlockReason('credential', true) === 'credential')
    check('providerBlockReason 首个请求超时短整组，理由记 timeout 而非 unreachable', providerBlockReason('timeout', true) === 'timeout')
    check('providerBlockReason 首个之后的超时不短路（链路已经跑通过，只是这一次慢）', providerBlockReason('timeout', false) === undefined)
    check('providerBlockReason 首个请求限流不当不可达（端点明明有应答）', providerBlockReason('rate-limit', true) === undefined)
    check('providerBlockReason 额度耗尽即便首个也不短整组（额度可能只覆盖其中某个模型）', providerBlockReason('quota', true) === undefined)
    check('providerBlockReason 可用不短路', providerBlockReason('usable', true) === undefined)
    check('providerBlockReason 厂商侧拒绝不短整组（多半是服务端的一次性故障）', providerBlockReason('other', true) === undefined)

    // ---------- shouldSkipModelTail：档位请求上只有额度耗尽能断定后续必然失败（探测档位自有判据） ----------
    check('shouldSkipModelTail 额度耗尽短到该模型尾', shouldSkipModelTail('quota', failureFacts('QUOTA')) === true)
    check('shouldSkipModelTail 上游 5xx 不断（换个档位可能就通）', shouldSkipModelTail('other', failureFacts('SERVER')) === false)
    check('shouldSkipModelTail 参数不正确不断（它正是「只否定这一档」的候选）', shouldSkipModelTail('other', failureFacts('INVALID_REQUEST')) === false)
    check('shouldSkipModelTail 限流与超时不断（只否定了这一次）', shouldSkipModelTail('rate-limit', failureFacts('RATE_LIMIT')) === false && shouldSkipModelTail('timeout', failureFacts('TIMEOUT')) === false)
    check('shouldSkipModelTail 可用不短', shouldSkipModelTail('usable', undefined) === false)
    check('shouldSkipModelTail 退化完成（有结论但无失败事实）不短', shouldSkipModelTail('quota', undefined) === false)

    // ---------- isTransientOutcome：瞬态既不算不可用，也不能用来短该模型的后续档位 ----------
    check('isTransientOutcome 限流', isTransientOutcome('rate-limit') === true)
    check('isTransientOutcome 超时', isTransientOutcome('timeout') === true)
    check('isTransientOutcome 厂商侧拒绝不是瞬态', isTransientOutcome('other') === false)
    check('isTransientOutcome 档位不支持不是瞬态', isTransientOutcome('unsupported-effort') === false)
    check('isTransientOutcome 可用不是瞬态', isTransientOutcome('usable') === false)

    // ---------- reportProvider：可用模型去重、档位不支持单列、可达与凭据取自全程 ----------
    const detail = (model: string, outcome: ProbeOutcome, effort?: string): VerifyProbeResult =>
        ({ provider: 'a', model, effort, outcome, failure: undefined })
    // tested 取自计划而非明细，故与 results 无关，桩里固定给 2
    const report = (results: VerifyProbeResult[], blockedBy?: 'unreachable' | 'credential') =>
        reportProvider({ provider: 'a', results, blockedBy, planned: 3, plannedEfforts: 3, tested: 2 })
    const allOk = report([detail('m1', 'usable', 'off'), detail('m1', 'usable', 'high'), detail('m2', 'usable', 'low')])
    check(
        'reportProvider 全可用：同模型多档只计一个可用模型',
        stable(allOk) === stable({
            provider: 'a', reachable: true, keyValid: true, skipped: false, blockedBy: undefined,
            models: 2, efforts: 3, unsupported: 0, planned: 3, plannedEfforts: 3, probed: 3, tested: 2,
        }),
        allOk,
    )
    const oneUnsupported = report([detail('m1', 'usable', 'off'), detail('m1', 'unsupported-effort', 'high'), detail('m2', 'usable', 'low')])
    check(
        'reportProvider 档位不支持单列，不混入其它失败',
        stable(oneUnsupported) === stable({
            provider: 'a', reachable: true, keyValid: true, skipped: false, blockedBy: undefined,
            models: 2, efforts: 2, unsupported: 1, planned: 3, plannedEfforts: 3, probed: 3, tested: 2,
        }),
        oneUnsupported,
    )
    const dead = report([detail('m1', 'unreachable')], 'unreachable')
    check(
        'reportProvider 端点不可达：短路且不臆断凭据有效',
        stable(dead) === stable({
            provider: 'a', reachable: false, keyValid: false, skipped: true, blockedBy: 'unreachable',
            models: 0, efforts: 0, unsupported: 0, planned: 3, plannedEfforts: 3, probed: 1, tested: 2,
        }),
        dead,
    )
    // 可达但额度耗尽：端点通、凭据没被否——额度多半是按模型设的，否定不了整把 key。
    // 额度不构成 provider 级短路，故此处不带 blockedBy；出了什么事看 m1 自己的明细条目
    const outOfQuota = report([detail('m1', 'usable', 'off'), detail('m1', 'quota', 'high')])
    check(
        'reportProvider 额度耗尽：可达且不否凭据（额度是模型级事实），不算 provider 级失败',
        stable(outOfQuota) === stable({
            provider: 'a', reachable: true, keyValid: true, skipped: false, blockedBy: undefined,
            models: 1, efforts: 1, unsupported: 0, planned: 3, plannedEfforts: 3, probed: 2, tested: 2,
        }),
        outOfQuota,
    )
    // 验证侧的全同形（不带档位）：可用数计模型，档位相关计数全 0
    const verifyShape = report([detail('m1', 'usable'), detail('m2', 'quota')])
    check(
        'reportProvider 不带档位的明细：可用计模型数、档位计数恒 0',
        stable(verifyShape) === stable({
            provider: 'a', reachable: true, keyValid: true, skipped: false, blockedBy: undefined,
            models: 1, efforts: 0, unsupported: 0, planned: 3, plannedEfforts: 3, probed: 2, tested: 2,
        }),
        verifyShape,
    )

    // ---------- summarizeProviders：逐字段求和 ----------
    const ok: VerifyProviderReport = {
        provider: 'a', reachable: true, keyValid: true, skipped: false, blockedBy: undefined,
        models: 2, efforts: 3, unsupported: 1, planned: 3, plannedEfforts: 3, probed: 3, tested: 2,
    }
    const blocked: VerifyProviderReport = {
        provider: 'b', reachable: false, keyValid: false, skipped: true, blockedBy: 'unreachable',
        models: 0, efforts: 0, unsupported: 0, planned: 5, plannedEfforts: 4, probed: 1, tested: 3,
    }
    const details: VerifyProbeResult[] = [detail('m1', 'usable', 'off')]
    check(
        'summarizeProviders 求和（短路组的计划数计入、实测数只计已发出的、tested 取自各组计划）',
        stable(summarizeProviders([ok, blocked], details)) === stable({
            providers: [ok, blocked], results: details, unsupportedEfforts: [], usableEfforts: [{ provider: 'a', model: 'm1', effort: 'off' }], tested: 5, models: 2, efforts: 3, unsupported: 1, planned: 8, plannedEfforts: 7, probed: 4,
        }),
        summarizeProviders([ok, blocked], details),
    )
    check(
        'summarizeProviders 空输入',
        stable(summarizeProviders([], [])) === stable({
            providers: [], results: [], unsupportedEfforts: [], usableEfforts: [], tested: 0, models: 0, efforts: 0, unsupported: 0, planned: 0, plannedEfforts: 0, probed: 0,
        }),
    )
    // 不支持档位明细由结果派生：探测档位要写配置就得逐条定位，聚合与明细同源、不另立口径
    const unsupportedDetail = [
        { provider: 'a', model: 'm1', effort: 'high', outcome: 'unsupported-effort', failure: undefined },
    ] as VerifyProbeResult[]
    check(
        'summarizeProviders 不支持档位明细逐条给出',
        stable(summarizeProviders([], unsupportedDetail).unsupportedEfforts)
        === stable([{ provider: 'a', model: 'm1', effort: 'high' }]),
        summarizeProviders([], unsupportedDetail).unsupportedEfforts,
    )
    // 可用档位明细与不支持明细同源同构：探测档位据此写回补全，两处各筛一遍必然分叉
    const usableDetail = [
        { provider: 'a', model: 'm1', effort: 'high', outcome: 'usable', failure: undefined },
        // 不带档位的请求验的是模型本身，没有「哪一档可用」可言，不进这两只明细
        { provider: 'a', model: 'm2', effort: undefined, outcome: 'usable', failure: undefined },
    ] as VerifyProbeResult[]
    check(
        'summarizeProviders 可用档位明细逐条给出，且不含不带档位的条目',
        stable(summarizeProviders([], usableDetail).usableEfforts)
        === stable([{ provider: 'a', model: 'm1', effort: 'high' }]),
        summarizeProviders([], usableDetail).usableEfforts,
    )
    // tested 记「计划里探过的模型」而非「可用的模型」：全档位被短路的模型也要计入，否则总数小于用户勾选数。
    // 它取自各组汇报的 tested，故与明细是否为空无关
    const allFailed: VerifyProviderReport = {
        provider: 'a', reachable: true, keyValid: true, skipped: false, blockedBy: undefined,
        models: 0, efforts: 0, unsupported: 0, planned: 2, plannedEfforts: 2, probed: 0, tested: 1,
    }
    check(
        'summarizeProviders tested 计入全档位被短路的模型，与可用模型数分开',
        summarizeProviders([allFailed], []).tested === 1 && summarizeProviders([allFailed], []).models === 0,
        summarizeProviders([allFailed], []),
    )

    // ---------- verifyModels：带桩跑通整条链，每模型一条请求、逐组串行且 provider 级短路 ----------
    /** 桩：按「提供方/模型 -> 分片序列」应答，未登记的模型默认成功；记录调用顺序与提示词；`onCall` 供用例在中途触发中止 */
    const stub = (script: Record<string, readonly StreamChunk[]>, onCall?: (callIndex: number) => void) => {
        const calls: string[] = []
        const prompts: string[] = []
        const stream = (options: {
            provider: string
            model: string
            reasoningEffort?: string
            messages: readonly { role: string; content: readonly { type: 'text'; text: string }[] }[]
        }): AsyncIterable<StreamChunk> => {
            const tag = `${options.provider}/${options.model}`
            calls.push(tag)
            prompts.push(options.messages[0].content[0].text)
            onCall?.(calls.length)
            const chunks = script[tag] ?? [BLOCK_START as unknown as StreamChunk, FINISH_STOP as unknown as StreamChunk]
            return (async function* () { for (const chunk of chunks) yield chunk })()
        }
        return { llm: { stream } as unknown as Pick<LlmRuntime, 'stream'>, calls, prompts }
    }

    {
        const { llm, prompts, calls } = stub({})
        const summary = await verifyModels(llm, { models: [entry('a', 'm1'), entry('a', 'm2'), entry('b', 'n1')] })
        check(
            'verifyModels 全可用：每模型一条请求并逐组汇报',
            summary.models === 3 && summary.efforts === 0 && summary.unsupported === 0
            && summary.planned === 3 && summary.plannedEfforts === 0 && summary.probed === 3 && summary.tested === 3
            && calls.length === 3
            && summary.providers.length === 2 && summary.providers[0].reachable && summary.providers[1].reachable,
            { calls, summary },
        )
        // 明细：逐条给出「提供方 / 模型 / 结论」，顺序为「组序 → 组内模型序」；不带档位
        check(
            'verifyModels 返回逐条明细（不带档位）',
            stable(summary.results) === stable([
                { provider: 'a', model: 'm1', effort: undefined, outcome: 'usable', failure: undefined },
                { provider: 'a', model: 'm2', effort: undefined, outcome: 'usable', failure: undefined },
                { provider: 'b', model: 'n1', effort: undefined, outcome: 'usable', failure: undefined },
            ]),
            summary.results,
        )
        // 提示词固定为一句 Just say OK——它是省额度的前提，不该被顺手改成更啰嗦的说法
        check('verifyModels 每次请求的提示词都是 Just say OK', prompts.length === 3 && prompts.every((text) => text === 'Just say OK'), prompts)
    }
    {
        // 额度耗尽：只否定这个模型的一次请求，不构成 provider 级失败，也不否凭据
        // ——它是模型级事实，同组其它模型照验
        const { llm, calls } = stub({ 'a/m1': [finishError('QUOTA', 429)] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1'), entry('a', 'm2')] })
        check(
            'verifyModels 额度耗尽不牵连同组其它模型，也不算 provider 级失败',
            calls.length === 2 && summary.probed === 2 && summary.planned === 2
            && !summary.providers[0].skipped && summary.providers[0].blockedBy === undefined
            && summary.providers[0].reachable && summary.providers[0].keyValid,
            { calls, summary },
        )
        // 明细须带上失败的原始事实，调用方可据此做比本插件更细的分类与展示
        check(
            'verifyModels 明细带失败原始事实',
            stable(summary.results) === stable([
                {
                    provider: 'a', model: 'm1', effort: undefined, outcome: 'quota',
                    failure: { code: 'QUOTA', status: 429, message: '文案随便写，各厂商都不一样' },
                },
                { provider: 'a', model: 'm2', effort: undefined, outcome: 'usable', failure: undefined },
            ]),
            summary.results,
        )
    }
    {
        // 限流只否定了这一次：不得算进不可用。实测踩过的坑——某一模型被 429 挡掉，
        // 记录写「不可用」隔一会儿手动一聊又完全正常
        const { llm, calls } = stub({ 'a/m1': [finishError('RATE_LIMIT', 429)] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1'), entry('a', 'm2')] })
        check(
            'verifyModels 限流单列，不混成不可用，同组其它模型照验',
            calls.length === 2 && summary.models === 1 && summary.probed === 2
            && stable(summary.results[0].outcome) === stable('rate-limit'),
            { calls, summary },
        )
    }
    {
        // 端点不可达：同一提供方共用 url 与 key，整组必然同样失败，短整组
        const { llm, calls } = stub({ 'a/m1': [finishError('TRANSPORT')] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1'), entry('a', 'm2')] })
        check(
            'verifyModels 端点不可达短路并记为不可达',
            calls.length === 1 && summary.probed === 1 && summary.planned === 2
            && summary.providers[0].blockedBy === 'unreachable'
            && !summary.providers[0].reachable && !summary.providers[0].keyValid,
            { calls, summary },
        )
    }
    {
        // 厂商侧拒绝（如该模型不存在）多与具体模型有关，不短整组：同 provider 的其它模型照验
        const { llm, calls } = stub({ 'a/m1': [finishError('MODEL_NOT_FOUND', 404)] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1'), entry('a', 'm2')] })
        check(
            'verifyModels 其它厂商拒绝不短路',
            calls.length === 2 && summary.probed === 2 && summary.models === 1
            && summary.providers[0].reachable && summary.providers[0].keyValid && !summary.providers[0].skipped,
            { calls, summary },
        )
    }
    {
        // 零内容完成是「请求成功抵达、但一个内容块都没有」，既非 provider 级失败也不该短路：
        // 若漏判就会把一次成功响应误报成端点断线，后面的模型全部不再验证
        const { llm, calls } = stub({ 'a/m1': [finishError('EMPTY_RESPONSE')] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1'), entry('a', 'm2')] })
        check(
            'verifyModels 零内容完成不短路',
            calls.length === 2 && summary.probed === 2 && summary.models === 1
            && summary.providers[0].reachable && !summary.providers[0].skipped,
            { calls, summary },
        )
    }
    {
        // 两个提供方互不牵连：一个不可达，另一个照常验证
        const { llm, calls } = stub({ 'a/m1': [finishError('TRANSPORT')] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1'), entry('b', 'n1')] })
        check(
            'verifyModels 短路只影响本组',
            summary.providers.length === 2 && summary.providers[0].skipped === true
            && summary.providers[1].skipped === false && summary.providers[1].models === 1,
            { calls, summary },
        )
    }
    {
        // 同一真实 provider 下按模型首段分逻辑渠道：freelane 不可达不能短 tokenrhythm / wb。
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'bifrost/freelane/m1': [finishError('TRANSPORT')] })
        const summary = await verifyModels(llm, {
            models: [
                entry('bifrost', 'freelane/m1'),
                entry('bifrost', 'tokenrhythm/m1'),
                entry('bifrost', 'freelane/m2'),
                entry('bifrost', 'wb/cn:model'),
            ],
        }, { onProgress: (frame) => { frames.push(frame) } })
        const freelane = summary.providers.find((report) => report.provider === 'freelane')
        const tokenrhythm = summary.providers.find((report) => report.provider === 'tokenrhythm')
        const wb = summary.providers.find((report) => report.provider === 'wb')
        check(
            'verifyModels 聚合器渠道隔离：只跳过 freelane，tokenrhythm 与 wb 仍出请求并正常汇总',
            stable(calls) === stable(['bifrost/freelane/m1', 'bifrost/tokenrhythm/m1', 'bifrost/wb/cn:model'])
            && freelane !== undefined && freelane.blockedBy === 'unreachable' && freelane.planned === 2 && freelane.probed === 1
            && tokenrhythm !== undefined && tokenrhythm.blockedBy === undefined && tokenrhythm.probed === 1
            && wb !== undefined && wb.blockedBy === undefined && wb.probed === 1
            && summary.planned === 4 && summary.probed === 3,
            { calls, providers: summary.providers, planned: summary.planned, probed: summary.probed },
        )
        check(
            'verifyModels 被跳过的逻辑渠道帧包含 route 与真实短路原因',
            frames.some((frame) => frame.type === 'probed' && frame.route === 'freelane' && frame.skippedReason === 'unreachable' && frame.skipped === 1),
            frames.filter((frame) => frame.type === 'probed'),
        )
    }
    {
        let threw = false
        try {
            await verifyModels(stub({}).llm, { models: [entry('a', 'm', ['turbo'])] })
        } catch {
            threw = true
        }
        check('verifyModels 入参非法抛错（由 RPC 层转失败结果）', threw)
    }
    {
        // 正常帧序列：opened 起 → 每条请求 probed → 收于唯一一条 done。
        // 同组内串行、组间并行，故帧序只按同组断言（换多组会交错）
        const frames: VerifyProgressFrame[] = []
        const { llm } = stub({})
        const summary = await verifyModels(llm, { models: [entry('a', 'm1'), entry('a', 'm2'), entry('a', 'm3')] }, {
            onProgress: (frame) => { frames.push(frame) },
        })
        const last = frames[frames.length - 1]
        check(
            'verifyModels 进度帧：opened 起、逐条 probed、done 收尾',
            stable(frames.slice(0, 4)) === stable([
                { type: 'opened', total: 3 },
                { type: 'probed', provider: 'a', model: 'm1', effort: undefined, outcome: 'usable', done: 1, total: 3 },
                { type: 'probed', provider: 'a', model: 'm2', effort: undefined, outcome: 'usable', done: 2, total: 3 },
                { type: 'probed', provider: 'a', model: 'm3', effort: undefined, outcome: 'usable', done: 3, total: 3 },
            ]) && frames.length === 5 && last.type === 'done' && last.summary === summary,
            frames,
        )
    }
    {
        // 进度契约的不变式：任何分支下每帧 done ≤ total，且整轮跑完落在 total 上（跳过条目计入）
        const frames: VerifyProgressFrame[] = []
        const { llm } = stub({ 'a/m1': [finishError('TRANSPORT')], 'b/n1': [finishError('RATE_LIMIT', 429)] })
        await verifyModels(llm, {
            models: [entry('a', 'm1'), entry('a', 'm2'), entry('b', 'n1')],
        }, { onProgress: (frame) => { frames.push(frame) } })
        const probed = frames.filter((frame): frame is VerifyProbedFrame => frame.type === 'probed')
        check(
            'verifyModels 全程 done ≤ total 且整轮跑完落在 total 上',
            probed.every((frame) => frame.done <= frame.total)
            && probed[probed.length - 1].done === probed[probed.length - 1].total,
            probed,
        )
    }
    {
        // 端点不通那条 probed 自带 skipped：消费方才好交代「这组还剩几条没验」
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'a/m1': [finishError('INVALID_CREDENTIAL', 401)] })
        await verifyModels(llm, { models: [entry('a', 'm1'), entry('a', 'm2'), entry('a', 'm3')] }, {
            onProgress: (frame) => { frames.push(frame) },
        })
        check(
            'verifyModels provider 级短路那条 probed 带 skipped',
            calls.length === 1 && stable(frames[1]) === stable({
                type: 'probed', provider: 'a', model: 'm1', effort: undefined, outcome: 'credential', skipped: 2, done: 3, total: 3,
            }),
            frames,
        )
    }
    {
        // 本组首个请求就超时：成因在请求之外——url 不可达、端点服务中断、本地网络不通，
        // 后面每个模型再等一次只是把同样的 30 秒乘上几十遍，故短整组
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'a/m1': [finishError('TIMEOUT')] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1'), entry('a', 'm2'), entry('a', 'm3')] }, {
            onProgress: (frame) => { frames.push(frame) },
        })
        check(
            'verifyModels 首个请求超时短整组，blockedBy 记 timeout',
            calls.length === 1 && summary.probed === 1 && summary.planned === 3 && summary.tested === 3
            // 理由记「超时」而非「不可达」，reachable 也不翻假：超时只是没等到受理，不是传输层失败的证据
            && summary.providers[0].blockedBy === 'timeout' && summary.providers[0].reachable
            && stable(frames[1]) === stable({
                type: 'probed', provider: 'a', model: 'm1', effort: undefined, outcome: 'timeout', skipped: 2, done: 3, total: 3,
            }) && frames[2].type === 'done',
            { calls, summary, frames },
        )
    }
    {
        // 首个之后的超时：链路已经跑通过，只是这一次慢——照旧瞬态处理，不短整组
        const { llm, calls } = stub({ 'a/m2': [finishError('TIMEOUT')] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1'), entry('a', 'm2'), entry('a', 'm3')] })
        check(
            'verifyModels 首个之后的超时不当不可达：后面的模型照验',
            calls.length === 3 && summary.probed === 3 && summary.planned === 3
            && summary.providers[0].blockedBy === undefined && summary.providers[0].reachable
            && summary.models === 2,
            { calls, summary },
        )
    }
    {
        // 中止：桩不理会信号本身，这里要验的是「已中止即不再发新请求」与「不发 done」。
        // 两组建并发跑：第 2 次调用（另一组的）落地即中止，a 组随后要发的 m2 被拦下，
        // 已发出且跑完的两条照常入账
        const controller = new AbortController()
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({}, (index) => { if (index === 2) controller.abort() })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1'), entry('a', 'm2'), entry('b', 'n1')] }, {
            signal: controller.signal,
            onProgress: (frame) => { frames.push(frame) },
        })
        check(
            'verifyModels 中止后早停且不发 done',
            calls.length === 2 && frames.every((frame) => frame.type !== 'done')
            && summary.probed === 2 && summary.planned === 3,
            { calls, frames, summary },
        )
    }
    {
        // 中止撞在在途请求上：宿主给 `aborted` 终帧。它没有结论——不记「不可用」，也不短路
        const controller = new AbortController()
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'a/m1': [FINISH_ABORTED] }, () => controller.abort())
        const summary = await verifyModels(llm, { models: [entry('a', 'm1'), entry('a', 'm2')] }, {
            signal: controller.signal,
            onProgress: (frame) => { frames.push(frame) },
        })
        check(
            'verifyModels 中止不入账不发帧（不记成不可用、不甩锅短路）',
            calls.length === 1 && summary.results.length === 0
            && frames.filter((frame) => frame.type === 'probed').length === 0
            && frames.every((frame) => frame.type !== 'done'),
            { calls, frames, summary },
        )
    }
    {
        // 上游自己报 ABORTED 而我们并未中止：同样没有结论，但不能因此停下，后续模型照验
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'a/m1': [FINISH_ABORTED] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1'), entry('a', 'm2')] }, {
            onProgress: (frame) => { frames.push(frame) },
        })
        const probedFrames = frames.filter((frame) => frame.type === 'probed')
        check(
            'verifyModels 上游中止不入结果但继续验证，进度仍结算至 total',
            calls.length === 2 && summary.probed === 1 && summary.planned === 2 && summary.models === 1
            && stable(summary.results) === stable([
                { provider: 'a', model: 'm2', effort: undefined, outcome: 'usable', failure: undefined },
            ])
            && probedFrames.length === 2
            && probedFrames[0].type === 'probed' && probedFrames[0].outcome === 'aborted' && probedFrames[0].done === 1
            && probedFrames[1].type === 'probed' && probedFrames[1].done === 2
            && frames.at(-1)?.type === 'done',
            { calls, frames, summary },
        )
    }
    {
        // 六个提供方、五个 worker：第 3 次调用时中止，此时前 3 组已开跑、后 3 组从未开始。
        // 它们不该出现在汇报里——报成「可达且凭据有效」或「全不可用」都是撒谎，它压根没被验证过。
        const controller = new AbortController()
        const { llm } = stub({}, (index) => { if (index === 3) controller.abort() })
        const summary = await verifyModels(
            llm,
            { models: ['a', 'b', 'c', 'd', 'e', 'f'].map((provider) => entry(provider, 'm')) },
            { signal: controller.signal },
        )
        check(
            'verifyModels 从未开跑的提供方不进汇报',
            stable(summary.providers.map((report) => report.provider)) === stable(['a', 'b', 'c'])
            && summary.planned === 3 && summary.probed === 3 && summary.tested === 3 && summary.plannedEfforts === 0,
            summary.providers.map((report) => report.provider),
        )
    }

    // ---------- probeOnce 超时兜底：到点必然返回，不依赖适配器配合 ----------
    {
        // 适配器忽略 signal 且永不 settle（宿主回归形态）：probeOnce 必须自己在宽限期后返回——
        // 否则 runProbeGroups 的 Promise.all 永不 settle、probeAndFill 的 finally 永不执行、守卫永久为 true。
        // 时长一并验：传入的软超时与宽限生效（等的是 40ms 而非生产默认的 33s）
        const startedAt = Date.now()
        const verdict = await probeOnce(deafStream(), probeOf(), new AbortController().signal, 30, 10)
        check(
            'probeOnce 硬兜底：适配器忽略 signal 也自行返回 timeout（不挂死、参数化超时生效）',
            verdict.outcome === 'timeout' && verdict.failure === undefined && Date.now() - startedAt < 2_000,
            { verdict, elapsed: Date.now() - startedAt },
        )
    }
    {
        // 外部中止撞上不配合的适配器：兜底也必须归 aborted——用户按的停止不是超时，
        // 记成 timeout 会被当成「本组首个请求超时」而错误短掉整组
        const controller = new AbortController()
        controller.abort()
        const verdict = await probeOnce(deafStream(), probeOf(), controller.signal, 30, 10)
        check('probeOnce 硬兜底遇外部已中止归 aborted 而非 timeout', verdict.outcome === 'aborted' && verdict.failure === undefined, verdict)
    }
    {
        // 硬兜底不止「本函数返回」：被放弃的读流循环必须停止消费（省额度），且迭代器被请求关闭。
        // 迟到的块是放弃那一刻在途的那一次，其后必须为零增量
        const endless = endlessStream()
        const verdict = await probeOnce(endless.llm, probeOf(), new AbortController().signal, 30, 10)
        await wait(20)
        const settled = endless.chunks()
        await wait(60)
        check(
            'probeOnce 硬兜底后读流循环不再继续消费分片，且迭代器被请求关闭',
            verdict.outcome === 'timeout' && endless.chunks() === settled && endless.closed(),
            { verdict, settled, after: endless.chunks(), closed: endless.closed() },
        )
    }
    {
        // #19：命中 block-start 的提前返回路径上，中止信号必须立刻发出——不排在迭代器关闭之后，也不等它 settle。
        // 这条路径正是「命中即中断请求、省额度」最需要中止生效的场景；旧写法下这里会挂死在关闭上。
        const hit = hitThenHangStream()
        const startedAt = Date.now()
        const verdict = await probeOnce(hit.llm, probeOf(), new AbortController().signal, 30, 10)
        const elapsed = Date.now() - startedAt
        check(
            'probeOnce 命中即返回时中止信号先于迭代器关闭发出，且不等关闭 settle',
            verdict.outcome === 'usable' && elapsed < 2_000 && hit.order[0] === 'abort' && hit.order.includes('close'),
            { verdict, elapsed, order: hit.order },
        )
    }
    {
        // 被放弃的那次 next() 之后若才拒绝（适配器迟来的拒绝），不得变成未处理拒绝——
        // 那在宿主进程里是会终止进程的崩溃源
        const rejections: unknown[] = []
        const onRejection = (reason: unknown): void => { rejections.push(reason) }
        process.on('unhandledRejection', onRejection)
        const late = (): Pick<LlmRuntime, 'stream'> => ({
            stream: () => ({
                [Symbol.asyncIterator]: () => ({
                    next: () => new Promise<IteratorResult<StreamChunk>>((_, reject) => { setTimeout(() => reject(new Error('迟来的拒绝')), 40) }),
                }),
            }) as AsyncIterable<StreamChunk>,
        })
        const verdict = await probeOnce(late(), probeOf(), new AbortController().signal, 20, 10)
        await wait(100)
        process.off('unhandledRejection', onRejection)
        check('probeOnce 被放弃的 next() 迟来抛错不产生未处理拒绝', verdict.outcome === 'timeout' && rejections.length === 0, { verdict, rejections })
    }
    {
        // 组合层：Promise.all 只认 probeOnce settle——适配器忽略 signal 时整轮也必须收尾。
        // runGroup 注入小超时（真实链路里 runGroup 是 verify.ts / probe.ts 注入的那两个，此处只验编排与引擎的接缝）
        const runner: GroupRunner = async (llm, group, signal, emit) => {
            const results: VerifyProbeResult[] = []
            let blockedBy: ProviderBlockReason | undefined
            for (let index = 0; index < group.probes.length; index++) {
                const probe = group.probes[index]
                const verdict = await probeOnce(llm, probe, signal, 30, 10)
                const firstRequest = index === 0
                if (blockedBy === undefined) blockedBy = providerBlockReason(verdict.outcome, firstRequest)
                results.push({ provider: probe.provider, model: probe.model, effort: probe.effort, outcome: verdict.outcome, failure: verdict.failure })
                emit(probe, verdict, blockedBy === undefined ? { settled: 1 } : { settled: 1, skipped: group.probes.length - index - 1 })
                if (blockedBy !== undefined) break
            }
            return { provider: group.provider, results, blockedBy, planned: group.probes.length, plannedEfforts: group.probes.length, tested: group.probes.length }
        }
        const frames: VerifyProgressFrame[] = []
        const summary = await runProbeGroups(deafStream(), groupProbesByProvider([
            { provider: 'a', model: 'm1', effort: 'off' },
            { provider: 'a', model: 'm1', effort: 'high' },
            { provider: 'a', model: 'm1', effort: 'max' },
            { provider: 'a', model: 'm2', effort: 'low' },
        ]), runner, { onProgress: (frame) => { frames.push(frame) } })
        check(
            'runProbeGroups 在适配器忽略 signal 时仍整轮收尾：首个请求超时短整组、终帧由调用方照发',
            summary.probed === 1 && summary.planned === 4 && summary.providers.length === 1
            && summary.providers[0].blockedBy === 'timeout' && summary.providers[0].reachable
            && frames.length === 2 && frames[0].type === 'opened' && frames[1].type === 'probed'
            && frames[1].outcome === 'timeout' && frames[1].skipped === 3,
            { summary, frames },
        )
    }

    // ---------- 进度帧编解码：线上格式与形状校验 ----------
    const opened = encodeProgressFrame({ type: 'opened', total: 3 })
    check('encodeProgressFrame 输出 data 行加空行分隔', opened === 'data: {"type":"opened","total":3}\n\n', opened)
    check('decodeProgressFrame 往返一致', stable(decodeProgressFrame(opened)) === stable({ type: 'opened', total: 3 }))
    // SSE 心跳是注释行；我们不用 EventSource（它会自动重连，等于重跑整轮），但仍按格式容忍
    check('decodeProgressFrame 忽略注释帧', decodeProgressFrame(': connected') === undefined)
    check('decodeProgressFrame 忽略非法 JSON', decodeProgressFrame('data: {oops') === undefined)
    check('decodeProgressFrame 忽略非帧对象', decodeProgressFrame('data: {"type":"nope"}') === undefined)
    // done 帧直接驱动卡片上的统计数字，计数缺失就该判非法，而不是把 undefined 当 0 展示
    check('decodeProgressFrame 拒计数缺失的 done', decodeProgressFrame('data: {"type":"done","summary":{}}') === undefined)
    check(
        'decodeProgressFrame 接受收尾那行要用的四个计数齐全的 done',
        decodeProgressFrame('data: {"type":"done","summary":{"tested":2,"models":1,"efforts":3,"plannedEfforts":4}}') !== undefined,
    )
    check('decodeProgressFrame 拒字段缺失的 probed', decodeProgressFrame('data: {"type":"probed","provider":"a"}') === undefined)
    check(
        'decodeProgressFrame 接受无 effort 的 probed（不带档位的模型级结论，键缺省是合法形态）',
        stable(decodeProgressFrame('data: {"type":"probed","provider":"a","model":"m","outcome":"usable","done":1,"total":1}'))
        === stable({ type: 'probed', provider: 'a', model: 'm', outcome: 'usable', done: 1, total: 1 }),
    )
    // failed 终帧承载「整轮没能开跑」的真实原因，文案缺失即无信息可展示，故判非法
    check(
        'decodeProgressFrame 接受 failed 并原样带出文案',
        stable(decodeProgressFrame('data: {"type":"failed","message":"超出上限"}')) === stable({ type: 'failed', message: '超出上限' }),
    )
    check('decodeProgressFrame 拒无文案的 failed', decodeProgressFrame('data: {"type":"failed"}') === undefined
        && decodeProgressFrame('data: {"type":"failed","message":1}') === undefined)
}
