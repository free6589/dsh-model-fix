/**
 * 「验证模型」与「探测档位」共用的跨半契约：探测明细、逐提供方汇报、进度帧。
 * 放共享层是供浏览器半解析结果与帧（浏览器半不能反向 import Node 半）。
 * 只有类型与纯谓词，零 Node 依赖；两个功能共用同一份形状，分岔只在 Node 半的执行器。
 */

import { isPlainObject } from '@/shared/types'
import type { CapId, CapProbeVerdict, CapTally } from '@/shared/cap-probe'

/** 计划里的一条探测请求：一次请求 = 一个「模型 × 推理级别」组合；`effort` 缺省即不带 `reasoningEffort`。
 * `capability` 只有「能力探测」携带（模型 × 能力，一次 wire 级最小请求）；与 `effort` 互斥、不共存于一条探测 */
export interface VerifyProbe {
    provider: string
    model: string
    effort?: string
    capability?: CapId
}

/** 单次探测的判定结果。只按宿主 `LlmFailure` 的 `code` 分类（宿主明令不按 message 解析），两侧都不做文案比对。 */
export type ProbeOutcome =
    /** 收到 `block-start`：该「模型 × 档位」受支持 */
    | 'usable'
    /** 宿主派发前本地判定该档位不支持（`UNSUPPORTED_REASONING_EFFORT`），请求未发出 */
    | 'unsupported-effort'
    /** 传输层失败且无 HTTP status：端点不可达 */
    | 'unreachable'
    /** 额度或余额耗尽；按模型的事实，不参与 provider 级短路 */
    | 'quota'
    /** 凭据缺失或无效 */
    | 'credential'
    /** 瞬态：上游限流（429）；本次没结论，重试仍可能通过 */
    | 'rate-limit'
    /** 瞬态：超时；本次没结论 */
    | 'timeout'
    /** 中止：没结论、不入明细；外部取消不发帧并终止整轮，上游中止则发无结论进度帧后继续 */
    | 'aborted'
    /** 其它厂商侧拒绝（含上游 5xx）：不能断定后续必失败，不短路 */
    | 'other'

/** provider 级失败：命中即整组短路（能断定后续请求必然失败）。`timeout` 还要求是本组首个请求（见 `@/probe-verdict` 的 `providerBlockReason`），不由本类型判定。 */
export type ProviderBlockReason = 'unreachable' | 'credential' | 'timeout'

/** 该失败单看自身是否就否定整个提供方（与请求内容无关、换个模型照样过不去）。 */
export function isProviderBlocking(outcome: ProbeOutcome): outcome is Exclude<ProviderBlockReason, 'timeout'> {
    return outcome === 'unreachable' || outcome === 'credential'
}

/** 该结果是否只是本次没跑成（限流 / 超时）：不算不可用，也不能用来短该模型的后续档位。 */
export function isTransientOutcome(outcome: ProbeOutcome): boolean {
    return outcome === 'rate-limit' || outcome === 'timeout'
}

/** 失败的原始事实（宿主 `LlmFailure` 的可序列化子集）：供调用方做更细的分类与展示。 */
export interface VerifyFailureFacts {
    code: string
    /** HTTP 状态；传输层失败没有（宿主兜底对象只给 code 与 message） */
    status: number | undefined
    /** 人类可读描述：仅供展示与诊断，分类不可依赖（各厂商措辞不同且会变） */
    message: string
}

/**
 * 单条探测明细：一个「提供方 / 模型 / 推理级别」及其结论，调用方可据此做后续操作，不必再回解析统计值。
 * 只含实际发出的探测；被短路掉的从未发出——哪几条没跑由逐提供方的 `planned` 与 `probed` 之差给出（短路以整组为单位）。
 */
export interface VerifyProbeResult {
    provider: string
    model: string
    /** 推理级别；模型未声明档位时为 undefined（不带档位探测），经 JSON 传输后该键缺省 */
    effort: string | undefined
    outcome: ProbeOutcome
    /** 失败时的原始事实；收到 block-start 时为 undefined */
    failure: VerifyFailureFacts | undefined
    /** 能力探测的三态结论（wire 级判定，`outcome` 只作短路与汇报的机器账本）；验证与探测档位缺省 */
    cap?: CapProbeVerdict
}

/** 单个逻辑提供方（或聚合器子渠道）的汇报输入：逐条明细 + 该组短路情况。 */
export interface ProviderProbeSegment {
    provider: string
    /** 实际发出请求的结论；被短路的请求不在明细里 */
    results: VerifyProbeResult[]
    blockedBy: ProviderBlockReason | undefined
    /** 计划请求数 */
    planned: number
    /** 计划里带档位的条目数（验证恒为 0） */
    plannedEfforts: number
    /** 计划验过的模型数（按逻辑提供方 / 模型去重） */
    tested: number
}

