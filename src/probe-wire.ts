/**
 * 能力探测的 wire 层（Node 半）：OpenAI Chat Completions 方言的裸 HTTP POST——出线编码、鉴权头、两级超时、响应体有界读取。
 * 判定矩阵不在本文件（见 `src/probe-caps.ts`）；不走 `llm.stream` 的三条理由（强制 `tool_choice`、图片编码可控、原始 status 与响应体）
 * 见 docs/decisions.md「能力探测」。密钥只进 `Authorization` 头，不进日志、不进帧、不进本文件任何返回值。
 */

/** 单次 wire 请求的等待上限（毫秒）：与 `probeOnce` 同语义——超时视为本次没跑成，防个别端点把整批拖死 */
export const WIRE_TIMEOUT_MS = 30_000
/**
 * 软超时后的宽限（毫秒）：软超时只发中止信号、等 fetch 收尾，宽限期满即硬兜底。
 * 兜底与「读 fetch / 读响应体」赛跑，端点即使忽略 `signal`，本函数也必然返回（同 probeOnce 的两级闸）。
 */
export const WIRE_TIMEOUT_GRACE_MS = 3_000
/** 响应体读取上限（字符）：判定只用前缀，超长错误体（HTML 错误页等）不整页读进内存 */
export const WIRE_BODY_LIMIT = 64 * 1024

/** 一次 wire 请求的观测：HTTP 响应（含原始 status 与有界响应体）或三类非 HTTP 收场 */
export type WireOutcome =
    | { kind: 'http'; status: number; text: string }
    /** fetch 拒绝（连接失败 / DNS / TLS 等）：端点不可达的唯一形态 */
    | { kind: 'network' }
    /** 我方软超时：本次没结论，不是端点不可达 */
    | { kind: 'timeout' }
    /** 外部中止（用户停止 / 关窗 / 断连）：没结论、不入账 */
    | { kind: 'aborted' }

/** `{baseURL}/chat/completions`：尾部斜杠先剥掉（baseURL 带不带 `/v1` 由用户配置负责，见 docs/decisions.md「能力探测」） */
export function chatCompletionsUrl(baseURL: string): string {
    return `${baseURL.replace(/\/+$/, '')}/chat/completions`
}

/** 有界读响应体：读满 `limit` 字符即停（截断收场，余量丢弃），无 body 即空串 */
async function readBounded(response: Response, limit: number): Promise<string> {
    const body = response.body
    if (body === null) return ''
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined) {
            text += decoder.decode(value, { stream: true })
            if (text.length >= limit) {
                // 超限即截断收场：判定只用前缀，余量不读（reader.cancel 会同时断掉端点的响应流）
                void reader.cancel().catch(() => {})
                return text.slice(0, limit)
            }
        }
    }
    return text
}

/**
 * 发一次 Chat Completions 请求并收包：`Authorization: Bearer <key>` 是 v1 唯一鉴权形态（Azure `api-key` 等留扩展点）。
 * 软超时只发中止信号，宽限期满即不再等待——`giveUp` 与 fetch、响应体读取分别赛跑，到点必然返回。
 * 外部中止优先于超时（与 probeOnce 同口径：用户按的停止不是失败）。
 *
 * @param timeoutMs 软超时（毫秒）：仅测试传更小的值
 * @param graceMs 软超时后的宽限（毫秒）：仅测试为缩短等待而传
 */
export async function postChatCompletions(
    url: string,
    apiKey: string,
    body: unknown,
    signal: AbortSignal,
    options: { fetchImpl?: typeof fetch; timeoutMs?: number; graceMs?: number } = {},
): Promise<WireOutcome> {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    const timeoutMs = options.timeoutMs ?? WIRE_TIMEOUT_MS
    const graceMs = options.graceMs ?? WIRE_TIMEOUT_GRACE_MS
    const controller = new AbortController()
    // 软超时只发中止信号：真实失败形态（远端 RST 等）由 fetch 收尾带回，兜底只兜「不 settle」。
    // 「超时的是我」不靠标志位——合成信号被中止且外部信号没中止即我方超时（外部中止优先）
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined
    const giveUp = new Promise<'give-up'>((resolve) => {
        giveUpTimer = setTimeout(() => resolve('give-up'), timeoutMs + graceMs)
    })
    // 我方超时与外部中止合成一路；中止源区分看外部信号（它没中止即我方超时）
    const signalAny = AbortSignal.any([signal, controller.signal])
    const settle = (): 'aborted' | 'timeout' => (signal.aborted ? 'aborted' : 'timeout')
    try {
        const sent = await Promise.race([
            fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
                body: JSON.stringify(body),
                signal: signalAny,
            }),
            giveUp,
        ])
        if (sent === 'give-up') return { kind: settle() }
        const read = await Promise.race([readBounded(sent, WIRE_BODY_LIMIT), giveUp])
        if (read === 'give-up') return { kind: settle() }
        return { kind: 'http', status: sent.status, text: read }
    } catch {
        // fetch 抛出的 AbortError 归中止/超时，其余（连接失败、响应体读取炸）归网络失败
        return { kind: signalAny.aborted ? settle() : 'network' }
    } finally {
        clearTimeout(timer)
        clearTimeout(giveUpTimer)
        controller.abort()
    }
}
