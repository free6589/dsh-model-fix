/**
 * 「能力探测」（图片输入 / 工具调用）的 Node 半：请求体构造、wire 级三态判定矩阵、端点/凭据解析、逐组执行与整轮编排。
 * 判定规则按 03-probe-audit.md §1.1（工具调用看 `tool_calls` / `finish_reason`，2xx 不单独作数）与 §1.2（1x1 PNG 三态 + data URI 回退）；
 * 传输走 `src/probe-wire.ts` 裸 HTTP（不走 `llm.stream` 的三条理由见 docs/decisions.md「能力探测」）。
 * 执行骨架复用 `runProbeGroups`（分组、五路 worker、帧协议），差异只在 GroupRunner 回调——它不碰 `llm`，判定全在 wire 层。
 * 密钥只进 `Authorization` 头：不进日志、不进帧、不进任何返回值。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { CapId, CapProbeVerdict, CapTally } from '@/shared/cap-probe'
import { API_NS, PLUGIN_NAME } from '@/shared/constants'
import type { ProbeOutcome, ProviderBlockReason, ProviderProbeOutcome, VerifyProbeResult, VerifySummary } from '@/shared/verify-progress'
import type { GroupRunner, ProbeEmitter, ProbeRunOptions } from '@/probe-engine'
import { finishRun, runProbeGroups } from '@/probe-engine'
import type { ProviderProbeGroup } from '@/probe-plan'
import { groupProbesByProvider, planCapProbes } from '@/probe-plan'
import type { ProbeVerdict } from '@/probe-verdict'
import { providerBlockReason } from '@/probe-verdict'
import type { WireOutcome } from '@/probe-wire'
import { chatCompletionsUrl, postChatCompletions } from '@/probe-wire'
import { isPlainObject, providersOf } from '@/shared/types'
import { descriptorOf } from '@/section'
import { logicalProviderOf } from '@/probe-route'
import type { CapInputApply } from '@/cap-fill'
import { applyCapInput, previewCapInput } from '@/cap-fill'

/** 能力探测请求不合法时的报错文案（入参来自浏览器半，一律按不可信输入校验） */
const CAPS_REJECT_MESSAGE = `${PLUGIN_NAME}: 能力探测请求不合法（模型条目、能力或开关取值越界）`

/** 图片探测的提示词：配合 max_tokens=1，只求一条最短应答 */
const IMAGE_PROMPT = 'Reply with: OK'
/** 工具探测的提示词：只要一句招呼，让「必须调工具」成为唯一变量 */
const TOOL_PROMPT = 'Hi'
/** 工具探测的玩具工具：空参函数，强制 `tool_choice` 指名它 */
const TOOL_NAME = 'ping'
const TOOL_DESCRIPTION = 'Reply with a greeting.'

/**
 * 1x1 PNG（69 字节，标准 8bit RGB 黑像素）：与仓库资产 `assets/probe-1x1.png` 同字节。
 * data URI 优先出线；被网关按内联编码拒收时回退资产 raw URL（见 `IMAGE_RAW_URL`）。
 */
const PROBE_1X1_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC'
/** 图片源首选：data URI（内嵌常量，零外链、零第三方图床） */
export const IMAGE_DATA_URI = `data:image/png;base64,${PROBE_1X1_PNG_BASE64}`
/** 图片源回退：仓库资产的 raw URL（随 fork 提交、与内嵌常量同字节）；仅拒收内联编码的网关才走到这里 */
export const IMAGE_RAW_URL = 'https://raw.githubusercontent.com/free6589/dsh-model-fix/main/assets/probe-1x1.png'

/** v1 唯一在探测范围内的方言（其余记 `dialect-scope` 不发请求，见 docs/decisions.md「能力探测」） */
const WIRE_DIALECT = 'openai-completions'

