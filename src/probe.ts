/**
 * 「探测档位」的 Node 半执行器：把候选档位**临时预声明**进模型配置 → 逐档各发一次最小请求（同一网关最多 3 条模型链并行，模型内档位串行） →
 * 按结论**收敛**成最终档位表并写回。全过程只由用户主动发起，在途全程持有事件流守卫。
 * 设计裁决见 docs/decisions.md「探测档位」。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { EFFORT_LEVELS, PLUGIN_NAME } from '@/shared/constants'
import { errorText } from '@/shared/errors'
import { isPlainObject } from '@/shared/types'
import type { ProviderBlockReason, ProviderProbeOutcome, ProviderProbeSegment, VerifyProbeResult, VerifySummary } from '@/shared/verify-progress'
import type { GroupRunner, ProbeEmitter, ProbeRunOptions } from '@/probe-engine'
import { finishRun, probeOnce, runProbeGroups } from '@/probe-engine'
import type { ProviderProbeGroup } from '@/probe-plan'
import { PROBE_LIMITS, planProbeGroups } from '@/probe-plan'
import { isEffortRejection, providerBlockReason, shouldSkipModelTail } from '@/probe-verdict'
import type { EffortApply } from '@/fill'
import { convergeProbeEfforts, declareProbeEfforts } from '@/fill'
import { clearProbeBackup, saveProbeBackup } from '@/probe-backup'
import { endIgnoreAll, startIgnoreAll } from '@/guard'
import { logicalProviderOf } from '@/probe-route'

/** 探测请求不合法时的报错文案（入参来自浏览器半，一律按不可信输入校验） */
const PROBE_REJECT_MESSAGE = `${PLUGIN_NAME}: 探测请求不合法（模型条目或推理级别取值越界）`

/** 同一个提供方内可并行的模型链数；模型自己的推理级别仍严格按顺序探测。 */
const PROBE_MODEL_CONCURRENCY = 3

/** 「提供方 / 模型」二元组键（与 fill.ts、verifyKey 同口径） */
function targetKey(provider: string, model: string): string {
    return JSON.stringify([provider, model])
}

