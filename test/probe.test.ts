// src/probe.ts 与 src/fill.ts 用例：预声明 → 逐档探测 → 收敛写回的整条链（档位不支持的两条件判据、
// 与档位无关的失败（额度耗尽，及本功能自有的限流）短到模型尾而「参数不正确」不短、provider 级短路（含本组首个请求超时即短整组）、未跑完即还原、关自动写入整轮还原、剔除不支持、写回范围只认冻结的候选清单、帧序列与终帧里的写回统计）
import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import { probeAndFill } from '@/probe'
import { planEffortApply, declaredEffortsOf } from '@/fill'
import { API_NS, EFFORT_LEVELS } from '@/shared/constants'
import type { VerifyProgressFrame } from '@/shared/verify-progress'
import { makeStubCtx } from '@test/ctx'
import { check, stable } from '@test/helper'

const BLOCK_START = { type: 'block-start', index: 0, blockType: 'text' }
const FINISH_STOP = { type: 'finish', reason: { kind: 'stop' } }
/** 终止即报错：kind=error + failure.code，分类只看 code */
const finishError = (code: string, status?: number): StreamChunk =>
    ({ type: 'finish', reason: { kind: 'error', failure: { code, message: '文案随便写', ...(status === undefined ? {} : { status }) } } }) as unknown as StreamChunk
const ok = (): readonly StreamChunk[] => [BLOCK_START as unknown as StreamChunk, FINISH_STOP as unknown as StreamChunk]
/** 宿主归一出的中止终帧（`signal?.aborted || code === 'ABORTED'` → `aborted`） */
const finishAborted = (): readonly StreamChunk[] =>
    [{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: '文案随便写' } } } as unknown as StreamChunk]

/** 探测的请求计划：已声明 off 的模型发满七档，未声明的不发 off（与浏览器半 probeTargetsOf 同形） */
const target = (provider: unknown, model: unknown, hasOff = false) => ({
    provider, model,
    efforts: hasOff ? [...EFFORT_LEVELS] : [...EFFORT_LEVELS.filter((l) => l !== 'off')],
})

/** llm 桩：按「模型@档位 -> 分片序列」应答，未登记的组合默认成功；记录调用顺序。`onCall` 供用例在中途触发中止 */
const stub = (script: Record<string, readonly StreamChunk[]>, onCall?: (callIndex: number) => void) => {
    const calls: string[] = []
    const stream = (options: {
        provider: string
        model: string
        reasoningEffort?: string
        messages: readonly { role: string; content: readonly { type: 'text'; text: string }[] }[]
    }): AsyncIterable<StreamChunk> => {
        const tag = `${options.model}${options.reasoningEffort === undefined ? '' : `@${options.reasoningEffort}`}`
        calls.push(`${options.provider}/${tag}`)
        onCall?.(calls.length)
        const chunks = script[tag] ?? ok()
        return (async function* () { for (const chunk of chunks) yield chunk })()
    }
    return { llm: { stream } as unknown as Pick<LlmRuntime, 'stream'>, calls }
}

/** 造一轮的 ctx 桩：acme 下三个模型（m1 未填充、m2 只声明 off+high、m3 声明 off+low+high），排除列表含 lab */
function ctxOf(api?: Record<string, unknown>, plugin?: Record<string, unknown>) {
    return makeStubCtx({
        api: api ?? {
            providers: {
                acme: {
                    models: [
                        { id: 'm1', contextWindow: 128000 },
                        { id: 'm2', reasoningEfforts: { off: null, high: 'high' } },
                        { id: 'm3', reasoningEfforts: { off: null, low: 'low', high: 'high' } },
                    ],
                },
                lab: { models: [{ id: 'n1' }] },
            },
        },
        plugin: plugin ?? { 'version-7': { excludes: ['lab'] } },
    })
}
/** 取写回后的模型条目 */
const modelsOf = (ctx: ReturnType<typeof ctxOf>, provider: string): Record<string, unknown>[] =>
    (ctx.userOf(API_NS).providers as Record<string, { models?: Record<string, unknown>[] }>)[provider]?.models ?? []
/** 只看 reasoningEfforts，避免其余字段（contextWindow 等）干扰断言 */
const effortsOf = (ctx: ReturnType<typeof ctxOf>, provider: string, model: string): unknown =>
    modelsOf(ctx, provider).find((entry) => entry.id === model)?.reasoningEfforts
/** 模型配置段（llm-pi-ai）的写回调用；探测还会在自有段存取兜底备份，计数须分开 */
const apiWrites = (ctx: ReturnType<typeof ctxOf>) => ctx.mutateCalls.filter((c) => c.ns === API_NS)
/** 兜底备份的存取（自有段顶层键） */
const backupWrites = (ctx: ReturnType<typeof ctxOf>) => ctx.mutateCalls.filter((c) => c.ops.some((op) => op.path[0] === 'probeBackup'))