/** 「不支持图片」特征：错误体含 `image` / `vision`（03-probe-audit.md §1.2 判据字面量） */
const IMAGE_UNSUPPORTED = /(image|vision)/i
/** 「拒收内联编码 / data URI」特征：命中即回退 raw URL 重试，**不得**据此判「不支持图片」（验收红线） */
const INLINE_REJECTION = /(data:|base64|inline|\buri\b|url format)/i
/** 「不支持工具调用」特征：错误体含 `tool` / `function`（03-probe-audit.md §1.1 判据字面量） */
const TOOL_UNSUPPORTED = /(tool|function)/i

/** 图片输入探测的最小多模态请求体（一次一模型；与 03-probe-audit.md §1.2 逐字对齐） */
export function imageProbeBody(model: string, imageSrc: string): Record<string, unknown> {
    return {
        model,
        max_tokens: 1,
        stream: false,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: IMAGE_PROMPT },
                { type: 'image_url', image_url: { url: imageSrc } },
            ],
        }],
    }
}

/** 工具调用探测的最小强制 function-call 请求体（与 03-probe-audit.md §1.1 的 buildProbeBody 逐字对齐） */
export function toolProbeBody(model: string): Record<string, unknown> {
    return {
        model,
        max_tokens: 1,
        stream: false,
        messages: [{ role: 'user', content: TOOL_PROMPT }],
        tools: [{
            type: 'function',
            function: {
                name: TOOL_NAME,
                description: TOOL_DESCRIPTION,
                parameters: { type: 'object', properties: {} },
            },
        }],
        tool_choice: { type: 'function', function: { name: TOOL_NAME } },
    }
}

/** wire 观测 → 三态结论 + 机器账本结局（`outcome` 只供 provider 级短路与汇报计数，结论轴是 `verdict`） */
export interface CapClass {
    verdict: CapProbeVerdict
    outcome: ProbeOutcome
    /** 图片探测专用：data URI 被拒内联编码 → 换 raw URL 重试一次（重试同属这条计划条目） */
    retry?: boolean
}

/** 错误体摘要（有界、单行）：进 `reason` 供诊断，不参与判定（判定用整段文本） */
function snippet(text: string): string {
    const oneLine = text.replace(/\s+/g, ' ').trim()
    return oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine
}

/** `reason` 的 HTTP 形态：原始 status + 有界错误体摘要（验收要求三态都附 reason，2xx 亦然） */
function httpReason(status: number, text: string): string {
    const body = snippet(text)
    return body === '' ? `HTTP ${status}` : `HTTP ${status}: ${body}`
}

/** 非 HTTP 收场的分类：外部中止回 undefined（不入账），超时 / 网络失败是 `unknown` 的两种来源 */
function classifyWire(capability: CapId, outcome: WireOutcome, attempt: 'data-uri' | 'raw-url' = 'data-uri'): CapClass | undefined {
    if (outcome.kind === 'aborted') return undefined
    if (outcome.kind === 'timeout') {
        return { verdict: { capability, result: 'unknown', reason: 'timeout' }, outcome: 'timeout' }
    }
    if (outcome.kind === 'network') {
        return { verdict: { capability, result: 'unknown', reason: 'network' }, outcome: 'unreachable' }
    }
    return capability === 'image'
        ? classifyImage(outcome.status, outcome.text, attempt)
        : classifyTool(outcome.status, outcome.text)
}

/** 401/403 = 凭据无效（短路该 provider 剩余探测）；429 = 限流（不短路、无结论） */
function credentialOrRateLimit(capability: CapId, status: number, text: string): CapClass | undefined {
    if (status === 401 || status === 403) {
        return { verdict: { capability, result: 'unknown', reason: httpReason(status, text) }, outcome: 'credential' }
    }
    if (status === 429) {
        return { verdict: { capability, result: 'unknown', reason: httpReason(status, text) }, outcome: 'rate-limit' }
    }
    return undefined
}

