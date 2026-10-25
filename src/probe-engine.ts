/**
 * 最小请求的执行引擎：验证（每模型一次不带档位的请求）、探测档位（逐档请求）与能力探测（每「模型 × 能力」一条 wire 级请求）共用。
 * 设计裁决见 docs/decisions.md「验证」「探测档位」「能力探测」。
 */

import type { LlmRuntime, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
// LlmFailure 定义在 types 子路径（包根只 import 未再导出）；仅取类型，擦除后不落运行期依赖
import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'
import type { ProviderBlockReason, ProviderProbeOutcome, VerifyFailureFacts, VerifyProbe, VerifyProbeResult, VerifyProgressFrame, VerifyProviderReport, VerifySummary } from '@/shared/verify-progress'
import type { ProviderProbeGroup } from '@/probe-plan'
import { reportProvider, summarizeProviders } from '@/probe-report'
import { classifyFailure, type ProbeVerdict } from '@/probe-verdict'

/** 探测提示词：只要一句应答，最省 token */
const PROBE_PROMPT = 'Just say OK'
/** 单次探测的等待上限（毫秒）：超时视为本次没跑成，防个别端点把整批拖死 */
const PROBE_TIMEOUT_MS = 30_000
/**
 * 软超时后的宽限（毫秒）：软超时只发中止信号、等适配器收尾并回报真实失败事实，宽限期满即硬兜底。
 * 兜底与「读流」赛跑，适配器即使忽略 `signal`，probeOnce 也必然返回（见 docs/decisions.md「验证」）。
 */
const PROBE_TIMEOUT_GRACE_MS = 3_000
/** 同时在跑的提供方分组数；组内请求并发由各自的 GroupRunner 决定。 */
const PROBE_PROVIDER_CONCURRENCY = 5

/** 取失败事实的可序列化子集（供调用方自行细分，不参与本插件的判定） */
function failureFacts(failure: LlmFailure): VerifyFailureFacts {
    return { code: failure.code, status: failure.status, message: failure.message }
}

/**
 * 发一次探测并判定：收到首个 `block-start` 即判「受支持」；否则读到终止块、据其失败事实分类。
 * 中止（外部或上游）没有结论，单列 `'aborted'`；我方超时归 `'timeout'`。
 * 到点必然返回，不依赖适配器配合：宽限期满即不再调用 `next()`。见 docs/decisions.md「验证」。
 *
 * @param timeoutMs 软超时（毫秒）：到点只发中止信号、不判结论；仅测试传更小的值
 * @param graceMs 软超时后的宽限（毫秒）：期满即硬兜底返回；仅测试为缩短等待而传
 */
export async function probeOnce(
    llm: Pick<LlmRuntime, 'stream'>,
    probe: Pick<VerifyProbe, 'provider' | 'model' | 'effort'>,
    signal: AbortSignal,
    timeoutMs: number = PROBE_TIMEOUT_MS,
    graceMs: number = PROBE_TIMEOUT_GRACE_MS,
): Promise<ProbeVerdict> {
    const controller = new AbortController()
    let timedOut = false
    // 软超时：只发中止信号，把「怎么收尾」交给适配器——它才知道怎么把真实失败事实带回来
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined
    const giveUp = new Promise<'give-up'>((resolve) => {
        giveUpTimer = setTimeout(() => resolve('give-up'), timeoutMs + graceMs)
    })
    const iterator = llm.stream({
        provider: probe.provider,
        model: probe.model,
        // 档位 id 取自宿主配置键（模型页送出的同一个值）；断言只为满足品牌类型，免引入 dsh-llm 运行期值导入
        ...(probe.effort === undefined ? {} : { reasoningEffort: probe.effort as ReasoningEffortId }),
        messages: [{ role: 'user', content: [{ type: 'text', text: PROBE_PROMPT }] }],
        // 我方超时与外部中止合成一路，两者都该停在探测边界上。
        // 不能改用 AbortSignal.timeout：那会抹掉下面判断「超时的是我」的 timedOut 标志，慢端点又被误判成断线
        signal: AbortSignal.any([signal, controller.signal]),
    })[Symbol.asyncIterator]()
    try {
        // 只认 block-start（证明适配器已开始产出内容块）：额度耗尽的 key 也会先来一条 usage（实测踩过，见 docs/decisions.md「验证」）
        while (true) {
            const step = await Promise.race([iterator.next(), giveUp])
            if (step === 'give-up') {
                // 外部中止优先：用户按的停止不是失败，不能入账、更不能据此短整组
                return signal.aborted ? { outcome: 'aborted', failure: undefined } : { outcome: 'timeout', failure: undefined }
            }
            if (step.done) break
            const chunk = step.value
            if (chunk.type === 'block-start') return { outcome: 'usable', failure: undefined }
            if (chunk.type === 'finish') {
                const reason = chunk.reason
                // stop / tool-calls / max-tokens：正常终止却没有内容块，宿主归为退化完成，同样没跑成
                if (reason.kind !== 'error' && reason.kind !== 'aborted') return { outcome: 'other', failure: undefined }
                // 外部中止单列：没有结论。只认外部那一路——我方超时也走 `aborted` 终帧（合成信号被中止），归下面的 timeout
                if (reason.kind === 'aborted' && signal.aborted) {
                    return { outcome: 'aborted', failure: failureFacts(reason.failure) }
                }
                // 我方超时不算端点不可达、不算不可用；原始失败事实照留，供调用方判断
                return {
                    outcome: timedOut ? 'timeout' : classifyFailure(reason.failure),
                    failure: failureFacts(reason.failure),
                }
            }
        }
        // 适配器中止时直接收流、不给终帧：同样没有结论
        if (signal.aborted) return { outcome: 'aborted', failure: undefined }
        return { outcome: 'other', failure: undefined }
    } catch {
        // 适配器未注册等抛出的异常一律归入「其它失败」，不参与短路——宁可少短路，不可误短路
        return { outcome: 'other', failure: undefined }
    } finally {
        clearTimeout(timer)
        clearTimeout(giveUpTimer)
        controller.abort()
        // 收尾关闭迭代器。**不 await**：适配器若忽略 signal，`return` 会排在未决的 `next()` 之后永不 settle，
        // await 等于把刚兜底回来的函数又挂回去
        const close = iterator.return?.bind(iterator)
        if (close !== undefined) void close().catch(() => {})
    }
}

/** 「永不中止」的占位信号（AbortSignal 没有 null 态，未给 signal 时用它） */
const NEVER_ABORTED = new AbortController().signal

/** 一帧的进度交代：`settled` 是进度增量，`skipped` 是因短路而未发出的条数；恒有 `settled === skipped + (当前条目确已发出 ? 1 : 0)` */
interface ProbeFrameProgress {
    /** 本帧了结的计划条目数（含因短路而未发出的），`done` 只数计划条目 */
    settled: number
    /** 因短路而未发出的条数；无则缺省 */
    skipped?: number
    /** 被提供方级故障短路时，说明未发请求的原因；无则缺省 */
    skippedReason?: ProviderBlockReason
}

/** 一个 `runGroup` 的产出出口：一条请求的结论 + 该帧的进度交代 */
export type ProbeEmitter = (
    probe: Pick<VerifyProbe, 'provider' | 'model' | 'effort'>,
    verdict: ProbeVerdict,
    progress: ProbeFrameProgress,
) => void

/** 一组怎么逐条跑：各功能的全部差异都在这个回调里（验证每模型一条请求，探测档位逐档平推，能力探测走 wire 级判定） */
export type GroupRunner = (
    llm: Pick<LlmRuntime, 'stream'>,
    group: ProviderProbeGroup,
    signal: AbortSignal,
    emitProbe: ProbeEmitter,
) => Promise<ProviderProbeOutcome>

/** 一轮请求的可选控制项；不传即静默跑完 */
export interface ProbeRunOptions {
    /** 外部中止：客户端断开或用户点停止 / 关窗。已中止即不再发新请求 */
    signal?: AbortSignal
    /** 进度出口。`done` 帧只在整轮真正跑完时发出，中止时不发 */
    onProgress?: (frame: VerifyProgressFrame) => void
}

/**
 * 跑完所有分组（组间最多五路）；组内调度由 GroupRunner 决定。**不发 `done` 帧**——终帧由调用方在收尾时发。
 * 已中止即不再开新组，从未开跑的组保持 undefined、被排除在汇报之外。
 */
export async function runProbeGroups(
    llm: Pick<LlmRuntime, 'stream'>,
    groups: readonly ProviderProbeGroup[],
    runGroup: GroupRunner,
    options: ProbeRunOptions = {},
): Promise<VerifySummary> {
    const signal = options.signal ?? NEVER_ABORTED
    // 分母只数计划条目（口径同 `planned`），故 `done ≤ total` 恒成立
    const total = groups.reduce((sum, group) => sum + group.probes.length, 0)
    // 稀疏数组：中止时从未开跑的组保持 undefined，汇报时据实排除
    const outcomes = new Array<ProviderProbeOutcome>(groups.length)
    let completed = 0
    const emitProbe: ProbeEmitter = (probe, verdict, progress): void => {
        // 跨 worker 的累计位置：本函数只在 await 之后同步调用，单线程下不会交错，累加即可
        completed += progress.settled
        options.onProgress?.({
            type: 'probed',
            provider: probe.provider,
            model: probe.model,
            effort: probe.effort,
            outcome: verdict.outcome,
            ...(verdict.cap === undefined ? {} : { cap: verdict.cap }),
            ...(progress.skipped === undefined ? {} : { skipped: progress.skipped }),
            ...(progress.skippedReason === undefined ? {} : { skippedReason: progress.skippedReason }),
            done: completed,
            total,
        })
    }
    options.onProgress?.({ type: 'opened', total })
    // 第 w 个 worker 只跑下标 ≡ w (mod workers) 的组；组内请求调度由对应 GroupRunner 负责
    const workers = Math.min(PROBE_PROVIDER_CONCURRENCY, groups.length)
    await Promise.all(Array.from({ length: workers }, (_, worker) => (async () => {
        for (let at = worker; at < groups.length; at += workers) {
            if (signal.aborted) break
            outcomes[at] = await runGroup(llm, groups[at], signal, emitProbe)
        }
    })()))
    const reports: VerifyProviderReport[] = []
    const details: VerifyProbeResult[] = []
    for (let at = 0; at < groups.length; at++) {
        const outcome = outcomes[at]
        if (outcome === undefined) continue
        reports.push(reportProvider(outcome))
        details.push(...outcome.results)
    }
    return summarizeProviders(reports, details)
}

/**
 * 收尾发终帧：**中止不发 `done`**——消费方见「流结束却无 done」即知这轮没跑完。
 * 由调用方在全部收尾动作（收敛写回）之后调用，终帧里的汇总已是最终形态。
 */
export function finishRun(summary: VerifySummary, options: ProbeRunOptions = {}): void {
    if (options.signal?.aborted) return
    options.onProgress?.({ type: 'done', summary })
}
