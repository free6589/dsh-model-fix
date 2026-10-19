/** 浏览器半调 Node 半的唯一出口：三个 channel RPC 写回端点、一条语言上报与三条进度流的读流。
 * 收在一处是因为它们同源——channel 字面量、endpoint 名、三条流各自的载荷形状都与 Node 半一一对应。卡片只消费本文件产出的 `RpcCarrier`，自己不发起请求 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
// channel RPC 的结果信封
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import {
    CAPS_STREAM_URL,
    ENDPOINT_FORCE_UPDATE, ENDPOINT_REPORT_LOCALE, ENDPOINT_RESET_MODELS,
    ENDPOINT_RESTORE_MODELS, PLUGIN_NS, PROBE_STREAM_URL, VERIFY_STREAM_URL, WRITEBACK_MS,
} from '@/shared/constants'
import type { CapId } from '@/shared/cap-probe'
import { decodeProgressFrame } from '@/shared/verify-progress'
import type { VerifyProgressUpdate, VerifySummary } from '@/shared/verify-progress'
import type { VerifyTarget } from '@/client/model'

/** 浏览器半经本文件调 Node 半的调用面：三个写回端点（各带 `WRITEBACK_MS` 等待上限）、语言上报与三条诊断链的读流 */
export interface RpcCarrier {
    /** 强制更新 RPC：channel 与端点在入口拼好，卡片只消费结果 */
    forceUpdate: () => Promise<ConnectionRpcResult<unknown>>
    /** 重置推理级别 RPC：仅剔除模型上的 reasoningEfforts（最大上下文 / 输出上限 / 图片模态可在模型页自行设置，不清除；excludes 命中跳过），配置段原样保留；返回受影响的模型数 */
    resetModels: () => Promise<ConnectionRpcResult<unknown>>
    /** 恢复备份 RPC：回退启动时备份到当前配置（共有 provider 的共有 model 回退，其下被删的 model 复活）；返回被恢复与复活的模型数 */
    restoreModels: () => Promise<ConnectionRpcResult<unknown>>
    /** 语言上报：把浏览器界面语言告知 Node 半（取值链见 `src/effort-name.ts`）；无等待上限——失败由调用方重报 */
    reportLocale: (locale: string) => Promise<ConnectionRpcResult<unknown>>
    /** 验证模型：走进度流端点，对每个勾选模型发一次不带推理级别的最小请求，逐条回调实时进度；整轮跑完回汇总，被中止（停止 / 关窗 / 断连）回 undefined，没能开跑或中途异常则抛错 */
    verifyModels: (
        models: readonly VerifyTarget[],
        onFrame: (frame: VerifyProgressUpdate) => void,
        signal: AbortSignal,
    ) => Promise<VerifySummary | undefined>
    /** 探测档位：走进度流端点，Node 半先把候选档位临时预声明进配置、再对每个模型逐档各发一次最小请求，跑完按「自动写入」开关收敛写回或整轮还原；终帧的 `summary.fill` 一律带收敛结论的增删统计（关闭时是「可补全」的假设统计）。开关须与 Node 半同值。被中止（停止 / 关窗 / 断连）回 undefined——中止不发终帧，且未跑完的模型一律还原成预声明之前的形态；没能开跑或中途异常则抛错 */
    probeEfforts: (
        models: readonly VerifyTarget[],
        flags: { dropUnsupported: boolean; autoWrite: boolean },
        onFrame: (frame: VerifyProgressUpdate) => void,
        signal: AbortSignal,
    ) => Promise<VerifySummary | undefined>
    /** 能力探测：走进度流端点，Node 半对每个「模型 × 能力」发一条 wire 级最小请求（图片输入 1x1 PNG、工具调用强制 tool_choice），三态判定（支持 / 不支持 / 未得出结论）。
     * 写回只动 `input` 图片模态（工具调用只展示不写）；开关须与 Node 半同值。被中止（停止 / 关窗 / 断连）回 undefined——中止不发终帧且整轮不写回；没能开跑或中途异常则抛错 */
    probeCapabilities: (
        models: readonly VerifyTarget[],
        flags: { capabilities: readonly CapId[]; dropUnsupported: boolean; autoWrite: boolean },
        onFrame: (frame: VerifyProgressUpdate) => void,
        signal: AbortSignal,
    ) => Promise<VerifySummary | undefined>
}

