/** 模型可用性验证：每勾选模型发一次不带 `reasoningEffort` 的最小请求，仅以适配器是否开始产出内容块（`block-start`）判可用；
 * 全程只读（不碰 settings、不占事件流守卫、不落「已验证」账本），口径见 docs/decisions.md「验证」 */

import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { PLUGIN_NAME } from '@/shared/constants'
import type { ProviderBlockReason, ProviderProbeOutcome, VerifyProbeResult, VerifySummary } from '@/shared/verify-progress'
import type { GroupRunner, ProbeEmitter, ProbeRunOptions } from '@/probe-engine'
import { finishRun, probeOnce, runProbeGroups } from '@/probe-engine'
import type { ProviderProbeGroup } from '@/probe-plan'
import { VERIFY_LIMITS, planProbeGroups } from '@/probe-plan'
import { providerBlockReason } from '@/probe-verdict'
import { logicalProviderOf } from '@/probe-route'

/** 验证请求不合法时的报错文案（入参来自浏览器半，一律按不可信输入校验） */
const VERIFY_REJECT_MESSAGE = `${PLUGIN_NAME}: 验证请求不合法（模型条目取值越界）`

/** 顺序跑完一组验证请求；渠道级失败只短路同一逻辑渠道，其它渠道仍继续。 */
const runGroup: GroupRunner = async (
    llm: Pick<LlmRuntime, 'stream'>,
    group: ProviderProbeGroup,
    signal: AbortSignal,
    emitProbe: ProbeEmitter,
): Promise<ProviderProbeOutcome> => {
    type RouteState = {
        provider: string
        results: VerifyProbeResult[]
        blockedBy: ProviderBlockReason | undefined
        planned: number
        plannedEfforts: number
        models: Set<string>
        sent: number
    }
    const routes = new Map<string, RouteState>()
    const indexesByRoute = new Map<string, number[]>()
    group.probes.forEach((probe, index) => {
        const route = logicalProviderOf(probe.provider, probe.model)
        let state = routes.get(route)
        if (state === undefined) {
            state = {
                provider: route,
                results: [],
                blockedBy: undefined,
                planned: 0,
                plannedEfforts: 0,
                models: new Set<string>(),
                sent: 0,
            }
            routes.set(route, state)
        }
        state.planned++
        if (probe.effort !== undefined) state.plannedEfforts++
        state.models.add(JSON.stringify([probe.provider, probe.model]))
        const indexes = indexesByRoute.get(route) ?? []
        indexes.push(index)
        indexesByRoute.set(route, indexes)
    })

    const results: VerifyProbeResult[] = []
    const skippedIndexes = new Set<number>()
    for (let index = 0; index < group.probes.length; index++) {
        if (signal.aborted) break
        if (skippedIndexes.has(index)) continue
        const probe = group.probes[index]
        if (probe === undefined) continue
        const route = logicalProviderOf(probe.provider, probe.model)
        const state = routes.get(route)
        if (state === undefined) continue

        state.sent++
        const verdict = await probeOnce(llm, probe, signal)
        if (verdict.outcome === 'aborted') {
            if (signal.aborted) break
            // 上游主动中止不是用户取消：不入明细、不短路，但必须结算进度。
            emitProbe(probe, verdict, { settled: 1, ...(state.provider === group.provider ? {} : { route: state.provider }) })
            continue
        }

        const result: VerifyProbeResult = {
            provider: probe.provider,
            model: probe.model,
            effort: probe.effort,
            outcome: verdict.outcome,
            failure: verdict.failure,
        }
        results.push(result)
        state.results.push(result)

        const blockReason = providerBlockReason(verdict.outcome, state.sent === 1)
        let skipped = 0
        if (blockReason !== undefined) {
            state.blockedBy = blockReason
            const laterIndexes = (indexesByRoute.get(route) ?? []).filter((candidate) => candidate > index && !skippedIndexes.has(candidate))
            for (const candidate of laterIndexes) skippedIndexes.add(candidate)
            skipped = laterIndexes.length
        }
        emitProbe(probe, verdict, {
            settled: 1 + skipped,
            ...(state.provider === group.provider ? {} : { route: state.provider }),
            ...(skipped === 0 ? {} : { skipped }),
            ...(skipped === 0 || state.provider === group.provider ? {} : { skippedReason: blockReason }),
        })
    }

    const models = new Set<string>()
    let plannedEfforts = 0
    for (const probe of group.probes) {
        models.add(JSON.stringify([probe.provider, probe.model]))
        if (probe.effort !== undefined) plannedEfforts++
    }
    const segments = [...routes.values()].map((state) => ({
        provider: state.provider,
        results: state.results,
        blockedBy: state.blockedBy,
        planned: state.planned,
        plannedEfforts: state.plannedEfforts,
        tested: state.models.size,
    }))
    return {
        provider: group.provider,
        results,
        blockedBy: undefined,
        planned: group.probes.length,
        plannedEfforts,
        tested: models.size,
        segments,
    }
}

/** 验证的可选控制项；不传即静默跑完 */
type VerifyOptions = ProbeRunOptions

/** 执行一次验证：按勾选展开清单 → 按提供方分组 → 逐组跑 → 逐组汇报并求和；入参非法即抛出（调用方转 RPC 失败结果） */
export async function verifyModels(
    llm: Pick<LlmRuntime, 'stream'>,
    payload: unknown,
    options: VerifyOptions = {},
): Promise<VerifySummary> {
    const groups = planProbeGroups(payload, VERIFY_LIMITS, VERIFY_REJECT_MESSAGE)
    const summary = await runProbeGroups(llm, groups, runGroup, options)
    finishRun(summary, options)
    return summary
}