/** 一个实际 provider（可能是聚合器）的验证结论。segments 存在时，统计报告按逻辑渠道拆分；results 仍是整个实际 provider 的明细。 */
export interface ProviderProbeOutcome extends ProviderProbeSegment {
    segments?: readonly ProviderProbeSegment[]
}

/** 单个提供方的验证结论（逐提供方可见） */
export interface VerifyProviderReport {
    provider: string
    /** 端点可达：全程未出现传输层失败 */
    reachable: boolean
    /** 凭据有效：可达且全程未出现凭据类失败（从未可达时不作断言）；额度耗尽不否定 key */
    keyValid: boolean
    /** 整组是否因 provider 级失败被短路 */
    skipped: boolean
    blockedBy: ProviderBlockReason | undefined
    /** 该组计划验过的模型数（按「提供方 / 模型」去重），即用户勾了几个 */
    tested: number
    /** 该组内可用模型数（按「提供方 / 模型」去重） */
    models: number
    /** 该组内可用档位数 */
    efforts: number
    /** 判定「档位不支持」的请求数：与其它失败分开计数 */
    unsupported: number
    /** 计划请求数 */
    planned: number
    /** 计划里带档位的条目数（验证恒为 0） */
    plannedEfforts: number
    /** 实际发出的请求数（短路时小于 planned） */
    probed: number
}

/**
 * 一个「提供方 / 模型」下的某推理级别被判为**不被支持**。
 * 只收明确判为不支持的；超时、限流、额度耗尽、不可达都只是没验成，不在此列（判据见 docs/decisions.md「验证」）。
 */
export interface UnsupportedEffort {
    provider: string
    model: string
    effort: string
}

/**
 * 一个「提供方 / 模型」下的某推理级别被判为**确实可用**（收到 `block-start`）；探测档位据此写回配置。
 * 只收带档位的条目：不带档位的请求验的是模型本身。
 */
export interface UsableEffort {
    provider: string
    model: string
    effort: string
}

/**
 * 探测档位「收敛写回」的结果（相对本轮开始前的配置）：浏览器半直接拿去显示。
 * 三个数字都以本轮开始前的档位表为基线，而非临时预声明表（预声明只为让请求出得去，不是用户配置的一部分）。
 */
export interface ProbeFillResult {
    /** 实际改写了档位表的模型数 */
    models: number
    /** 新增的档位条数（原来没声明、这轮验出能用） */
    added: number
    /** 删掉的档位条数（原来声明了、这轮判为不能用；临时预声明后收回的不计入） */
    removed: number
}

/** 验证结果汇总：逐提供方汇报 + 逐条明细 + 不支持档位明细 + 全局计数 */
export interface VerifySummary {
    providers: readonly VerifyProviderReport[]
    /** 逐条探测明细，顺序为「组序 → 组内探测序」 */
    results: readonly VerifyProbeResult[]
    /**
     * 明确判为不支持的档位明细：写配置须逐条定位（理由见 `UnsupportedEffort`）。
     * 只有探测档位会产出（收敛时按「剔除不支持」开关扣减）；验证不带档位，恒为空。
     */
    unsupportedEfforts: readonly UnsupportedEffort[]
    /** 判可用的档位明细（与 `unsupportedEfforts` 对称）；探测档位据此写回；验证恒为空 */
    usableEfforts: readonly UsableEffort[]
    /**
     * 收敛结论的增删统计：只有探测档位给出（验证只读、不碰配置，此字段恒缺省）。
     * 「自动写入」开启即已写入的补全统计；关闭时是可补全的假设统计，浏览器半据此换措辞。
     */
    fill?: ProbeFillResult
    /**
     * 能力探测的三态计数（仅能力探测产出；验证与探测档位恒缺省）。
     * `fill` 同样复用：能力探测的写回只动 `input` 图片模态，「自动写入」关闭时是可写入的假设统计。
     */
    caps?: CapTally
    /** 本次验证的模型数（按「提供方 / 模型」去重），即用户勾了几个；取自计划，被短路的模型也在内 */
    tested: number
    /** 可用模型数：至少有一条请求通过的去重模型数 */
    models: number
    /** 判可用的带档位请求数（验证恒为 0） */
    efforts: number
    /** 判「档位不支持」的请求数（验证恒为 0） */
    unsupported: number
    /** 计划请求数（验证每模型一条；探测档位逐档展开） */
    planned: number
    /** 计划里带档位的条目数（验证恒为 0） */
    plannedEfforts: number
    /** 实际发出的请求数（短路时小于 planned） */
    probed: number
}