/** 图片探测的三态判定（attempt = 本次出线用的图片来源）。矩阵按 03-probe-audit.md §1.2；内联拒绝的优先级见 docs/decisions.md「能力探测」 */
export function classifyImage(status: number, text: string, attempt: 'data-uri' | 'raw-url'): CapClass {
    const early = credentialOrRateLimit('image', status, text)
    if (early !== undefined) return early
    if (status >= 200 && status < 300) {
        // 200 即 supported（max_tokens=1 本来就没内容可看，不要求模型复述）
        return {
            verdict: {
                capability: 'image',
                result: 'supported',
                reason: attempt === 'raw-url' ? `HTTP ${status} · fallback=raw-url` : `HTTP ${status}`,
            },
            outcome: 'usable',
        }
    }
    if (status >= 400 && status < 500) {
        // 内联拒绝先于「不支持图片」：拒收 data URI 不等于不支持图片，回退 raw URL 才能分辨（验收红线）
        if (attempt === 'data-uri' && INLINE_REJECTION.test(text)) return { verdict: { capability: 'image', result: 'unknown', reason: httpReason(status, text) }, outcome: 'other', retry: true }
        if (IMAGE_UNSUPPORTED.test(text)) {
            return { verdict: { capability: 'image', result: 'unsupported', reason: httpReason(status, text) }, outcome: 'unsupported-effort' }
        }
    }
    // 其余 4xx / 5xx / 非预期 status：一次都没验成，一律 unknown
    return { verdict: { capability: 'image', result: 'unknown', reason: httpReason(status, text) }, outcome: 'other' }
}

/** 工具调用的三态判定：**2xx 不单独作数**——必须看到 `tool_calls` 或 `finish_reason==='tool_calls'` 才 supported（对 model-catalog 探针的明确修正） */
export function classifyTool(status: number, text: string): CapClass {
    const early = credentialOrRateLimit('tool', status, text)
    if (early !== undefined) return early
    if (status >= 200 && status < 300) {
        return hasToolCall(text)
            ? { verdict: { capability: 'tool', result: 'supported', reason: `HTTP ${status}` }, outcome: 'usable' }
            // 2xx 但无 tool_calls（网关忽略 tools 直接文本作答）＝不支持
            : { verdict: { capability: 'tool', result: 'unsupported', reason: `HTTP ${status} · no tool_calls` }, outcome: 'unsupported-effort' }
    }
    if (status >= 400 && status < 500 && TOOL_UNSUPPORTED.test(text)) {
        return { verdict: { capability: 'tool', result: 'unsupported', reason: httpReason(status, text) }, outcome: 'unsupported-effort' }
    }
    return { verdict: { capability: 'tool', result: 'unknown', reason: httpReason(status, text) }, outcome: 'other' }
}

/** 响应体里有没有真工具调用：容错解析（字段缺失 / 形状不符一律按「无 tool_calls」处理，由调用方落 unsupported） */
export function hasToolCall(text: string): boolean {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return false
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.choices)) return false
    const first: unknown = parsed.choices[0]
    if (!isPlainObject(first)) return false
    if (first.finish_reason === 'tool_calls') return true
    const message: unknown = first.message
    if (!isPlainObject(message) || !Array.isArray(message.tool_calls)) return false
    return message.tool_calls.length > 0
}

/** 一条图片探测（含 data URI → raw URL 的一次回退）；中止回 undefined（不入账不发帧） */
async function probeImage(
    endpoint: EndpointOk,
    model: string,
    signal: AbortSignal,
    deps: CapDeps,
): Promise<CapClass | undefined> {
    const send = (imageSrc: string): Promise<WireOutcome> => postChatCompletions(
        chatCompletionsUrl(endpoint.baseURL),
        endpoint.apiKey,
        imageProbeBody(model, imageSrc),
        signal,
        wireOptions(deps),
    )
    const first = classifyWire('image', await send(IMAGE_DATA_URI), 'data-uri')
    if (first === undefined) return undefined
    if (first.retry !== true) return first
    // 回退重试同属这条计划条目：只重这一次，重试结果按同一矩阵重判（不再回退）
    return classifyWire('image', await send(IMAGE_RAW_URL), 'raw-url')
}