/** 取一份调用面。`rpc` 是宿主 connection 服务的 client RPC 面（由调用方在子 fiber 内取用后传入） */
export function makeRpcCarrier(rpc: ClientConnectionRpc): RpcCarrier {
    const channel = `/${PLUGIN_NS}`
    const forceUpdate = () => rpc.call(channel, ENDPOINT_FORCE_UPDATE, {}, AbortSignal.timeout(WRITEBACK_MS))
    const resetModels = () => rpc.call(channel, ENDPOINT_RESET_MODELS, {}, AbortSignal.timeout(WRITEBACK_MS))
    const restoreModels = () => rpc.call(channel, ENDPOINT_RESTORE_MODELS, {}, AbortSignal.timeout(WRITEBACK_MS))
    const reportLocale = (locale: string) => rpc.call(channel, ENDPOINT_REPORT_LOCALE, locale)
    /** 读一条进度流：POST 载荷，逐帧回调非终帧，收于终帧时返回整轮汇总。
     * 用 `fetch` + `getReader()` 而非 `EventSource`：后者自动重连，而重连等于把整轮重新跑一遍。非 2xx 时优先用响应体文案（Node 半两条流都会给一句中文原因）。
     * 被中止（点停止 / 关窗 / 断连）时返回 `undefined`，那不是失败 */
    const streamSummary = async (
        url: string,
        body: unknown,
        onFrame: (frame: VerifyProgressUpdate) => void,
        signal: AbortSignal,
    ): Promise<VerifySummary | undefined> => {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal,
            })
            if (!response.ok || response.body === null) {
                const reason = (await response.text().catch(() => '')).trim()
                throw new Error(reason === '' ? `HTTP ${response.status}` : reason)
            }
            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            let summary: VerifySummary | undefined
            let failure: string | undefined
            for (;;) {
                const { done, value } = await reader.read()
                // 解码走 stream 模式：多字节字符可能横跨两个分片边界
                if (value !== undefined) buffer += decoder.decode(value, { stream: true })
                // SSE 以空行分帧；末尾不足一帧的残片留给下一批
                let cut = buffer.indexOf('\n\n')
                while (cut !== -1) {
                    const frame = decodeProgressFrame(buffer.slice(0, cut))
                    buffer = buffer.slice(cut + 2)
                    cut = buffer.indexOf('\n\n')
                    if (frame === undefined) continue
                    if (frame.type === 'done') summary = frame.summary
                    else if (frame.type === 'failed') failure = frame.message
                    else onFrame(frame)
                }
                if (done) break
            }
            if (failure !== undefined) throw new Error(failure)
            return summary
        } catch (error) {
            if (signal.aborted) return undefined
            throw error
        }
    }
    /** 验证模型：载荷是卡片按勾选收敛好的「提供方 / 模型」清单（每模型一条不带档位参数的请求）。走独立的进度流端点而非 channel RPC——一次调用要回持续多帧的响应。用文档相对路由（去掉前导斜杠）是宿主对浏览器侧的约定，两侧同取 `src/shared/constants.ts` 的同一常量 */
    const verifyModels = (models: readonly VerifyTarget[], onFrame: (frame: VerifyProgressUpdate) => void, signal: AbortSignal) =>
        streamSummary(VERIFY_STREAM_URL, { models }, onFrame, signal)
    /** 探测档位：载荷与验证同形，另带两个开关，须与 Node 半共用同一个值——「剔除不支持」决定收敛口径；「自动写入」关闭时 Node 半在探测结束后只把预声明原样收回 */
    const probeEfforts = (
        models: readonly VerifyTarget[],
        flags: { dropUnsupported: boolean; autoWrite: boolean },
        onFrame: (frame: VerifyProgressUpdate) => void,
        signal: AbortSignal,
    ) => streamSummary(PROBE_STREAM_URL, { models, ...flags }, onFrame, signal)
    /** 能力探测：载荷与探测档位同形，另带能力勾选（image / tool）；两个开关与探测档位同语义（写回只动 input 图片模态） */
    const probeCapabilities = (
        models: readonly VerifyTarget[],
        flags: { capabilities: readonly CapId[]; dropUnsupported: boolean; autoWrite: boolean },
        onFrame: (frame: VerifyProgressUpdate) => void,
        signal: AbortSignal,
    ) => streamSummary(CAPS_STREAM_URL, { models, ...flags }, onFrame, signal)
    return { forceUpdate, resetModels, restoreModels, reportLocale, verifyModels, probeEfforts, probeCapabilities }
}
