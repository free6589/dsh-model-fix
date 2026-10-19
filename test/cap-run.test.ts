// src/probe-caps.ts 的 probeCapabilities 编排用例（带桩全链路）：帧序列、三态汇总、data URI→raw URL 回退、
// 401/403 provider 级短路、方言/凭据短路不发请求、写回只动 input（自动写入关=只算不写、剔除不支持=删键）、
// unknown 零写回、中止不写回不发终帧。fetch 桩先例 test/refresh.test.ts；真实网络不进 test/
import type { Context } from '@deepseek-ai/cordis'
import { probeCapabilities, IMAGE_RAW_URL } from '@/probe-caps'
import type { VerifyProbedFrame, VerifyProgressFrame, VerifySummary } from '@/shared/verify-progress'
import { makeStubCtx, resetModules } from '@test/ctx'
import type { StubCtx } from '@test/ctx'
import { check, stable } from '@test/helper'

/** 出线请求的应答剧本 */
interface Reply {
    status: number
    text: string
}

/** fetch 桩：按「第几次调用 + 请求体」应答，记录请求体；onCall 供用例中途触发中止 */
function stubFetch(script: (call: number, body: Record<string, unknown>) => Reply, onCall?: (call: number) => void) {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        bodies.push(body)
        onCall?.(bodies.length)
        const reply = script(bodies.length, body)
        return new Response(reply.text, { status: reply.status })
    }) as unknown as typeof fetch
    return { bodies, fetchImpl }
}

/** 请求体是不是工具探测（带 tools + tool_choice） */
const isTool = (body: Record<string, unknown>): boolean => body.tool_choice !== undefined
/** 图片探测本次出线的图片来源（data URI 优先、回退 raw URL） */
const imageSrc = (body: Record<string, unknown>): string => {
    const messages = body.messages as { content: { image_url?: { url: string } }[] }[]
    return messages[0].content[1].image_url?.url ?? ''
}

/** 跑一轮并收集帧 */
async function runRound(
    ctx: StubCtx,
    payload: unknown,
    deps: { fetchImpl?: typeof fetch; lookup?: (ref: string) => Promise<string | undefined> },
    signal?: AbortSignal,
): Promise<{ frames: VerifyProgressFrame[]; summary: VerifySummary }> {
    const frames: VerifyProgressFrame[] = []
    const summary = await probeCapabilities(ctx as unknown as Context, payload, {
        ...(signal === undefined ? {} : { signal }),
        onProgress: (frame) => { frames.push(frame) },
    }, {
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        ...(deps.lookup === undefined ? {} : { lookup: deps.lookup }),
    })
    return { frames, summary }
}

/** 默认端点：openai-completions 方言 + 可解析凭据 */
const ctxOf = (overrides: Record<string, unknown> = {}): StubCtx => makeStubCtx({
    api: {
        providers: {
            acme: {
                api: 'openai-completions',
                baseURL: 'https://gw.example.com/v1',
                apiKeyEnv: 'TEST_KEY',
                models: [{ id: 'm1' }, { id: 'm2' }],
                ...overrides,
            },
        },
    },
})

/** 恒可解析的凭据桩 */
const anyKey = async (): Promise<string | undefined> => 'sk-test'

