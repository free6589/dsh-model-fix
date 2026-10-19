/** RPC 端点：forceUpdate / resetModels / restoreModels 三个写回端点（共用事件流守卫互斥）+ reportLocale 语言上报；
 * 验证、探测档位与能力探测的进度各开一条 `connection.fetch` exact 路由。
 * 路由自注册而非宿主 `connection.rpc.handle`（后者在 connection 服务 ctx 上求值 `owner.webServer`，而 connection 不再注入它必抛，详见 docs/decisions.md「写回端点」） */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcResult, HostConnectionService } from '@deepseek-ai/dsh-client-connection'
// ctx.llm 服务面声明合并（仅 type-only，不引运行期依赖；LLM 服务是插件 inject 依赖，装载即在）
import type {} from '@deepseek-ai/dsh-llm'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import {
    CAPS_STREAM_ROUTE, ENDPOINT_FORCE_UPDATE, ENDPOINT_REPORT_LOCALE,
    ENDPOINT_RESET_MODELS, ENDPOINT_RESTORE_MODELS,
    PLUGIN_NAME, PLUGIN_NS, PROBE_STREAM_ROUTE, VERIFY_STREAM_ROUTE,
} from '@/shared/constants'
import { errorText } from '@/shared/errors'
import { encodeProgressFrame } from '@/shared/verify-progress'
import type { VerifyProgressFrame, VerifySummary } from '@/shared/verify-progress'
import type { ProbeRunOptions } from '@/probe-engine'
import { fix } from '@/fix'
import { reportLocale } from '@/effort-name'
import { endIgnoreAll, isIgnoreAll, startIgnoreAll } from '@/guard'
import { probeAndFill } from '@/probe'
import { probeCapabilities } from '@/probe-caps'
import { resetModels } from '@/reset'
import { restoreModels } from '@/restore'
import { verifyModels } from '@/verify'
import { createChannelRoute } from '@/rpc-route'
import type { EndpointHandler } from '@/rpc-route'

/** 一轮执行的入口：载荷 → 进度帧 → 终帧。验证与探测档位同型，只有执行器不同 */
type ProgressRunner = (payload: unknown, options: ProbeRunOptions) => Promise<VerifySummary>

/** 守卫已开（另一写回在途）时的统一拒绝结果 */
const writeInProgress = (): ConnectionRpcResult<unknown> => ({
    ok: false,
    error: { code: 'model-fix/write-in-progress', message: '另一操作进行中，请稍后重试', details: {} },
})

/** 强制更新：置守卫 → fix → 解守卫；fix 内部已告警，此处转 RPC 失败结果 */
async function handleForceUpdate(ctx: Context): Promise<ConnectionRpcResult<unknown>> {
    if (isIgnoreAll()) return writeInProgress()
    startIgnoreAll()
    try {
        return { ok: true, value: { changed: await fix(ctx, true) } }
    } catch (error) {
        return { ok: false, error: { code: 'model-fix/force-update-failed', message: errorText(error), details: {} } }
    } finally {
        endIgnoreAll()
    }
}

/** 重置推理级别：守卫已开即拒 */
async function handleResetModels(ctx: Context): Promise<ConnectionRpcResult<unknown>> {
    if (isIgnoreAll()) return writeInProgress()
    try {
        return { ok: true, value: { changed: await resetModels(ctx) } }
    } catch (error) {
        return { ok: false, error: { code: 'model-fix/reset-models-failed', message: errorText(error), details: {} } }
    }
}

/** 恢复备份：守卫已开即拒 */
async function handleRestoreModels(ctx: Context): Promise<ConnectionRpcResult<unknown>> {
    if (isIgnoreAll()) return writeInProgress()
    try {
        return { ok: true, value: { changed: await restoreModels(ctx) } }
    } catch (error) {
        return { ok: false, error: { code: 'model-fix/restore-models-failed', message: errorText(error), details: {} } }
    }
}

/** 浏览器半启动时上报探测语言：Node 侧没有 locale 服务，见 effort-name.ts 的语言解析 */
function handleReportLocale(payload: unknown): ConnectionRpcResult<unknown> {
    reportLocale(payload)
    return { ok: true, value: {} }
}