/**
 * 一次验证运行的进度帧判别联合：先唯一一条 `opened`，随后每完成一条探测尝试（包括无结论的上游中止）发一条 `probed`，最后唯一一条终帧（`done` 或 `failed`）。
 * 中途被中止（停止 / 关窗 / 断连）时**不发终帧**——消费方据「流结束却无终帧」得知这轮没跑完。
 */
export type VerifyProgressFrame =
    /** 开流即发的第一条：让 UI 知道总共几项 */
    | { type: 'opened'; total: number }
    /**
     * 一条探测出结果。`total` 是计划条目数，`done` 是已了结的条目数（被短路未发出的计入），故 `done ≤ total`。
     * `skipped` 在该结论短路了后续请求时出现，值为未发出的条数；`skippedReason` 标明因提供方级失败而未派发的请求原因；`effort` 缺省即不带档位的模型级结论。
     */
    | {
        type: 'probed'
        provider: string
        model: string
        effort: string | undefined
        outcome: ProbeOutcome
        skipped?: number
        skippedReason?: ProviderBlockReason
        /** 由模型 ID 前缀推导的逻辑渠道；用于让 provider 级失败记录显示到正确的渠道。 */
        route?: string
        done: number
        total: number
        /** 能力探测的三态结论；验证与探测档位的帧缺省（`outcome` 仍是其唯一结论轴） */
        cap?: CapProbeVerdict
    }
    /** 终帧：整轮跑完，`summary` 承载完整结论 */
    | { type: 'done'; summary: VerifySummary }
    /** 终帧：没能开跑（入参非法、超配额等）或执行中途异常；`message` 是 Node 半给出的中文原因。中止没有终帧（见本文件头部说明） */
    | { type: 'failed'; message: string }

/** 单条探测结果帧；消费方逐条格式化展示，故单列一个名字 */
export type VerifyProbedFrame = Extract<VerifyProgressFrame, { type: 'probed' }>

/** 非终帧：逐条回调的形状；终帧由调用方单独接住 */
export type VerifyProgressUpdate = Exclude<VerifyProgressFrame, { type: 'done' | 'failed' }>

/** 宿主 hmr 的 SSE 分帧格式：单行 `data: ` + 空行分隔（`DSH/packages/boot/hmr/src/index.ts`） */
const DATA_PREFIX = 'data: '

/** 把一帧编成线上文本（单行 `data: ` + 空行分帧）。 */
export function encodeProgressFrame(frame: VerifyProgressFrame): string {
    return `${DATA_PREFIX}${JSON.stringify(frame)}\n\n`
}

/**
 * 解析一条 `data: ` 行；SSE 注释帧（`: …` 心跳）与非法 JSON 返回 undefined，调用方跳过即可。
 * 逐字段做形状校验（而非 `JSON.parse` 了事）：这条流的 `done.summary` 直接驱动卡片统计。
 */
export function decodeProgressFrame(line: string): VerifyProgressFrame | undefined {
    if (!line.startsWith(DATA_PREFIX)) return undefined
    try {
        const parsed: unknown = JSON.parse(line.slice(DATA_PREFIX.length))
        return isProgressFrame(parsed) ? parsed : undefined
    } catch {
        return undefined
    }
}

/** 帧的形状校验；只查消费方真正会读的字段，不做整棵 `VerifySummary` 的深度校验 */
function isProgressFrame(value: unknown): value is VerifyProgressFrame {
    if (!isPlainObject(value)) return false
    if (value.type === 'opened') return typeof value.total === 'number'
    if (value.type === 'probed') {
        return typeof value.provider === 'string' && typeof value.model === 'string'
            && typeof value.outcome === 'string' && typeof value.done === 'number' && typeof value.total === 'number'
            && (value.effort === undefined || typeof value.effort === 'string')
            && (value.skipped === undefined || typeof value.skipped === 'number')
            && (value.skippedReason === undefined || value.skippedReason === 'unreachable' || value.skippedReason === 'credential' || value.skippedReason === 'timeout')
            && (value.route === undefined || typeof value.route === 'string')
            && (value.cap === undefined || isCapVerdict(value.cap))
    }
    if (value.type === 'failed') return typeof value.message === 'string'
    return value.type === 'done' && isPlainObject(value.summary)
        && typeof value.summary.tested === 'number' && typeof value.summary.models === 'number'
        && typeof value.summary.efforts === 'number' && typeof value.summary.plannedEfforts === 'number'
}

/** 能力结论的形状校验：`capability` / `result` 取值域 + `reason` 可选字符串（防坏帧把三态文案渲染成任意值） */
function isCapVerdict(value: unknown): value is CapProbeVerdict {
    if (!isPlainObject(value)) return false
    return (value.capability === 'image' || value.capability === 'tool')
        && (value.result === 'supported' || value.result === 'unsupported' || value.result === 'unknown')
        && (value.reason === undefined || typeof value.reason === 'string')
}