/** 一条工具调用探测；中止回 undefined */
async function probeTool(
    endpoint: EndpointOk,
    model: string,
    signal: AbortSignal,
    deps: CapDeps,
): Promise<CapClass | undefined> {
    return classifyWire('tool', await postChatCompletions(
        chatCompletionsUrl(endpoint.baseURL),
        endpoint.apiKey,
        toolProbeBody(model),
        signal,
        wireOptions(deps),
    ))
}

/** wire 层的可注入依赖（超时/中止语义与生产一致，只是测试传小值与 fetch 桩） */
function wireOptions(deps: CapDeps): { fetchImpl?: typeof fetch; timeoutMs?: number; graceMs?: number } {
    return {
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        ...(deps.graceMs === undefined ? {} : { graceMs: deps.graceMs }),
    }
}

/** 凭据引用 → 密钥明文的解析口（生产走 ctx.credentials 分层解析，测试注入假实现） */
export type CredentialLookup = (ref: string) => Promise<string | undefined>

/** 端点解析结果：可发请求（URL + 密钥）或三类不发请求的短路原因 */
export type EndpointResolution =
    | EndpointOk
    /** 方言不在 v1 范围（`api` 非 `openai-completions` 或未声明）：不发请求 */
    | { kind: 'dialect'; reason: 'dialect-scope' }
    /** 密钥解析不到（apiKey 空、apiKeyEnv 无取值）：不发请求 */
    | { kind: 'no-credential'; reason: 'no-credential' }
    /** 没有可用 baseURL：不发请求 */
    | { kind: 'no-endpoint'; reason: 'no-endpoint' }

/** 可发请求的端点 */
export interface EndpointOk {
    kind: 'ok'
    baseURL: string
    /** 密钥明文：只进 `Authorization` 头，不进日志与帧 */
    apiKey: string
}

/**
 * 从 `llm-pi-ai` 段的 provider profile 解析探测端点：`api` 须为 `openai-completions`（其余与未声明都记 dialect-scope——
 * 未声明时宿主会复用已装 provider 自己的方言，形状无从猜，宁可不发也不拿错误形状的 400 误判「不支持」）；
 * `baseURL` 直接拼 `/chat/completions`（带不带 `/v1` 由用户配置负责）；凭据 `apiKey`（明文）优先、`apiKeyEnv`（引用名）经 lookup 解析。
 */
export async function resolveEndpoint(profile: unknown, lookup: CredentialLookup): Promise<EndpointResolution> {
    if (!isPlainObject(profile)) return { kind: 'dialect', reason: 'dialect-scope' }
    if (profile.api !== WIRE_DIALECT) return { kind: 'dialect', reason: 'dialect-scope' }
    const baseURL = profile.baseURL
    if (typeof baseURL !== 'string' || baseURL.trim() === '') return { kind: 'no-endpoint', reason: 'no-endpoint' }
    const inline = profile.apiKey
    if (typeof inline === 'string' && inline !== '') return { kind: 'ok', baseURL, apiKey: inline }
    const ref = profile.apiKeyEnv
    if (typeof ref !== 'string' || !isCredentialRefName(ref)) return { kind: 'no-credential', reason: 'no-credential' }
    const key = await lookup(ref)
    return typeof key === 'string' && key !== ''
        ? { kind: 'ok', baseURL, apiKey: key }
        : { kind: 'no-credential', reason: 'no-credential' }
}

/** 生产凭据解析：`ctx.credentials.resolve`（进程环境 → provider 存储 → .env 分层）优先，回退进程环境（与 llm-pi-ai 适配器同口径） */
export function defaultCredentialLookup(ctx: Context): CredentialLookup {
    return async (ref) => {
        try {
            const hit = await ctx.credentials.resolve(credentialRef(ref))
            return hit?.value
        } catch {
            return process.env[ref]
        }
    }
}