/** 注册一个 channel（三个写回端点 + 语言上报）；register 返回 disposer，经 ctx.effect 挂卸载自动回收 */
export function installRpc(ctx: Context): void {
    // 子 fiber 声明 connection + webServer；无 webServer 的 profile（如 headless）下子 fiber 不启动，其余功能不受影响
    ctx.inject(['connection', 'webServer'], (rpcCtx) => {
        const connection = rpcCtx.get('connection') as Pick<HostConnectionService, 'requestRejection' | 'fetch'>
        const webServer = rpcCtx.get('webServer') as WebServer
        rpcCtx.effect(() => {
            const channel = `/${PLUGIN_NS}`
            // 三个写回端点都不读载荷（各按整份配置重算、或剔除模型上的推理级别）；只有语言上报读
            const handler: EndpointHandler = async (endpoint, payload) => {
                switch (endpoint) {
                    case ENDPOINT_FORCE_UPDATE: return handleForceUpdate(ctx)
                    case ENDPOINT_RESET_MODELS: return handleResetModels(ctx)
                    case ENDPOINT_RESTORE_MODELS: return handleRestoreModels(ctx)
                    case ENDPOINT_REPORT_LOCALE: return handleReportLocale(payload)
                    default:
                        return { ok: false, error: { code: 'model-fix/unknown-endpoint', message: `未知端点：${endpoint}`, details: {} } }
                }
            }
            const disposeChannel = webServer.register({ kind: 'prefix', path: channel, handler: createChannelRoute(connection, channel, handler) })
            // 两条进度流走 connection.fetch exact 路由（RPC 一次调用只对应一个 JSON 结果，装不下持续多帧的响应）
            const disposeStream = connection.fetch.register({
                path: VERIFY_STREAM_ROUTE,
                methods: ['POST'],
                requestBody: 'buffered',
                fetch: progressStreamFetch((payload, options) => verifyModels(ctx.llm, payload, options)),
            })
            // 探测档位的流多带一个 ctx：它一轮之内要写两次配置（预声明 + 收敛），都在守卫内完成
            const disposeProbe = connection.fetch.register({
                path: PROBE_STREAM_ROUTE,
                methods: ['POST'],
                requestBody: 'buffered',
                fetch: progressStreamFetch((payload, options) => probeAndFill(ctx, ctx.llm, payload, options), true),
            })
            // 能力探测的流同样写配置（只动 input 图片模态），与探测档位共用守卫闸；wire 级探测不需要 llm
            const disposeCaps = connection.fetch.register({
                path: CAPS_STREAM_ROUTE,
                methods: ['POST'],
                requestBody: 'buffered',
                fetch: progressStreamFetch((payload, options) => probeCapabilities(ctx, payload, options), true),
            })
            return () => {
                disposeChannel()
                void disposeStream() // fetch.register 的 disposer 是异步的，effect 只负责同步调用它
                void disposeProbe()
                void disposeCaps()
            }
        }, `${PLUGIN_NAME}: rpc`)
    })
}

/** 进度流的 Fetch 实现：请求体是模型清单，响应以 SSE 分帧。
 * 走 `connection.fetch.register` 而非 `webServer.register`：前者代管信任围栏、浏览器认证与客户端断开 → `request.signal`。
 * 验证、探测档位与能力探测共用此实现（线上形状同形，只有执行器不同）；`needsIdleGuard` 只给写配置的两条流（与写回端点互斥，已开即拒 409）。
 * 执行器抛错收于 `failed` 终帧，客户端已中止则不发（停止不是失败） */
export function progressStreamFetch(
    run: ProgressRunner,
    needsIdleGuard = false,
): (request: Request) => Promise<Response> {
    const encoder = new TextEncoder()
    return async (request) => {
        let payload: unknown
        try {
            payload = await request.json()
        } catch {
            return new Response('invalid json body', { status: 400 })
        }
        // 写配置的流（探测档位）在此查守卫：载荷先解析，判定与执行器置位之间无 await，并发请求不会双双通过
        if (needsIdleGuard && isIgnoreAll()) return new Response('另一操作进行中，请稍后重试', { status: 409 })
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const settle = (): void => {
                    try {
                        controller.close()
                    } catch {
                        // 客户端已断开，控制器随之失效，不必上报
                    }
                }
                const push = (frame: VerifyProgressFrame): void => {
                    try {
                        controller.enqueue(encoder.encode(encodeProgressFrame(frame)))
                    } catch {
                        // 同上：流已不可写，执行器随即随 signal 停下
                    }
                }
                run(payload, {
                    // 客户端断开时 request.signal 中止，让执行循环早停（即用即弃的诊断，用户已不在）
                    signal: request.signal,
                    onProgress: push,
                }).then(settle, (error: unknown) => {
                    if (!request.signal.aborted) push({ type: 'failed', message: errorText(error) })
                    settle()
                })
            },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
}