/** 同一实际 provider（网关）最多三条模型链并行；每模型档位严格串行，失败短路只作用于模型前缀对应的逻辑渠道。 */
const runProbeGroup: GroupRunner = async (
    llm: Pick<LlmRuntime, 'stream'>,
    group: ProviderProbeGroup,
    signal: AbortSignal,
    emitProbe: ProbeEmitter,
): Promise<ProviderProbeOutcome> => {
    type IndexedProbe = { probe: ProviderProbeGroup['probes'][number]; index: number; route: string }
    type RouteState = {
        provider: string
        results: VerifyProbeResult[]
        blockedBy: ProviderBlockReason | undefined
        issuedRequests: number
        completedRequests: number
        planned: number
        plannedEfforts: number
        models: Set<string>
    }
    const routes = new Map<string, RouteState>()
    const chainsByModel = new Map<string, IndexedProbe[]>()
    group.probes.forEach((probe, index) => {
        const route = logicalProviderOf(probe.provider, probe.model)
        let state = routes.get(route)
        if (state === undefined) {
            state = {
                provider: route,
                results: [],
                blockedBy: undefined,
                issuedRequests: 0,
                completedRequests: 0,
                planned: 0,
                plannedEfforts: 0,
                models: new Set<string>(),
            }
            routes.set(route, state)
        }
        state.planned++
        if (probe.effort !== undefined) state.plannedEfforts++
        state.models.add(targetKey(probe.provider, probe.model))

        const key = targetKey(probe.provider, probe.model)
        let chain = chainsByModel.get(key)
        if (chain === undefined) {
            chain = []
            chainsByModel.set(key, chain)
        }
        chain.push({ probe, index, route })
    })
    const chains = [...chainsByModel.values()]
    const results = new Array<VerifyProbeResult | undefined>(group.probes.length)
    const usable = new Set<string>()
    let nextChain = 0
    // 渠道级短路后，未派发的条目按渠道合并成一帧。逐模型各发一帧会在记录区刷出几十条同文行，
    // 且这些条目根本没发过请求，没有按模型展示的信息量。
    type SkippedRoute = { count: number; sample: IndexedProbe }
    const skippedByRoute = new Map<string, SkippedRoute>()

    const runChain = async (chain: readonly IndexedProbe[]): Promise<void> => {
        const firstItem = chain[0]
        if (firstItem === undefined) return
        const modelKey = targetKey(firstItem.probe.provider, firstItem.probe.model)
        const routeState = routes.get(firstItem.route)
        if (routeState === undefined) return
        let index = 0
        while (index < chain.length) {
            if (signal.aborted) return
            // 同一逻辑渠道已确认渠道级失败：只跳过该渠道剩余请求，其他渠道继续探测。
            if (routeState.blockedBy !== undefined) {
                const remaining = chain.length - index
                const accumulated = skippedByRoute.get(routeState.provider)
                if (accumulated === undefined) {
                    skippedByRoute.set(routeState.provider, { count: remaining, sample: chain[index] })
                } else {
                    accumulated.count += remaining
                }
                return
            }

            const item = chain[index]
            if (item === undefined) return
            const firstIssued = routeState.issuedRequests === 0
            routeState.issuedRequests++
            const verdict = await probeOnce(llm, item.probe, signal)
            // 用户中止由整轮信号控制；上游主动中止没有结论，但仍结算这一条进度，避免 done 永远落后于 total。
            if (verdict.outcome === 'aborted') {
                if (signal.aborted) return
                emitProbe(item.probe, verdict, { settled: 1, ...(routeState.provider === group.provider ? {} : { route: routeState.provider }) })
                index += 1
                continue
            }

            const firstCompleted = routeState.completedRequests === 0
            routeState.completedRequests++
            if (verdict.outcome === 'usable') usable.add(modelKey)
            const outcome = item.probe.effort !== undefined && usable.has(modelKey) && isEffortRejection(verdict.failure)
                ? 'unsupported-effort'
                : verdict.outcome
            const result: VerifyProbeResult = {
                provider: item.probe.provider,
                model: item.probe.model,
                effort: item.probe.effort,
                outcome,
                failure: verdict.failure,
            }
            results[item.index] = result
            routeState.results.push(result)

            // “首个请求超时”按逻辑渠道计算，不能让另一个渠道的成功响应掩盖本渠道的首请求超时。
            const blockReason = providerBlockReason(outcome, firstIssued && firstCompleted)
            let skipped = 0
            if (blockReason !== undefined) {
                routeState.blockedBy ??= blockReason
            } else if (shouldSkipModelTail(outcome, verdict.failure) || outcome === 'rate-limit') {
                skipped = chain.length - index - 1
            }
            emitProbe(item.probe, { outcome, failure: verdict.failure }, {
                settled: 1 + skipped,
                ...(routeState.provider === group.provider ? {} : { route: routeState.provider }),
                ...(skipped === 0 ? {} : { skipped }),
            })
            index += 1 + skipped
        }
    }

    // 固定大小 worker 池：同一个网关总计最多三条模型链在途；渠道之间共享此上限。
    await Promise.all(Array.from({ length: Math.min(PROBE_MODEL_CONCURRENCY, chains.length) }, async () => {
        while (!signal.aborted && nextChain < chains.length) {
            const chain = chains[nextChain]
            nextChain += 1
            if (chain !== undefined) await runChain(chain)
        }
    }))

    // 外部中止不发帧；正常收尾时按规划顺序把各渠道的未派发条目补成一帧，done 才能追平 total。
    if (!signal.aborted) {
        for (const [route, state] of routes) {
            const skipped = skippedByRoute.get(route)
            if (skipped === undefined || state.blockedBy === undefined) continue
            emitProbe(skipped.sample.probe, { outcome: 'aborted', failure: undefined }, {
                settled: skipped.count,
                skipped: skipped.count,
                skippedReason: state.blockedBy,
                ...(route === group.provider ? {} : { route }),
            })
        }
    }

    const allResults = results.filter((item): item is VerifyProbeResult => item !== undefined)
    const models = new Set<string>()
    let plannedEfforts = 0
    for (const probe of group.probes) {
        models.add(targetKey(probe.provider, probe.model))
        if (probe.effort !== undefined) plannedEfforts++
    }
    const segments: ProviderProbeSegment[] = [...routes.values()].map((route) => ({
        provider: route.provider,
        results: route.results,
        blockedBy: route.blockedBy,
        planned: route.planned,
        plannedEfforts: route.plannedEfforts,
        tested: route.models.size,
    }))
    return {
        provider: group.provider,
        results: allResults,
        // 单一路由的失败不能代表整个聚合网关失败；逐渠道短路情况记录在 segments。
        blockedBy: undefined,
        planned: group.probes.length,
        plannedEfforts,
        tested: models.size,
        segments,
    }
}
/** 两个开关的取值：「自动写入」缺省开、「剔除不支持」缺省关；显式给了非布尔值按非法入参拒绝 */
function flagsOf(payload: unknown): { dropUnsupported: boolean; autoWrite: boolean } {
    if (!isPlainObject(payload)) throw new Error(PROBE_REJECT_MESSAGE)
    const read = (key: string, absent: boolean): boolean => {
        const value = payload[key]
        if (value === undefined) return absent
        if (typeof value !== 'boolean') throw new Error(PROBE_REJECT_MESSAGE)
        return value
    }
    return { dropUnsupported: read('dropUnsupported', false), autoWrite: read('autoWrite', true) }
}