/** 执行本文件的全部用例 */
export async function run(): Promise<void> {
    // ---------- 计划：逐档七条 + 两个开关的入参校验 ----------
    {
        const ctx = ctxOf()
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({})
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')] }, { onProgress: (f) => { frames.push(f) } })
        check(
            '探测未声明 off 的模型发六档（按 EFFORT_LEVELS 去 off 由低到高），opened.total 与实际发的一致',
            calls.length === 6 && stable(calls) === stable(EFFORT_LEVELS.filter((l) => l !== 'off').map((level) => `acme/m1@${level}`)),
            calls,
        )
        check(
            '帧序列为 opened → 逐条 probed → done',
            frames[0].type === 'opened' && frames.at(-1)?.type === 'done'
            && frames.slice(1, -1).every((f) => f.type === 'probed') && frames.length === 8,
            frames.map((f) => f.type),
        )
        check(
            '全可用：可用档位明细六条逐条给出，统计为 6 档 / 1 模型',
            summary.usableEfforts.length === 6 && summary.efforts === 6 && summary.tested === 1
            && summary.plannedEfforts === 6 && summary.unsupported === 0,
            summary.usableEfforts,
        )
        // 预声明一次写回；七档全可用时算出的表与预声明完全一致 ⇒ 收敛零写入（幂等：反复重跑不该反复写）。
        // 只数 llm-pi-ai 段：兜底备份的存与清走自有段，不算模型配置写入
        check(
            '预声明写回一次，收敛零写入（模型配置段）',
            apiWrites(ctx).length === 1,
            ctx.mutateCalls.map((c) => `${c.ns}:${c.ops.length}`),
        )
        check(
            '兜底备份开跑前写进自有段、收敛后清掉（顶层键，与版本快照同级）',
            backupWrites(ctx).length === 2
            && backupWrites(ctx)[0].ops[0]?.op === 'set'
            && backupWrites(ctx)[1].ops[0]?.op === 'unset',
            backupWrites(ctx).map((c) => c.ops),
        )
        check(
            '未声明 off 的模型被补满六档（不含 off，其余为档位名本身）',
            stable(effortsOf(ctx, 'acme', 'm1')) === stable({ minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }),
            effortsOf(ctx, 'acme', 'm1'),
        )
        check(
            '终帧带写回统计，且对齐用户视角的那份配置：本轮只探了 m1，补满六档即新增 6 条',
            stable(summary.fill) === stable({ models: 1, added: 6, removed: 0 }),
            summary.fill,
        )
        // 清单外的提供方整条不动：预声明与收敛都只按清单覆盖，lab 不在清单里
        check('清单外的提供方不预声明不写回（键整个不出现）', modelsOf(ctx, 'lab')[0].reasoningEfforts === undefined, modelsOf(ctx, 'lab'))
    }
    {
        // 同一提供方的不同模型并行，但每个模型自身的推理档位不能重叠。
        const api = {
            providers: {
                acme: {
                    models: Array.from({ length: 4 }, (_, index) => ({ id: `m${index + 1}`, contextWindow: 128000 })),
                },
            },
        }
        const ctx = ctxOf(api, { 'version-7': { excludes: [] } })
        const activeByModel = new Map<string, number>()
        const calls: string[] = []
        let active = 0
        let maxActive = 0
        let maxForOneModel = 0
        const llm = {
            stream: (options: {
                provider: string
                model: string
                reasoningEffort?: string
                messages: readonly { role: string; content: readonly { type: 'text'; text: string }[] }[]
            }) => {
                const tag = `${options.model}${options.reasoningEffort === undefined ? '' : `@${options.reasoningEffort}`}`
                calls.push(`${options.provider}/${tag}`)
                return (async function* () {
                    const modelActive = (activeByModel.get(options.model) ?? 0) + 1
                    activeByModel.set(options.model, modelActive)
                    active += 1
                    maxActive = Math.max(maxActive, active)
                    maxForOneModel = Math.max(maxForOneModel, modelActive)
                    await new Promise<void>((resolve) => setTimeout(resolve, 5))
                    active -= 1
                    activeByModel.set(options.model, modelActive - 1)
                    yield BLOCK_START as unknown as StreamChunk
                    yield FINISH_STOP as unknown as StreamChunk
                })()
            },
        } as unknown as Pick<LlmRuntime, 'stream'>
        const summary = await probeAndFill(
            ctx as unknown as Context,
            llm,
            { models: Array.from({ length: 4 }, (_, index) => target('acme', `m${index + 1}`)) },
        )
        check(
            '同一提供方最多三模型并行、单模型等级串行',
            calls.length === 24 && summary.probed === 24 && maxActive === 3 && maxForOneModel === 1
            && Array.from({ length: 4 }, (_, index) => `m${index + 1}`).every((model) =>
                stable(calls.filter((call) => call.startsWith(`acme/${model}@`)).map((call) => call.split('@').at(-1)))
                    === stable(EFFORT_LEVELS.filter((level) => level !== 'off')),
            ),
            { calls: calls.length, probed: summary.probed, maxActive, maxForOneModel },
        )
    }
    {
        // 聚合器的实际 provider 仍是 bifrost；模型 ID 首段分别作为逻辑渠道，短路不能跨渠道传播。
        const ctx = ctxOf({
            providers: {
                bifrost: {
                    models: [
                        { id: 'freelane/deepseek-v4.1-flash-free' },
                        { id: 'freelane/other-model' },
                        { id: 'tokenrhythm/deepseek-v4-flash' },
                        { id: 'wb/cn:deepseek-v4.1-flash' },
                    ],
                },
            },
        })
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({
            'freelane/deepseek-v4.1-flash-free@minimal': [finishError('TRANSPORT')],
        })
        const summary = await probeAndFill(
            ctx as unknown as Context,
            llm,
            {
                models: [
                    target('bifrost', 'freelane/deepseek-v4.1-flash-free'),
                    target('bifrost', 'freelane/other-model'),
                    target('bifrost', 'tokenrhythm/deepseek-v4-flash'),
                    target('bifrost', 'wb/cn:deepseek-v4.1-flash'),
                ],
            },
            { onProgress: (frame) => { frames.push(frame) } },
        )
        const freelane = summary.providers.find((item) => item.provider === 'freelane')
        const tokenrhythm = summary.providers.find((item) => item.provider === 'tokenrhythm')
        const wb = summary.providers.find((item) => item.provider === 'wb')
        check(
            '聚合器：freelane 的网络错误只短路 freelane，tokenrhythm 与 wb 继续完成',
            freelane?.blockedBy === 'unreachable' && freelane.planned === 12 && freelane.probed < freelane.planned
            && tokenrhythm !== undefined && tokenrhythm.blockedBy === undefined && tokenrhythm.probed === tokenrhythm.planned
            && wb !== undefined && wb.blockedBy === undefined && wb.probed === wb.planned
            && summary.probed === calls.length && summary.planned === 24,
            { reports: summary.providers, called: calls.length, planned: summary.planned, probed: summary.probed },
        )
        check(
            'wb/cn:model 简单归到 wb；被跳过的 freelane 请求明确显示 freelane 原因',
            wb !== undefined
            && calls.some((call) => call.startsWith('bifrost/wb/cn:deepseek-v4.1-flash@'))
            && frames.some((frame) => frame.type === 'probed' && frame.route === 'freelane' && frame.skippedReason === 'unreachable')
            && calls.filter((call) => call.startsWith('bifrost/freelane/')).every((call) => call.endsWith('@minimal')),
            { reports: summary.providers.map((item) => item.provider), calls, frames: frames.filter((frame) => frame.type === 'probed' && frame.skippedReason !== undefined) },
        )
    }
    {
        // 首请求超时也按逻辑渠道隔离：另一个渠道已成功不能掩盖 freelane 自身的首请求超时。
        const ctx = ctxOf({
            providers: {
                bifrost: {
                    models: [
                        { id: 'freelane/deepseek-v4.1-flash-free' },
                        { id: 'tokenrhythm/deepseek-v4-flash' },
                    ],
                },
            },
        })
        const { llm, calls } = stub({
            'freelane/deepseek-v4.1-flash-free@minimal': [finishError('TIMEOUT')],
        })
        const summary = await probeAndFill(ctx as unknown as Context, llm, {
            models: [
                target('bifrost', 'freelane/deepseek-v4.1-flash-free'),
                target('bifrost', 'tokenrhythm/deepseek-v4-flash'),
            ],
        })
        const freelane = summary.providers.find((item) => item.provider === 'freelane')
        const tokenrhythm = summary.providers.find((item) => item.provider === 'tokenrhythm')
        check(
            '聚合器：freelane 的首请求超时只短路 freelane，不受 tokenrhythm 的成功影响',
            freelane !== undefined && freelane.blockedBy === 'timeout' && freelane.probed === 1 && freelane.planned === 6
            && tokenrhythm !== undefined && tokenrhythm.blockedBy === undefined && tokenrhythm.probed === 6
            && summary.probed === calls.length,
            { reports: summary.providers, calls },
        )
    }
    {
        // 适配器的 stream() 可能在返回迭代器前同步抛错；此时应按单次 other 处理，不得让整轮崩掉。
        const ctx = ctxOf()
        let calls = 0
        const llm = {
            stream: () => {
                calls++
                throw new Error('synchronous adapter failure')
            },
        } as unknown as Pick<LlmRuntime, 'stream'>
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')] })
        check(
            'stream() 同步抛错按 other 结算并继续完成整轮',
            calls === 6 && summary.planned === 6 && summary.probed === 6
            && summary.results.every((result) => result.outcome === 'other'),
            { calls, planned: summary.planned, probed: summary.probed, outcomes: summary.results.map((item) => item.outcome) },
        )
    }
    {
        // 剔除不支持：off 已跑通、low 被判参数不正确 ⇒ low 判「不支持」并**从原有档位里剔掉**。
        // 这正是两个开关的分野：关着时 low 只被记录，配置里原样保留
        const ctx = ctxOf()
        const { llm } = stub({ 'm3@low': [finishError('INVALID_REQUEST', 400)] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, {
            models: [target('acme', 'm3', true)],
            dropUnsupported: true,
        })
        check(
            '剔除不支持：原有档位里被判不支持的 low 被去掉，其余（新增的与原有的）照留',
            stable(Object.keys(effortsOf(ctx, 'acme', 'm3') as Record<string, unknown>)) === stable(['off', 'minimal', 'medium', 'high', 'xhigh', 'max'])
            && summary.unsupported === 1 && summary.fill?.removed === 1,
            { efforts: effortsOf(ctx, 'acme', 'm3'), fill: summary.fill },
        )
        check(
            '不支持档位明细逐条给出',
            stable(summary.unsupportedEfforts) === stable([{ provider: 'acme', model: 'm3', effort: 'low' }]),
            summary.unsupportedEfforts,
        )
    }
    {
        // 关掉剔除不支持：档位表 = 可用 ∪ 原有，low 判不支持也只记录、不动配置
        const ctx = ctxOf()
        const { llm } = stub({ 'm3@low': [finishError('INVALID_REQUEST', 400)] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm3', true)] })
        check(
            '关剔除不支持：只增不减，被判不支持的 low 仍在表里',
            stable(Object.keys(effortsOf(ctx, 'acme', 'm3') as Record<string, unknown>)) === stable([...EFFORT_LEVELS])
            && summary.unsupported === 1 && summary.fill?.removed === 0,
            { efforts: effortsOf(ctx, 'acme', 'm3'), fill: summary.fill },
        )
    }
    {
        // 判「档位不支持」要两个条件：宿主判参数不正确 **且** 已有更低档跑通。
        // 第一档（minimal，未声明 off 故 off 不在计划里）就被判参数不正确时第二个条件不满足 ——
        // 那更可能是模型本身的问题，判成「这一档不支持」会把一个其实能用的档位误判掉，故只记 other
        const ctx = ctxOf()
        const { llm, calls } = stub({ 'm1@minimal': [finishError('INVALID_REQUEST', 400)] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')] })
        check(
            '第一档被参数错误拒绝时不判档位不支持（无更低档作对照），且参数不正确不参与模型级短路：六档照发',
            calls.length === 6 && summary.unsupported === 0 && summary.unsupportedEfforts.length === 0
            && summary.results[0].outcome === 'other',
            { calls, first: summary.results[0] },
        )
        check(
            '只有被拒的那一档不进档位表：其余五档验通了就照补',
            stable(Object.keys(effortsOf(ctx, 'acme', 'm1') as Record<string, unknown>)) === stable(['low', 'medium', 'high', 'xhigh', 'max'])
            && summary.fill?.added === 5,
            { efforts: effortsOf(ctx, 'acme', 'm1'), fill: summary.fill },
        )
    }
    {
        // 一档都没验通 ⇒ 档位表算空 ⇒ 整个 reasoningEfforts 键删掉（回到未声明态，不留空壳）。
        // 顺带钉住判据：厂商侧拒绝（含上游 5xx）断不得「后续必然失败」，故七档一条不少地发完
        const ctx = ctxOf()
        const dead = Object.fromEntries(EFFORT_LEVELS.filter((l) => l !== 'off').map((level) => [`m1@${level}`, [finishError('PI_AI_ERROR')]]))
        const { llm, calls } = stub(dead)
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')] })
        check(
            '全档没跑通时档位表算空：字段整个删掉（等同未声明，不留空壳），且厂商侧拒绝不短档位尾',
            calls.length === 6 && effortsOf(ctx, 'acme', 'm1') === undefined && summary.usableEfforts.length === 0 && summary.fill?.models === 0,
            { calls, efforts: effortsOf(ctx, 'acme', 'm1'), fill: summary.fill },
        )
    }
    {
        // 限流是本功能自有的模型级短路（瞬态里唯一短的）：限流不分档位，同窗内同 key 换档照样 429，
        // 而没跑满的模型整轮还原（档位表不动、无误杀），短到模型尾只省请求；超时仍不短
        const ctx = ctxOf()
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'm1@low': [finishError('RATE_LIMIT', 429)] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1'), target('acme', 'm2', true)] }, {
            onProgress: (f) => { frames.push(f) },
        })
        check(
            '限流短到模型尾：m1 只发到第二档（skipped 为该模型剩余四档），m2 照发满七档',
            calls.length === 9 && calls.filter((c) => c.startsWith('acme/m1')).length === 2
            && summary.probed === 9 && summary.planned === 13 && summary.providers[0].blockedBy === undefined,
            { calls, report: summary.providers[0] },
        )
        check(
            '限流只否定这一档：不判不支持、不进不支持明细，记录区留下该模型一条并交代还剩几条',
            summary.results[1].outcome === 'rate-limit' && summary.unsupported === 0
            && frames.filter((f) => f.type === 'probed' && f.model === 'm1' && f.skipped === 4).length === 1
            && frames.filter((f) => f.type === 'probed' && f.model === 'm2').length === 7,
            { results: summary.results, frames: frames.filter((f) => f.type === 'probed').map((f) => `${f.model}:${f.outcome}:${f.skipped ?? 0}`) },
        )
        check(
            '被限流短路的模型算「没跑完」：原样还原（m1 无字段），m2 照补满七档',
            effortsOf(ctx, 'acme', 'm1') === undefined
            && stable(Object.keys(effortsOf(ctx, 'acme', 'm2') as Record<string, unknown>)) === stable([...EFFORT_LEVELS]),
            { m1: effortsOf(ctx, 'acme', 'm1'), m2: effortsOf(ctx, 'acme', 'm2') },
        )
    }
    {
        // 额度耗尽与档位无关：短到该模型自己的档位尾，别的模型照探
        const ctx = ctxOf()
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'm1@minimal': [finishError('QUOTA', 429)] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1'), target('acme', 'm2', true)] }, {
            onProgress: (f) => { frames.push(f) },
        })
        check(
            '额度耗尽短到模型尾：m1 只发第一档（skipped 为该模型剩余五档），m2 照发满七档',
            calls.length === 8 && calls.filter((c) => c.startsWith('acme/m1')).length === 1
            && summary.probed === 8 && summary.planned === 13 && summary.providers[0].blockedBy === undefined,
            { calls, report: summary.providers[0] },
        )
        check(
            '被短的模型在记录区留下一条并交代还剩几条，别的提供方结论不受影响',
            frames.filter((f) => f.type === 'probed' && f.model === 'm1' && f.skipped === 5).length === 1
            && frames.filter((f) => f.type === 'probed' && f.model === 'm2').length === 7,
            frames.filter((f) => f.type === 'probed').map((f) => `${f.model}:${f.outcome}:${f.skipped ?? 0}`),
        )
        check(
            '额度耗尽的模型算「没跑完」：原样还原（m1 无字段），m2 照补满七档',
            effortsOf(ctx, 'acme', 'm1') === undefined
            && stable(Object.keys(effortsOf(ctx, 'acme', 'm2') as Record<string, unknown>)) === stable([...EFFORT_LEVELS]),            { m1: effortsOf(ctx, 'acme', 'm1'), m2: effortsOf(ctx, 'acme', 'm2') },
        )
    }
    {
        // provider 级失败短路整组：该组剩余条数一条都不发，被短路的模型不产生可用结论
        const ctx = ctxOf()
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'm1@minimal': [finishError('TRANSPORT')] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1'), target('acme', 'm2', true)] }, { onProgress: (frame) => { frames.push(frame) } })
        check(
            '端点不可达后停止派发：并行的另一个模型请求可能已在途，blockedBy 为 unreachable',
            calls.length >= 2 && calls.length <= 3 && summary.probed === calls.length && summary.planned === 13
            && summary.providers[0].blockedBy === 'unreachable' && !summary.providers[0].reachable,
            { calls, report: summary.providers[0] },
        )
        check('因端点不可达而跳过的未派发请求明确带上跳过原因，而不是伪装成用户中止', frames.some((frame) => frame.type === 'probed' && frame.skippedReason === 'unreachable' && (frame.skipped ?? 0) > 0), frames.filter((frame) => frame.type === 'probed'))
        // 两个模型都没跑完 ⇒ 原样还原预声明之前的档位表（m1 无字段、m2 回到 off+high）
        check(
            '没跑完的模型原样还原：m1 字段不出现、m2 回到预声明之前的两档',
            effortsOf(ctx, 'acme', 'm1') === undefined
            && stable(effortsOf(ctx, 'acme', 'm2')) === stable({ off: null, high: 'high' }),
            { m1: effortsOf(ctx, 'acme', 'm1'), m2: effortsOf(ctx, 'acme', 'm2') },
        )
        check('全组被短路时零写入（还原后与原值相同）', summary.fill?.models === 0 && apiWrites(ctx).length === 2, summary.fill)
    }
    {
        // 本组首个请求就超时：成因在请求之外——url 不可达、端点服务中断、本地网络不通，
        // 再逐条等下去只是把同样的 30 秒乘上几十遍，故短整组（本功能没有基线，首个请求就是该模型的第一档）
        const ctx = ctxOf()
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'm1@minimal': [finishError('TIMEOUT')] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1'), target('acme', 'm2', true)] }, { onProgress: (frame) => { frames.push(frame) } })
        check(
            '首个发出的请求超时后停止继续派发（已在途请求会收尾），blockedBy 记 timeout',
            calls.length >= 2 && calls.length <= 3 && summary.probed === calls.length && summary.planned === 13
            // 理由记「超时」而非「不可达」，reachable 也不翻假：超时只是没等到受理，不是传输层失败的证据
            && summary.providers[0].blockedBy === 'timeout' && summary.providers[0].reachable,
            { calls, report: summary.providers[0] },
        )
        check('因提供方级超时而跳过的未派发请求保留 timeout 原因', frames.some((frame) => frame.type === 'probed' && frame.skippedReason === 'timeout' && (frame.skipped ?? 0) > 0), frames.filter((frame) => frame.type === 'probed'))
        check(
            '首个超时的两个模型都算没跑完：原样还原（m1 无字段、m2 回到预声明之前的两档）',
            effortsOf(ctx, 'acme', 'm1') === undefined
            && stable(effortsOf(ctx, 'acme', 'm2')) === stable({ off: null, high: 'high' }),
            { m1: effortsOf(ctx, 'acme', 'm1'), m2: effortsOf(ctx, 'acme', 'm2') },
        )
    }
    {
        // 首个之后的超时：链路已经跑通过，只是这一次慢——照旧瞬态处理，不短整组也不短该模型的档位尾
        const ctx = ctxOf()
        const { llm, calls } = stub({ 'm1@low': [finishError('TIMEOUT')] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1'), target('acme', 'm2', true)] })
        check(
            '首个之后的超时不当不可达：整组照发满十三条，blockedBy 为空',
            calls.length === 13 && summary.probed === 13 && summary.planned === 13
            && summary.providers[0].blockedBy === undefined && summary.providers[0].reachable
            && summary.usableEfforts.length === 12,
            { calls, report: summary.providers[0] },
        )
        // 超时那一档算「这次没跑成」，既不算可用也不算不支持：不开剔除时档位表就是可用 ∪ 原有
        check(
            '超时那一档不补进档位表，其余五档照补',
            stable(Object.keys(effortsOf(ctx, 'acme', 'm1') as Record<string, unknown>)) === stable(EFFORT_LEVELS.filter((level) => level !== 'off' && level !== 'low')),
            effortsOf(ctx, 'acme', 'm1'),
        )
    }
    {
        // 中止：整轮还原——已跑完的那个模型也不补（必须完全跑完才谈补全），且中止不发 done 帧
        const ctx = ctxOf()
        const controller = new AbortController()
        const frames: VerifyProgressFrame[] = []
        const { llm } = stub({}, (index) => { if (index === 8) controller.abort() })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1'), target('acme', 'm2', true)] }, {
            signal: controller.signal,
            onProgress: (f) => { frames.push(f) },
        })
        check('中止时不发 done 帧', frames.every((f) => f.type !== 'done'), frames.map((f) => f.type))
        check(
            '中止即整轮还原：连跑满六档的 m1 也回到未声明，m2 保持原有两档',
            effortsOf(ctx, 'acme', 'm1') === undefined
            && stable(effortsOf(ctx, 'acme', 'm2')) === stable({ off: null, high: 'high' }),
            { m1: effortsOf(ctx, 'acme', 'm1'), m2: effortsOf(ctx, 'acme', 'm2') },
        )
        check('中止时零写入（整轮还原后与原值相同）', summary.fill?.models === 0, summary.fill)
    }
    {
        // 上游自己报 ABORTED 而我们并未中止：不入账但不短档位尾，后面照探；
        // 少了这一条即 probed < planned，该模型被既有「没跑满即还原」挡住，半截结论不写回
        const ctx = ctxOf()
        const { llm, calls } = stub({ 'm1@low': finishAborted() })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')] })
        check(
            '上游中止不入账但不短档位尾：后续档位照探，且该模型按「没跑满」还原',
            calls.length === 6 && summary.results.every((item) => item.outcome !== 'aborted')
            && summary.usableEfforts.every((item) => item.effort !== 'low')
            && effortsOf(ctx, 'acme', 'm1') === undefined && summary.fill?.models === 0,
            { calls, results: summary.results, efforts: effortsOf(ctx, 'acme', 'm1'), fill: summary.fill },
        )
    }
    {
        // 关「自动写入」：探测照常预声明与执行，结论只算不写——全部模型原样还原预声明之前的
        // 档位表（与中止同一形态），终帧的 fill 是「可补全」假设统计，兜底备份照存照清
        const ctx = ctxOf()
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({})
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1'), target('acme', 'm2', true)], autoWrite: false }, {
            onProgress: (f) => { frames.push(f) },
        })
        check('关自动写入：探测照常跑满且终帧照发', calls.length === 13 && frames.at(-1)?.type === 'done', { calls: calls.length, frames: frames.map((f) => f.type) })
        check(
            '关自动写入：整轮不落结论，m1 回到未声明、m2 回到原有两档（与中止同一形态）',
            effortsOf(ctx, 'acme', 'm1') === undefined
            && stable(effortsOf(ctx, 'acme', 'm2')) === stable({ off: null, high: 'high' }),
            { m1: effortsOf(ctx, 'acme', 'm1'), m2: effortsOf(ctx, 'acme', 'm2') },
        )
        check(
            '关自动写入：终帧带「可补全」假设统计（m1 全缺 +6、m2 缺五档 +5），兜底备份照存照清、还原照常写回',
            stable(summary.fill) === stable({ models: 2, added: 11, removed: 0 })
            && backupWrites(ctx).length === 2
            && backupWrites(ctx)[0].ops[0]?.op === 'set' && backupWrites(ctx)[1].ops[0]?.op === 'unset'
            && apiWrites(ctx).length === 2,
            { fill: summary.fill, backup: backupWrites(ctx).map((c) => c.ops), api: apiWrites(ctx).length },
        )
    }
    {
        // 写回范围只认冻结的候选清单：进了清单即照写
        const ctx = ctxOf()
        const { llm, calls } = stub({})
        await probeAndFill(ctx as unknown as Context, llm, { models: [target('lab', 'n1')] })
        check(
            '进了候选清单即照常预声明与写入',
            calls.length === 6 && stable(Object.keys(effortsOf(ctx, 'lab', 'n1') as Record<string, unknown>)) === stable(EFFORT_LEVELS.filter((l) => l !== 'off')),
            { calls, efforts: effortsOf(ctx, 'lab', 'n1') },
        )
    }
    {
        // 开关必须是真的布尔：给了非布尔值按非法入参整轮拒绝，不替浏览器半猜语义
        const ctx = ctxOf()
        const { llm } = stub({})
        let message = ''
        try {
            await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')], dropUnsupported: 'yes' })
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check('开关给非布尔值即拒绝且一个字都没写', message.includes('探测请求不合法') && ctx.mutateCalls.length === 0, { message, writes: ctx.mutateCalls.length })
        try {
            await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')], autoWrite: 'yes' })
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check('「自动写入」给非布尔值同样拒绝且一个字都没写', message.includes('探测请求不合法') && ctx.mutateCalls.length === 0, { message, writes: ctx.mutateCalls.length })
    }
    {
        // 配额：探测按模型展开（7×模型数），模型数封顶 200，超出整体拒绝而非静默截断
        const ctx = ctxOf()
        const { llm } = stub({})
        const many = Array.from({ length: 201 }, (_, i) => target('acme', `m${i}`))
        let message = ''
        try {
            await probeAndFill(ctx as unknown as Context, llm, { models: many })
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check('超过模型数上限即整体拒绝，不截断也不写配置', message.includes('探测请求不合法') && ctx.mutateCalls.length === 0, message)
    }
    {
        // 档位不在支持取值内按非法入参拒绝（入参来自浏览器，仍按不可信输入校验）
        const ctx = ctxOf()
        const { llm } = stub({})
        let message = ''
        try {
            await probeAndFill(ctx as unknown as Context, llm, { models: [{ provider: 'acme', model: 'm1', efforts: ['turbo'] }] })
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check('档位越界即拒绝', message.includes('探测请求不合法') && ctx.mutateCalls.length === 0, message)
    }

    // ---------- 纯函数：planEffortApply 的两种统计口径与范围判定 ----------
    const providers = {
        acme: {
            models: [
                { id: 'm1', reasoningEfforts: { off: null, high: 'high' }, contextWindow: 128000 },
                { id: 'm2', reasoningEfforts: { off: null, high: 'high' } },
                { id: 'plain' },
            ],
        },
        lab: { models: [{ id: 'n1' }] },
    }
    const apply = (entries: readonly { provider: string; model: string; levels: readonly string[] }[]) =>
        planEffortApply(providers, entries)
    {
        // 算出的档位表与现有相同 ⇒ 零变更零 op（幂等：重跑一轮不该反复写）
        const same = apply([{ provider: 'acme', model: 'm2', levels: ['off', 'high'] }])
        check('档位表算出来与现有相同：零 op', same.modelOps.length === 0 && same.models === 0, same)
        // 同提供方多模型合并为一条整段 set，未命中的模型原样保留
        const two = apply([
            { provider: 'acme', model: 'm1', levels: ['off', 'low', 'high'] },
            { provider: 'acme', model: 'm2', levels: [] },
        ])
        const written = two.modelOps[0]?.op === 'set' ? two.modelOps[0].value : undefined
        check(
            '同提供方两个模型合并为一条整段 set，未命中的模型原样保留',
            two.modelOps.length === 1 && stable(written) === stable([
                { id: 'm1', reasoningEfforts: { off: null, low: 'low', high: 'high' }, contextWindow: 128000 },
                { id: 'm2' },
                { id: 'plain' },
            ]),
            two.modelOps,
        )
        // 空表即删键：不写空对象（空壳等同未声明，且会反复触发写入判定）
        check('空表删键时按原有档位表计删除条数（m2 原有两档）', two.models === 2 && two.added === 1 && two.removed === 2, two)
        // 范围只由 entries 决定
        const listed = apply([{ provider: 'lab', model: 'n1', levels: ['off'] }])
        check('进了 entries 即照写', listed.modelOps.length === 1 && listed.models === 1, listed)
        // 目标在当次配置里不存在（探测途中被删）即静默不命中，不产出 op
        const gone = apply([{ provider: 'acme', model: 'removed', levels: ['off'] }])
        check('entries 里的目标已不在配置中：零 op、零统计', gone.modelOps.length === 0 && gone.models === 0, gone)
        // 模型 id 可含 '/'：键用二元组序列化，与 verifyKey 同口径
        const slashed = planEffortApply({ acme: { models: [{ id: 'z-ai/glm-5' }] } }, [{ provider: 'acme', model: 'z-ai/glm-5', levels: ['off'] }])
        check('模型 id 含斜杠仍按二元组键命中', slashed.models === 1, slashed)
        // 原有档位表读取：只认纯对象的键并按规范次序排序，未声明即空表
        check(
            'declaredEffortsOf 只取键、按 EFFORT_LEVELS 排序、未声明即空表',
            stable([...declaredEffortsOf(providers, [{ provider: 'acme', model: 'm1', levels: [] }, { provider: 'acme', model: 'plain', levels: [] }]).values()]) === stable([['off', 'high'], []])
            && declaredEffortsOf(providers, [{ provider: 'lab', model: 'n1', levels: [] }]).get(JSON.stringify(['lab', 'n1']))?.length === 0,
            [...declaredEffortsOf(providers, [{ provider: 'acme', model: 'm1', levels: [] }]).values()],
        )
        // 补齐档位时保留已有键的线拼写（如 high:'ultra'），不为所有键重写默认值
        const customProviders = { acme: { models: [{ id: 'mc', reasoningEfforts: { off: 'none', high: 'ultra' } }] } }
        const customApply = planEffortApply(customProviders, [{ provider: 'acme', model: 'mc', levels: ['off', 'low', 'high', 'xhigh'] }])
        const customWritten = customApply.modelOps[0]?.op === 'set' ? customApply.modelOps[0].value : undefined
        check(
            '补齐档位时保留已有线拼写（off:none 与 high:ultra 原样保留，新补的取档位名）',
            stable(customWritten) === stable([{ id: 'mc', reasoningEfforts: { off: 'none', low: 'low', high: 'ultra', xhigh: 'xhigh' } }]),
            customApply.modelOps,
        )
        // 七档外的键（宿主 schema 允许、运行期忽略的手改残留）重建时原样保留
        const strayApply = planEffortApply(
            { acme: { models: [{ id: 'mc', reasoningEfforts: { off: 'none', ultra: 'ultra' } }] } },
            [{ provider: 'acme', model: 'mc', levels: ['off', 'high'] }],
        )
        const strayWritten = strayApply.modelOps[0]?.op === 'set' ? strayApply.modelOps[0].value : undefined
        check(
            '七档之外的键在重建时保留（off:none 与 ultra 原样，high 新补）',
            stable(strayWritten) === stable([{ id: 'mc', reasoningEfforts: { off: 'none', ultra: 'ultra', high: 'high' } }]),
            strayApply.modelOps,
        )
    }
    {
        // 自有段缺失 ⇒ 兜底备份无处可放，整轮中止（预声明一旦写下就可能来不及收回，没有退路就不动用户配置）。
        const ctx = makeStubCtx({ api: { providers: { acme: { models: [{ id: 'm1' }] } } }, noPlugin: true })
        const { llm } = stub({})
        let message = ''
        try {
            await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')] })
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check(
            '自有段不可读即中止：显式失败且模型配置一个字节都没动',
            message.includes('自有配置段') && apiWrites(ctx).length === 0,
            message,
        )
    }
}