/** 执行本文件的全部用例 */
export async function run(): Promise<void> {
    // ---------- 全通：帧序列、三态汇总、写回 input ----------
    {
        resetModules()
        const ctx = ctxOf()
        const { fetchImpl, bodies } = stubFetch((_call, body) => (isTool(body)
            ? { status: 200, text: '{"choices":[{"message":{"tool_calls":[{"id":"1"}]},"finish_reason":"tool_calls"}]}' }
            : { status: 200, text: '{"choices":[]}' }))
        const { frames, summary } = await runRound(ctx, {
            models: [{ provider: 'acme', model: 'm1' }, { provider: 'acme', model: 'm2' }],
            capabilities: ['image', 'tool'],
        }, { fetchImpl, lookup: anyKey })
        check('全通：四条计划、四条请求（每模型 × 每能力一条最小请求）', bodies.length === 4 && summary.planned === 4 && summary.probed === 4)
        check('全通：请求体即两条最小请求（max_tokens=1、单条消息）', bodies.every((body) => body.max_tokens === 1) && bodies[0].stream === false, bodies[0])
        check('全通：图片请求带 1x1 PNG data URI', imageSrc(bodies[0]).startsWith('data:image/png;base64,'))
        check('全通：opened 一条 + probed 四条 + done 一条', stable(frames.map((frame) => frame.type)) === stable(['opened', 'probed', 'probed', 'probed', 'probed', 'done']))
        const opened = frames[0]
        check('全通：opened.total 即计划条目数', opened.type === 'opened' && opened.total === 4)
        const probed = frames.filter((frame): frame is VerifyProbedFrame => frame.type === 'probed')
        check('全通：done ≤ total 且 done 帧携带三态计数', probed.every((frame) => frame.done <= frame.total)
            && stable(summary.caps) === stable({ supported: 4, unsupported: 0, unknown: 0 }), summary.caps)
        check('全通：probed 帧带三态结论', probed[0].cap?.result === 'supported')
        check('全通：自动写入补 input 图片模态', stable(summary.fill) === stable({ models: 2, added: 2, removed: 0 }), summary.fill)
        const writes = ctx.mutateCalls
        check('全通：一次 models 整段写回且守卫在位', writes.length === 1 && writes[0].guard === true, writes.length)
        const written = (writes[0].ops[0] as { value: Record<string, unknown>[] }).value
        check('全通：写回只动 input 一个字段', stable(written[0]) === stable({ id: 'm1', input: ['text', 'image'] }), written[0])
    }

    // ---------- data URI 被拒 → 仓库资产 raw URL 回退（验收红线） ----------
    {
        resetModules()
        const ctx = ctxOf()
        const { fetchImpl, bodies } = stubFetch((_call, body) => (imageSrc(body).startsWith('data:')
            ? { status: 400, text: 'image_url must be a data: URI or a reachable link' }
            : { status: 200, text: '{"choices":[]}' }))
        const { summary } = await runRound(ctx, {
            models: [{ provider: 'acme', model: 'm1' }],
            capabilities: ['image'],
        }, { fetchImpl, lookup: anyKey })
        check('回退：拒收 data URI 不判「不支持图片」而是重试', bodies.length === 2, bodies.length)
        check('回退：重试换仓库资产 raw URL', imageSrc(bodies[1]) === IMAGE_RAW_URL, imageSrc(bodies[1]))
        check('回退：重试通过判 supported 且回退留痕', stable(summary.results[0].cap) === stable({ capability: 'image', result: 'supported', reason: 'HTTP 200 · fallback=raw-url' }), summary.results[0].cap)
    }

    // ---------- 401/403 短路该 provider 全部剩余探测 ----------
    {
        resetModules()
        const ctx = ctxOf()
        const { fetchImpl, bodies } = stubFetch(() => ({ status: 401, text: 'unauthorized' }))
        const { frames, summary } = await runRound(ctx, {
            models: [{ provider: 'acme', model: 'm1' }, { provider: 'acme', model: 'm2' }],
            capabilities: ['image', 'tool'],
        }, { fetchImpl, lookup: anyKey })
        check('短路：凭据无效只发一条请求', bodies.length === 1, bodies.length)
        check('短路：后续条目以 skipped 计入进度', frames.some((frame) => frame.type === 'probed' && frame.skipped === 3), frames)
        check('短路：blockedBy=credential、probed=1/planned=4', summary.providers[0].blockedBy === 'credential' && summary.probed === 1 && summary.planned === 4)
        check('短路：结论是 unknown + 原因带 status', summary.results[0].cap?.result === 'unknown' && summary.results[0].cap?.reason === 'HTTP 401: unauthorized')
        check('短路：unknown 不写回', ctx.mutateCalls.length === 0 && stable(summary.fill) === stable({ models: 0, added: 0, removed: 0 }))
    }

    // ---------- 工具判定：2xx 无 tool_calls = 不支持；且工具调用永不写回 ----------
    {
        resetModules()
        const ctx = ctxOf()
        const { fetchImpl } = stubFetch((_call, body) => (isTool(body)
            ? { status: 200, text: '{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}]}' }
            : { status: 200, text: '{"choices":[]}' }))
        const { summary } = await runRound(ctx, {
            models: [{ provider: 'acme', model: 'm1' }],
            capabilities: ['image', 'tool'],
        }, { fetchImpl, lookup: anyKey })
        const tool = summary.results.find((item) => item.cap?.capability === 'tool')
        check('工具：2xx 但网关忽略 tools = unsupported', tool?.cap?.result === 'unsupported' && tool?.cap?.reason === 'HTTP 200 · no tool_calls', tool)
        check('工具：无官方字段、只展示不写回', stable(summary.fill) === stable({ models: 1, added: 1, removed: 0 }) && ctx.mutateCalls.length === 1)
    }

    // ---------- 「自动写入」关闭：只算不写 ----------
    {
        resetModules()
        const ctx = ctxOf()
        const { fetchImpl } = stubFetch((_call, body) => (isTool(body)
            ? { status: 200, text: '{"choices":[{"message":{"tool_calls":[{"id":"1"}]},"finish_reason":"tool_calls"}]}' }
            : { status: 200, text: '{"choices":[]}' }))
        const { summary } = await runRound(ctx, {
            models: [{ provider: 'acme', model: 'm1' }],
            capabilities: ['image', 'tool'],
            autoWrite: false,
        }, { fetchImpl, lookup: anyKey })
        check('只探不写：settings 零写入', ctx.mutateCalls.length === 0)
        check('只探不写：fill 是可写入的假设统计', stable(summary.fill) === stable({ models: 1, added: 1, removed: 0 }), summary.fill)
    }

    // ---------- 「剔除不支持」：明确判不支持图片的模型删 input 键 ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: {
                providers: {
                    acme: {
                        api: 'openai-completions',
                        baseURL: 'https://gw.example.com/v1',
                        apiKey: 'sk-inline',
                        models: [{ id: 'm1', input: ['text', 'image'] }],
                    },
                },
            },
        })
        const { fetchImpl } = stubFetch(() => ({ status: 400, text: 'model does not support image input' }))
        const { summary } = await runRound(ctx, {
            models: [{ provider: 'acme', model: 'm1' }],
            capabilities: ['image'],
            dropUnsupported: true,
        }, { fetchImpl, lookup: anyKey })
        check('剔除：明确判不支持图片', summary.results[0].cap?.result === 'unsupported')
        const writes = ctx.mutateCalls
        check('剔除：删 input 键（其余字段不动）', writes.length === 1
            && stable((writes[0].ops[0] as { value: Record<string, unknown>[] }).value) === stable([{ id: 'm1' }]), writes)
        check('剔除：统计记剔除 1', stable(summary.fill) === stable({ models: 1, added: 0, removed: 1 }), summary.fill)
    }

    // ---------- 5xx = unknown、零写回 ----------
    {
        resetModules()
        const ctx = ctxOf()
        const { fetchImpl } = stubFetch(() => ({ status: 503, text: 'upstream exploded' }))
        const { summary } = await runRound(ctx, {
            models: [{ provider: 'acme', model: 'm1' }],
            capabilities: ['image'],
        }, { fetchImpl, lookup: anyKey })
        check('5xx：unknown + 原因带 status 与错误体摘要', summary.results[0].cap?.result === 'unknown'
            && summary.results[0].cap?.reason === 'HTTP 503: upstream exploded', summary.results[0].cap)
        check('5xx：unknown 一律不写配置', ctx.mutateCalls.length === 0)
    }

    // ---------- 方言范围 / 凭据解析不到：不发请求、逐条记原因 ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: {
                providers: {
                    acme: {
                        api: 'openai-responses',
                        baseURL: 'https://gw.example.com/v1',
                        apiKey: 'sk-inline',
                        models: [{ id: 'm1' }],
                    },
                    bare: {
                        api: 'openai-completions',
                        baseURL: 'https://gw2.example.com/v1',
                        apiKeyEnv: 'NOPE_KEY',
                        models: [{ id: 'n1' }],
                    },
                },
            },
        })
        let calls = 0
        const { fetchImpl } = stubFetch(() => { calls++; return { status: 200, text: '{}' } })
        const { frames, summary } = await runRound(ctx, {
            models: [{ provider: 'acme', model: 'm1' }, { provider: 'bare', model: 'n1' }],
            capabilities: ['image', 'tool'],
        }, { fetchImpl, lookup: async () => undefined })
        check('方言/凭据短路：一条请求都不发', calls === 0, calls)
        const reasons = summary.results.map((item) => item.cap?.reason)
        check('方言短路：unknown + dialect-scope', reasons.slice(0, 2).every((reason) => reason === 'dialect-scope'), reasons)
        check('凭据短路：unknown + no-credential', reasons.slice(2).every((reason) => reason === 'no-credential'), reasons)
        check('短路结论仍逐条发帧入账', frames.filter((frame) => frame.type === 'probed').length === 4)
        check('短路结论不写回', ctx.mutateCalls.length === 0 && stable(summary.caps) === stable({ supported: 0, unsupported: 0, unknown: 4 }))
    }

    // ---------- 中止：不入账已中止条目、整轮不写回、不发终帧 ----------
    {
        resetModules()
        const ctx = ctxOf()
        const controller = new AbortController()
        const { fetchImpl } = stubFetch((_call, body) => (isTool(body)
            ? { status: 200, text: '{"choices":[{"message":{"tool_calls":[{"id":"1"}]},"finish_reason":"tool_calls"}]}' }
            : { status: 200, text: '{"choices":[]}' }), (call) => { if (call === 1) controller.abort() })
        const { frames } = await runRound(ctx, {
            models: [{ provider: 'acme', model: 'm1' }, { provider: 'acme', model: 'm2' }],
            capabilities: ['image', 'tool'],
        }, { fetchImpl, lookup: anyKey }, controller.signal)
        check('中止：不发 done 终帧（消费方据「流结束无终帧」判断）', !frames.some((frame) => frame.type === 'done'), frames.map((frame) => frame.type))
        check('中止：整轮不写回', ctx.mutateCalls.length === 0)
    }
}
