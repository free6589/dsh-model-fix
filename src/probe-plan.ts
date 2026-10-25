import { LEVELS } from '@/constants'
import type { CapId } from '@/shared/cap-probe'
import { CAP_IDS } from '@/shared/cap-probe'
import type { VerifyProbe } from '@/shared/verify-progress'
import { isPlainObject } from '@/shared/types'

/** 探测计划层（纯函数、零 ctx）：把浏览器半发来的未信任载荷校验并展开为待跑清单；两条硬闸配额见 `ProbeLimits` */

/** 一个实际提供方的探测组：组内调度由 GroupRunner 决定（验证与能力探测串行，探测档位按模型 3 路并发），计划层只负责分组与顺序 */
export interface ProviderProbeGroup {
    provider: string
    /** 各探测在原数组中的下标（结果按此回填，汇总与顺序无关） */
    indexes: number[]
    probes: VerifyProbe[]
}

/** 一轮请求的两条硬闸（约束烧掉的额度）：真正发出的请求数与计划模型数；超出即拒绝而非静默截断（截断会让用户以为「全查过了」） */
interface ProbeLimits {
    /** 真正会发出的请求数上限（计划条目一条即一次请求） */
    maxProbes: number
    /** 计划模型数上限（按「提供方 / 模型」去重） */
    maxModels: number
}

/** 验证的配额：每模型一条请求（不带档位参数），请求数即勾选模型数，封顶 200（超出即拒绝，用户可减少勾选重来） */
export const VERIFY_LIMITS: ProbeLimits = { maxProbes: 200, maxModels: Number.POSITIVE_INFINITY }
/** 探测档位的配额：全量展开为「模型数 × 至多 7 档」（off 仅当模型已声明时才探测），故模型数封顶 200（至多 1400 次最小请求） */
export const PROBE_LIMITS: ProbeLimits = { maxProbes: 1400, maxModels: 200 }

/** 能力探测的配额：每能力每轮 ≤200 条（能力至多两种 ⇒ 请求数封顶 400）；图片探测的 data URI 回退重试不占计划条目（同一条目内的重试） */
export const CAPS_LIMITS: ProbeLimits = { maxProbes: 400, maxModels: 200 }

/** 校验并展开请求载荷为清单：条目不带 `efforts`（或空数组）即一条不带档位的请求（验证的每个模型都长这样）；带 `efforts` 的条目（探测档位）按档位逐条展开；非法条目或超出 `limits` 一律拒绝（返回 undefined） */
export function planProbes(payload: unknown, limits: ProbeLimits = VERIFY_LIMITS): VerifyProbe[] | undefined {
    if (!isPlainObject(payload)) return
    const models = payload.models
    if (!Array.isArray(models) || models.length === 0) return
    const probes: VerifyProbe[] = []
    for (const entry of models) {
        if (!isPlainObject(entry)) return
        const { provider, model, efforts } = entry
        if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return
        if (efforts === undefined || (Array.isArray(efforts) && efforts.length === 0)) {
            // 没有档位要试：这条不带档位的请求本身就是被验对象
            probes.push({ provider, model })
            continue
        }
        if (!Array.isArray(efforts)) return
        for (const effort of efforts) {
            // 档位须落在 harness 支持的取值内（入参来自浏览器，仍按不可信输入校验）
            if (typeof effort !== 'string' || !LEVELS.has(effort)) return
            probes.push({ provider, model, effort })
        }
    }
    // 清单一条即一次真实请求，故请求数取清单长度；模型数另按「提供方 / 模型」去重计
    const plannedModels = new Set<string>()
    for (const probe of probes) {
        plannedModels.add(JSON.stringify([probe.provider, probe.model]))
    }
    return probes.length > limits.maxProbes || plannedModels.size > limits.maxModels ? undefined : probes
}

/** 按 provider 分组，组内保持探测原序；组序为提供方首次出现序 */
export function groupProbesByProvider(probes: readonly VerifyProbe[]): ProviderProbeGroup[] {
    const byProvider = new Map<string, ProviderProbeGroup>()
    probes.forEach((probe, index) => {
        let group = byProvider.get(probe.provider)
        if (group === undefined) {
            group = { provider: probe.provider, indexes: [], probes: [] }
            byProvider.set(probe.provider, group)
        }
        group.indexes.push(index)
        group.probes.push(probe)
    })
    return [...byProvider.values()]
}

/** 校验并展开未信任载荷、按提供方分组返回待跑清单（入参非法即抛出）。
 * 与执行拆两步：`done` 帧须等整轮结束才发，而探测档位的整轮含收敛写回，故计划先交到调用方手里（它还要拿模型清单写配置） */
export function planProbeGroups(payload: unknown, limits: ProbeLimits, rejectMessage: string): ProviderProbeGroup[] {
    const probes = planProbes(payload, limits)
    if (probes === undefined) throw new Error(rejectMessage)
    return groupProbesByProvider(probes)
}

/** 校验并展开能力探测载荷：`models`（{provider, model}）× `capabilities`（image/tool 勾选）逐条一条最小请求。
 * 能力按载荷序去重（重复勾选不发两次）；`efforts` 一概忽略（能力探测不带档位参数）。非法条目或超出 `limits` 一律返回 undefined */
export function planCapProbes(payload: unknown, limits: ProbeLimits = CAPS_LIMITS): VerifyProbe[] | undefined {
    if (!isPlainObject(payload)) return
    const models = payload.models
    const capabilities = payload.capabilities
    if (!Array.isArray(models) || models.length === 0) return
    if (!Array.isArray(capabilities) || capabilities.length === 0) return
    const caps: CapId[] = []
    for (const capability of capabilities) {
        // 能力取值须落在 v1 支持的两种内（入参来自浏览器，仍按不可信输入校验）
        if (typeof capability !== 'string' || !(CAP_IDS as readonly string[]).includes(capability)) return
        if (!caps.includes(capability as CapId)) caps.push(capability as CapId)
    }
    const probes: VerifyProbe[] = []
    for (const entry of models) {
        if (!isPlainObject(entry)) return
        const { provider, model } = entry
        if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return
        for (const capability of caps) probes.push({ provider, model, capability })
    }
    // 一条计划即一次真实请求（回退重试不占条目），故请求数取清单长度；模型数另按「提供方 / 模型」去重计
    const plannedModels = new Set<string>()
    for (const probe of probes) {
        plannedModels.add(JSON.stringify([probe.provider, probe.model]))
    }
    return probes.length > limits.maxProbes || plannedModels.size > limits.maxModels ? undefined : probes
}