/** 执行器的可注入依赖（生产全缺省） */
export interface CapDeps {
    lookup?: CredentialLookup
    fetchImpl?: typeof fetch
    timeoutMs?: number
    graceMs?: number
}

/** 两个开关的取值：与探测档位同语义——「自动写入」缺省开、「剔除不支持」缺省关；显式给了非布尔值按非法入参拒绝 */
function capsFlagsOf(payload: unknown): { dropUnsupported: boolean; autoWrite: boolean } {
    if (!isPlainObject(payload)) throw new Error(CAPS_REJECT_MESSAGE)
    const read = (key: string, absent: boolean): boolean => {
        const value = payload[key]
        if (value === undefined) return absent
        if (typeof value !== 'boolean') throw new Error(CAPS_REJECT_MESSAGE)
        return value
    }
    return { dropUnsupported: read('dropUnsupported', false), autoWrite: read('autoWrite', true) }
}

/** 校验并展开能力探测载荷、按提供方分组（入参非法即抛出） */
export function planCapGroups(payload: unknown): ProviderProbeGroup[] {
    const probes = planCapProbes(payload)
    if (probes === undefined) throw new Error(CAPS_REJECT_MESSAGE)
    return groupProbesByProvider(probes)
}

/** 顺序跑完一组能力探测；端点按真实 provider 解析，HTTP 短路按逻辑渠道隔离。 */
export function makeCapGroupRunner(endpoints: ReadonlyMap<string, EndpointResolution>, deps: CapDeps): GroupRunner {
    return async (
        llm: Pick<LlmRuntime, 'stream'>,
        group: ProviderProbeGroup,
        signal: AbortSignal,
        emitProbe: ProbeEmitter,
    ): Promise<ProviderProbeOutcome> => {
        void llm
        type RouteState = {
            provider: string
            results: VerifyProbeResult[]
            blockedBy: ProviderBlockReason | undefined
            planned: number
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
                    models: new Set<string>(),
                    sent: 0,
                }
                routes.set(route, state)
            }
            state.planned++
            state.models.add(JSON.stringify([probe.provider, probe.model]))
            const indexes = indexesByRoute.get(route) ?? []
            indexes.push(index)
            indexesByRoute.set(route, indexes)
        })

        const results: VerifyProbeResult[] = []
        const skippedIndexes = new Set<number>()
        const endpoint = endpoints.get(group.provider)
        for (let index = 0; index < group.probes.length; index++) {
            if (signal.aborted) break
            if (skippedIndexes.has(index)) continue
            const probe = group.probes[index]
            if (probe === undefined) continue
            const route = logicalProviderOf(probe.provider, probe.model)
            const state = routes.get(route)
            if (state === undefined) continue

            const capability = probe.capability ?? 'image'
            let klass: CapClass | undefined
            if (endpoint === undefined || endpoint.kind !== 'ok') {
                // 不发请求的结论逐条入账；它不是 HTTP 失败，不阻断其它条目。
                const reason = endpoint?.reason ?? 'no-endpoint'
                klass = { verdict: { capability, result: 'unknown', reason }, outcome: 'other' }
            } else {
                state.sent++
                klass = capability === 'image'
                    ? await probeImage(endpoint, probe.model, signal, deps)
                    : await probeTool(endpoint, probe.model, signal, deps)
            }

            if (klass === undefined) {
                if (signal.aborted) break
                // 上游中止这次 wire 请求但整轮未被取消：没结论、不入账，仍结算进度。
                emitProbe(probe, { outcome: 'aborted', failure: undefined }, { settled: 1, ...(state.provider === group.provider ? {} : { route: state.provider }) })
                continue
            }

            const verdict: ProbeVerdict = { outcome: klass.outcome, failure: undefined, cap: klass.verdict }
            const result: VerifyProbeResult = {
                provider: probe.provider,
                model: probe.model,
                effort: undefined,
                outcome: klass.outcome,
                failure: undefined,
                cap: klass.verdict,
            }
            results.push(result)
            state.results.push(result)

            const blockReason = providerBlockReason(klass.outcome, state.sent === 1)
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
        for (const probe of group.probes) models.add(JSON.stringify([probe.provider, probe.model]))
        const segments = [...routes.values()].map((state) => ({
            provider: state.provider,
            results: state.results,
            blockedBy: state.blockedBy,
            planned: state.planned,
            plannedEfforts: 0,
            tested: state.models.size,
        }))
        return {
            provider: group.provider,
            results,
            blockedBy: undefined,
            planned: group.probes.length,
            plannedEfforts: 0,
            tested: models.size,
            segments,
        }
    }
}