/**
 * 收敛结论：逐模型算出最终档位表（只算不写）。
 * 生效闸：本轮被中止即**整轮**还原预声明之前的档位表；某模型请求没拿满（被短路连带）则只还原它。
 */
function convergeEntries(
    groups: readonly ProviderProbeGroup[],
    targets: readonly EffortApply[],
    preexisting: ReadonlyMap<string, readonly string[]>,
    summary: VerifySummary,
    dropUnsupported: boolean,
    aborted: boolean,
): EffortApply[] {
    const usable = new Map<string, Set<string>>()
    const unsupported = new Map<string, Set<string>>()
    const probed = new Map<string, number>()
    const planned = new Map<string, number>()
    for (const item of summary.usableEfforts) collect(usable, targetKey(item.provider, item.model), item.effort)
    for (const item of summary.unsupportedEfforts) collect(unsupported, targetKey(item.provider, item.model), item.effort)
    for (const item of summary.results) count(probed, targetKey(item.provider, item.model))
    for (const group of groups) for (const probe of group.probes) count(planned, targetKey(probe.provider, probe.model))
    const entries: EffortApply[] = []
    for (const target of targets) {
        const key = targetKey(target.provider, target.model)
        // 预声明时不在配置里的模型（探测期间被删掉）不被写回
        const before = preexisting.get(key)
        if (before === undefined) continue
        const keep = !aborted && (probed.get(key) ?? 0) >= (planned.get(key) ?? 0)
        entries.push({ provider: target.provider, model: target.model, levels: keep ? finalLevels(key, before, usable, unsupported, dropUnsupported) : before })
    }
    return entries
}

/**
 * 收敛结论若写入相对预声明之前的增删统计（「自动写入」关闭时供浏览器半汇报「可补全」）。
 * 口径与写回统计一致：档位表有变即计一个模型，逐级计增删。
 */
function plannedFillOf(
    entries: readonly EffortApply[],
    baseline: ReadonlyMap<string, readonly string[]>,
): NonNullable<VerifySummary['fill']> {
    let models = 0
    let added = 0
    let removed = 0
    for (const entry of entries) {
        const before = baseline.get(targetKey(entry.provider, entry.model))
        if (before === undefined) continue
        const after = new Set(entry.levels)
        let changed = false
        for (const level of after) if (!before.includes(level)) { added += 1; changed = true }
        for (const level of before) if (!after.has(level)) { removed += 1; changed = true }
        if (changed) models += 1
    }
    return { models, added, removed }
}

