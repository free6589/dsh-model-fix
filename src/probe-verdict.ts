import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'
import type { CapProbeVerdict } from '@/shared/cap-probe'
import type { ProbeOutcome, ProviderBlockReason, VerifyFailureFacts, VerifyProbe } from '@/shared/verify-progress'
import { isProviderBlocking } from '@/shared/verify-progress'

/** 探测判定层（零 ctx 纯函数）：把宿主失败事实翻译成本插件结论，并给出两级短路的唯一判据（口径见 docs/decisions.md「验证」「探测档位」） */

/** 额度 / 余额耗尽（`ACCOUNT_QUOTA` 是宿主给「账户余额不足」定的字面量） */
const QUOTA_CODES: ReadonlySet<string> = new Set(['QUOTA', 'ACCOUNT_QUOTA'])
/** 凭据缺失或无效 */
const CREDENTIAL_CODES: ReadonlySet<string> = new Set(['INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'])
/** 模型未声明请求的这一档位（宿主派发前本地拒绝，请求未发出） */
const UNSUPPORTED_EFFORT_CODE = 'UNSUPPORTED_REASONING_EFFORT'
/** 上游限流（429）：本次没跑成，换档重试仍可能通过 */
const RATE_LIMIT_CODE = 'RATE_LIMIT'
/** 上游超时，与本方探测超时同性质 */
const TIMEOUT_CODE = 'TIMEOUT'
/** 请求被中止（停止 / 断连 / 上游主动）：不是失败、没有结论 */
const ABORTED_CODE = 'ABORTED'
/** 传输层失败（连接中断、流截断），真「连不上」只有这一类；不能拿「status 缺失」当不可达（实测踩过，pi-ai 侧错误恒无 status） */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['TRANSPORT', 'STREAM_CLOSED'])
/** 请求参数不正确（宿主 `classifyPiAiError` 从文案认出的 4xx / invalid_request） */
const INVALID_REQUEST_CODE = 'INVALID_REQUEST'

/** 一次探测的判定：结论 + 失败时的原始事实（收到 block-start 时无事实）。
 * `cap` 只有「能力探测」携带（wire 级三态是它的结论轴，`outcome` 只作短路与汇报的机器账本） */
export interface ProbeVerdict {
    outcome: ProbeOutcome
    failure: VerifyFailureFacts | undefined
    cap?: CapProbeVerdict
}

/** 由终止块失败事实判定结果：一律按宿主 `code` 判（不看 status、不比对文案），未识别码归「其它」 */
export function classifyFailure(failure: LlmFailure): Exclude<ProbeOutcome, 'usable'> {
    if (failure.code === UNSUPPORTED_EFFORT_CODE) return 'unsupported-effort'
    if (QUOTA_CODES.has(failure.code)) return 'quota'
    if (CREDENTIAL_CODES.has(failure.code)) return 'credential'
    if (UNREACHABLE_CODES.has(failure.code)) return 'unreachable'
    if (failure.code === RATE_LIMIT_CODE) return 'rate-limit'
    if (failure.code === TIMEOUT_CODE) return 'timeout'
    if (failure.code === ABORTED_CODE) return 'aborted'
    return 'other'
}

/** 「档位不支持」的第一条件：宿主判为「请求参数不正确」（`INVALID_REQUEST`，宿主已归一好、不自己比对文案）。
 * 第二条件「除档位外别无变量」只有探测档位用（同模型已跑通的更低档作对照），由 `runGroup` 保证后才落结论；验证不带档位用不到 */
export function isEffortRejection(failure: VerifyFailureFacts | undefined): boolean {
    return failure?.code === INVALID_REQUEST_CODE
}

/** 从 `from` 之后起与它同模型的探测条数（请求按模型分组，即该模型剩下的档位；探测档位用它短到档位尾，验证每模型一条用不到） */
export function sameModelTail(probes: readonly VerifyProbe[], from: number): number {
    let count = 0
    for (let index = from + 1; index < probes.length && probes[index]?.model === probes[from]?.model; index++) count++
    return count
}

/** 该失败是否足以否定整个提供方（provider 级短路判据，验证与探测共用）：能断定后续必然失败才短。
 * 端点不通 / 凭据无效（`isProviderBlocking`，同一提供方共用同一 url 与 key）或本组首个请求超时（理由记 `timeout` 而非 `unreachable`——报告只按真实失败事实记）；不短路返回 `undefined` */
export function providerBlockReason(outcome: ProbeOutcome, firstRequest: boolean): ProviderBlockReason | undefined {
    if (isProviderBlocking(outcome)) return outcome
    return firstRequest && outcome === 'timeout' ? 'timeout' : undefined
}

/** 该失败是否足以否定该模型的其余档位（模型级短路判据，仅探测档位的逐档请求用）：档位请求上只有额度耗尽够格（额度按模型计）；
 * 其余不短，探测档位另把限流追加为自己的短路（被短模型整轮还原、无误杀） */
export function shouldSkipModelTail(outcome: ProbeOutcome, failure: VerifyFailureFacts | undefined): boolean {
    return failure !== undefined && outcome === 'quota'
}