/** 从明细里收敛图片模态的写回条目（工具调用无官方字段，只展示不写）：supported 增、unsupported 且「剔除不支持」删、unknown 不动 */
export function imageInputEntries(
    results: readonly VerifyProbeResult[],
    dropUnsupported: boolean,
): CapInputApply[] {
    const entries: CapInputApply[] = []
    for (const item of results) {
        if (item.cap === undefined || item.cap.capability !== 'image') continue
        if (item.cap.result === 'supported') entries.push({ provider: item.provider, model: item.model, op: 'set' })
        else if (item.cap.result === 'unsupported' && dropUnsupported) entries.push({ provider: item.provider, model: item.model, op: 'unset' })
    }
    return entries
}

/** 三态计数（终帧 `summary.caps` 用） */
export function capTallyOf(results: readonly VerifyProbeResult[]): CapTally {
    const tally: CapTally = { supported: 0, unsupported: 0, unknown: 0 }
    for (const item of results) {
        if (item.cap === undefined) continue
        tally[item.cap.result] += 1
    }
    return tally
}

/**
 * 跑一轮能力探测：解析端点 → 逐「模型 × 能力」wire 级最小请求 → 三态汇总 →（自动写入开）写回 `input` 图片模态 → 发终帧。
 * 无预声明、无两步写回：写回只动 `input` 一个字段（`reasoningEfforts` 等一概不碰，绝不写空壳），工具调用只展示。
 * 被中止（停止 / 关窗 / 断连）整轮不写回、不发终帧——口径与探测档位的「中止整轮还原」一致。
 */
export async function probeCapabilities(
    ctx: Context,
    payload: unknown,
    options: ProbeRunOptions = {},
    deps: CapDeps = {},
): Promise<VerifySummary> {
    const flags = capsFlagsOf(payload)
    const groups = planCapGroups(payload)
    // 端点逐 provider 解析一次（凭据解析是异步的；解析不到即整组不发请求，逐条记 no-credential 等原因）
    const lookup = deps.lookup ?? defaultCredentialLookup(ctx)
    const providers = providersOf(descriptorOf(ctx, API_NS)?.user)
    const endpoints = new Map<string, EndpointResolution>()
    for (const group of groups) {
        endpoints.set(group.provider, await resolveEndpoint(providers?.[group.provider], lookup))
    }
    const summary = await runProbeGroups(ctx.llm, groups, makeCapGroupRunner(endpoints, deps), options)
    const aborted = options.signal?.aborted === true
    const entries = aborted ? [] : imageInputEntries(summary.results, flags.dropUnsupported)
    // 写回统计两义同探测档位：「自动写入」开 = 已写入的补全统计；关 = 可写入的假设统计（只算不写）
    const plan = flags.autoWrite && entries.length > 0
        ? await applyCapInput(ctx, entries)
        : await previewCapInput(ctx, entries)
    const filled: VerifySummary = {
        ...summary,
        fill: { models: plan.models, added: plan.added, removed: plan.removed },
        caps: capTallyOf(summary.results),
    }
    // 终帧最后发：消费方拿到 done 时写回已落盘；中止不发（finishRun 自带闸）
    finishRun(filled, options)
    return filled
}