/** 收敛后的档位表：`可用 ∪ 原有`，开「剔除不支持」时再从原有里扣掉明确判不支持的那些；按 `EFFORT_LEVELS` 排序 */
function finalLevels(
    key: string,
    before: readonly string[],
    usable: ReadonlyMap<string, Set<string>>,
    unsupported: ReadonlyMap<string, Set<string>>,
    dropUnsupported: boolean,
): readonly string[] {
    const kept = new Set<string>()
    for (const level of before) {
        if (dropUnsupported && unsupported.get(key)?.has(level)) continue
        kept.add(level)
    }
    for (const level of usable.get(key) ?? []) kept.add(level)
    return EFFORT_LEVELS.filter((level) => kept.has(level))
}

/** 往「模型 → 集合」里加一项 */
function collect(target: Map<string, Set<string>>, key: string, value: string): void {
    const set = target.get(key)
    if (set === undefined) target.set(key, new Set([value]))
    else set.add(value)
}

/** 往「模型 → 条数」里加一 */
function count(target: Map<string, number>, key: string): void {
    target.set(key, (target.get(key) ?? 0) + 1)
}

/**
 * 跑一轮探测档位：预声明 → 逐档探测 → 收敛写回 → 发终帧。
 * 两个开关随载荷走（与模型清单同为浏览器半的声明，入参校验一处收口）。
 * 事件流守卫**全程持有**（预声明到收敛不放开），否则中途改配置会触发 `fix` 还原预声明、后续请求被宿主拒。见 docs/decisions.md「探测档位」。
 */
export async function probeAndFill(
    ctx: Context,
    llm: Pick<LlmRuntime, 'stream'>,
    payload: unknown,
    options: ProbeRunOptions = {},
): Promise<VerifySummary> {
    const flags = flagsOf(payload)
    const groups = planProbeGroups(payload, PROBE_LIMITS, PROBE_REJECT_MESSAGE)
    const targets: EffortApply[] = []
    const seen = new Set<string>()
    for (const group of groups) {
        for (const probe of group.probes) {
            const key = targetKey(probe.provider, probe.model)
            if (seen.has(key)) continue
            seen.add(key)
            targets.push({ provider: probe.provider, model: probe.model, levels: [] })
        }
    }
    startIgnoreAll()
    try {
        // 先存兜底备份再动配置：存不下即整轮中止（没有退路不动用户配置，见 probe-backup.ts）
        await saveProbeBackup(ctx, targets)
        const preexisting = await declareProbeEfforts(ctx, targets)
        const summary = await runProbeGroups(llm, groups, runProbeGroup, options)
        const entries = convergeEntries(groups, targets, preexisting, summary, flags.dropUnsupported, options.signal?.aborted === true)
        let fill: NonNullable<VerifySummary['fill']>
        if (flags.autoWrite) {
            const { models, added, removed } = await convergeProbeEfforts(ctx, entries, preexisting)
            fill = { models, added, removed }
        } else {
            // 「自动写入」关闭：只算不写，写回端整轮还原，统计交给 plannedFillOf
            fill = plannedFillOf(entries, preexisting)
            const restore: EffortApply[] = []
            for (const target of targets) {
                const before = preexisting.get(targetKey(target.provider, target.model))
                if (before !== undefined) restore.push({ provider: target.provider, model: target.model, levels: before })
            }
            await convergeProbeEfforts(ctx, restore, preexisting)
        }
        // 收敛已落盘即撤掉兜底备份；撤不掉只告警，不报成失败（见 docs/decisions.md「探测档位」）
        await clearProbeBackup(ctx).catch((error: unknown) => {
            ctx.logger.warn(`${PLUGIN_NAME}: 探测兜底备份清理失败（下次启动会回退本轮补全）：${errorText(error)}`)
        })
        // 终帧最后发：消费方拿到 done 时写回已落盘。`fill` 两义见 `ProbeFillResult`
        const filled: VerifySummary = { ...summary, fill }
        finishRun(filled, options)
        return filled
    } finally {
        endIgnoreAll()
    }
}
