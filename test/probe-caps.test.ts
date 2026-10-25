// src/probe-caps.ts / src/probe-wire.ts / src/cap-fill.ts 用例：两条 body 构造（与 03-probe-audit.md §1.1/§1.2 逐字对齐）、
// 三态判定矩阵（200×tool_calls、4xx×关键字、5xx/超时→unknown、内联拒绝→回退链且绝不误判「不支持图片」）、端点/凭据/方言解析、
// wire 层（URL 拼接、鉴权头、两级超时、外部中止、有界响应体）、图片模态写回计划（input 增删、绝不产 reasoningEfforts op、unknown 零 op）
import {
    classifyImage,
    classifyTool,
    hasToolCall,
    imageProbeBody,
    toolProbeBody,
    resolveEndpoint,
    makeCapGroupRunner,
    planCapGroups,
    imageInputEntries,
    capTallyOf,
    IMAGE_DATA_URI,
    IMAGE_RAW_URL,
} from '@/probe-caps'
import { CAP_IDS } from '@/shared/cap-probe'
import { postChatCompletions, chatCompletionsUrl, WIRE_BODY_LIMIT } from '@/probe-wire'
import { planCapProbes, CAPS_LIMITS } from '@/probe-plan'
import { runProbeGroups } from '@/probe-engine'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { VerifyProgressFrame } from '@/shared/verify-progress'
import { planCapInput } from '@/cap-fill'
import type { VerifyProbeResult } from '@/shared/verify-progress'
import { check, stable } from '@test/helper'

/** 一条结果明细的快捷构造 */
const result = (model: string, cap: 'image' | 'tool', res: 'supported' | 'unsupported' | 'unknown'): VerifyProbeResult => ({
    provider: 'acme',
    model,
    effort: undefined,
    outcome: res === 'supported' ? 'usable' : res === 'unsupported' ? 'unsupported-effort' : 'other',
    failure: undefined,
    cap: { capability: cap, result: res },
})

/** fetch 桩：记录出线，按剧本应答 */
function stubFetch(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; headers: unknown; body: unknown }[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const request = init ?? {}
        calls.push({
            url: String(url),
            headers: request.headers,
            body: request.body === undefined ? undefined : JSON.parse(String(request.body)),
        })
        return reply(String(url), request)
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
}

/** 恒应答的 Response 构造 */
const respond = (status: number, text: string): Response => new Response(text, { status })

/** 执行本文件的全部用例 */
export async function run(): Promise<void> {
    // ---------- 请求体构造（快照断言：与 03-probe-audit.md 的样例逐字对齐） ----------
    {
        const body = imageProbeBody('m1', IMAGE_DATA_URI)
        check('imageProbeBody：text + image_url 两块、max_tokens=1、不流式', stable(body) === stable({
            model: 'm1',
            max_tokens: 1,
            stream: false,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Reply with: OK' },
                    { type: 'image_url', image_url: { url: IMAGE_DATA_URI } },
                ],
            }],
        }), body)
        check('imageProbeBody：data URI 常量即 1x1 PNG 内嵌', IMAGE_DATA_URI.startsWith('data:image/png;base64,'))
        check('imageProbeBody：raw URL 回退指仓库资产', IMAGE_RAW_URL === 'https://raw.githubusercontent.com/free6589/dsh-model-fix/main/assets/probe-1x1.png')
        const tool = toolProbeBody('m1')
        check('toolProbeBody：tools + 强制 tool_choice + max_tokens=1', stable(tool) === stable({
            model: 'm1',
            max_tokens: 1,
            stream: false,
            messages: [{ role: 'user', content: 'Hi' }],
            tools: [{
                type: 'function',
                function: {
                    name: 'ping',
                    description: 'Reply with a greeting.',
                    parameters: { type: 'object', properties: {} },
                },
            }],
            tool_choice: { type: 'function', function: { name: 'ping' } },
        }), tool)
    }

    // ---------- 工具调用判定：2xx 不单独作数，必须看到 tool_calls / finish_reason ----------
    {
        check('hasToolCall：message.tool_calls 非空判有', hasToolCall('{"choices":[{"message":{"tool_calls":[{"id":"1"}]},"finish_reason":"stop"}]}'))
        check('hasToolCall：仅 finish_reason=tool_calls 也算有', hasToolCall('{"choices":[{"message":{},"finish_reason":"tool_calls"}]}'))
        check('hasToolCall：2xx 纯文本作答判无', !hasToolCall('{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}]}'))
        check('hasToolCall：tool_calls 空数组判无', !hasToolCall('{"choices":[{"message":{"tool_calls":[]},"finish_reason":"stop"}]}'))
        check('hasToolCall：坏 JSON / 缺字段容错判无', !hasToolCall('oops') && !hasToolCall('{}') && !hasToolCall('{"choices":{}}'))
        const withCall = classifyTool(200, '{"choices":[{"message":{"tool_calls":[{"id":"1"}]},"finish_reason":"tool_calls"}]}')
        check('classifyTool：200 + tool_calls = supported', withCall.verdict.result === 'supported' && withCall.outcome === 'usable')
        const plain = classifyTool(200, '{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}]}')
        check('classifyTool：200 但无 tool_calls = unsupported（网关忽略 tools）', plain.verdict.result === 'unsupported' && plain.outcome === 'unsupported-effort', plain)
        check('classifyTool：200 无 tool_calls 的 reason 留 status 与 no tool_calls', plain.verdict.reason === 'HTTP 200 · no tool_calls', plain.verdict.reason)
        const reject = classifyTool(400, 'tools are not supported by this endpoint')
        check('classifyTool：4xx + tool/function 关键字 = unsupported', reject.verdict.result === 'unsupported' && reject.outcome === 'unsupported-effort')
        const other400 = classifyTool(400, 'bad request')
        check('classifyTool：其余 4xx = unknown', other400.verdict.result === 'unknown' && other400.outcome === 'other')
        check('classifyTool：5xx = unknown', classifyTool(503, 'boom').verdict.result === 'unknown')
        check('classifyTool：401 = unknown + credential（短路账本）', classifyTool(401, 'unauthorized').outcome === 'credential')
        check('classifyTool：429 = unknown + rate-limit', classifyTool(429, 'slow down').outcome === 'rate-limit')
    }

    // ---------- 图片判定三态 + 内联拒绝回退链（验收红线：拒收 data URI ≠ 不支持图片） ----------
    {
        const ok = classifyImage(200, '', 'data-uri')
        check('classifyImage：200 = supported', ok.verdict.result === 'supported' && ok.outcome === 'usable')
        check('classifyImage：200 的 reason 带原始 status', ok.verdict.reason === 'HTTP 200')
        const fallback = classifyImage(200, '', 'raw-url')
        check('classifyImage：raw URL 回退后通过的 reason 标注回退', fallback.verdict.reason?.includes('fallback=raw-url') === true)
        const noImage = classifyImage(400, 'model does not support image input', 'data-uri')
        check('classifyImage：4xx + image/vision 关键字 = unsupported', noImage.verdict.result === 'unsupported' && noImage.outcome === 'unsupported-effort')
        const inline = classifyImage(400, 'image_url must be a data: URI', 'data-uri')
        check('classifyImage：拒收 data URI（且含 image 字样）→ 回退重试而非 unsupported', inline.retry === true && inline.verdict.result !== 'unsupported', inline)
        const b64 = classifyImage(400, 'invalid base64 payload', 'data-uri')
        check('classifyImage：拒收 base64 内联编码 → 回退重试', b64.retry === true)
        const rawReject = classifyImage(400, 'model does not support image input', 'raw-url')
        check('classifyImage：回退后仍拒图片 = unsupported（不再重试）', rawReject.verdict.result === 'unsupported' && rawReject.retry !== true)
        const rawOther = classifyImage(400, 'bad request', 'raw-url')
        check('classifyImage：回退后其余 4xx = unknown', rawOther.verdict.result === 'unknown')
        check('classifyImage：其余 4xx = unknown（reason 带 status + 错误体摘要）',
            classifyImage(400, 'quota region mismatch', 'data-uri').verdict.reason === 'HTTP 400: quota region mismatch')
        check('classifyImage：5xx = unknown', classifyImage(500, 'boom', 'data-uri').verdict.result === 'unknown')
        check('classifyImage：401/403 = unknown + credential', classifyImage(403, 'denied', 'data-uri').outcome === 'credential')
        check('classifyImage：429 = unknown + rate-limit', classifyImage(429, 'slow', 'data-uri').outcome === 'rate-limit')
    }

    // ---------- 端点 / 凭据 / 方言解析 ----------
    {
        const lookup = async (ref: string): Promise<string | undefined> => (ref === 'GOOD_KEY' ? 'sk-test' : undefined)
        const base = { api: 'openai-completions', baseURL: 'https://gw.example.com/v1', models: [] }
        const inline = await resolveEndpoint({ ...base, apiKey: 'sk-inline' }, lookup)
        check('resolveEndpoint：apiKey 明文优先', stable(inline) === stable({ kind: 'ok', baseURL: 'https://gw.example.com/v1', apiKey: 'sk-inline' }), inline)
        const viaEnv = await resolveEndpoint({ ...base, apiKeyEnv: 'GOOD_KEY' }, lookup)
        check('resolveEndpoint：apiKeyEnv 经解析取值', stable(viaEnv) === stable({ kind: 'ok', baseURL: 'https://gw.example.com/v1', apiKey: 'sk-test' }), viaEnv)
        const missing = await resolveEndpoint({ ...base, apiKeyEnv: 'MISSING_KEY' }, lookup)
        check('resolveEndpoint：解析不到 = no-credential（不发请求）', (missing as { reason: string }).reason === 'no-credential', missing)
        const noRef = await resolveEndpoint(base, lookup)
        check('resolveEndpoint：无任何凭据字段 = no-credential', (noRef as { reason: string }).reason === 'no-credential')
        const otherDialect = await resolveEndpoint({ ...base, api: 'openai-responses', apiKey: 'sk' }, lookup)
        check('resolveEndpoint：其它方言 = dialect-scope（不发请求）', (otherDialect as { reason: string }).reason === 'dialect-scope', otherDialect)
        const noApi = await resolveEndpoint({ baseURL: 'https://gw.example.com/v1', apiKey: 'sk' }, lookup)
        check('resolveEndpoint：api 未声明 = dialect-scope（形状无从猜）', (noApi as { reason: string }).reason === 'dialect-scope', noApi)
        const noUrl = await resolveEndpoint({ api: 'openai-completions', apiKey: 'sk' }, lookup)
        check('resolveEndpoint：缺 baseURL = no-endpoint', (noUrl as { reason: string }).reason === 'no-endpoint')
        const notObject = await resolveEndpoint(undefined, lookup)
        check('resolveEndpoint：段缺失按 dialect-scope 处理', (notObject as { reason: string }).reason === 'dialect-scope')
    }

    // ---------- wire 层：URL 拼接、鉴权头、有界响应体、三类非 HTTP 收场 ----------
    {
        check('chatCompletionsUrl：尾斜杠剥掉再拼', chatCompletionsUrl('https://gw.example.com/v1/') === 'https://gw.example.com/v1/chat/completions')
        const { calls, fetchImpl } = stubFetch(() => respond(200, '{"ok":true}'))
        const outcome = await postChatCompletions('https://gw.example.com/v1/chat/completions', 'sk-x', { hello: 1 }, new AbortController().signal, { fetchImpl })
        check('postChatCompletions：HTTP 响应原样带回', stable(outcome) === stable({ kind: 'http', status: 200, text: '{"ok":true}' }), outcome)
        check('postChatCompletions：Authorization Bearer + JSON 出线', stable({
            url: calls[0].url,
            headers: calls[0].headers,
            body: calls[0].body,
        }) === stable({
            url: 'https://gw.example.com/v1/chat/completions',
            headers: { 'content-type': 'application/json', authorization: 'Bearer sk-x' },
            body: { hello: 1 },
        }), calls[0])
        const failing = stubFetch(() => Promise.reject(new Error('offline')))
        check('postChatCompletions：fetch 拒绝 = network', (await postChatCompletions('u', 'k', {}, new AbortController().signal, { fetchImpl: failing.fetchImpl })).kind === 'network')
        // 软超时 + 硬兜底：fetch 永不 settle、忽略 signal，到点必然返回 timeout
        const hung = (() => ({ fetchImpl: (() => new Promise<Response>(() => {})) as unknown as typeof fetch }))()
        const timed = await postChatCompletions('u', 'k', {}, new AbortController().signal, { fetchImpl: hung.fetchImpl, timeoutMs: 10, graceMs: 5 })
        check('postChatCompletions：不 settle 的端点按两级超时兜底 = timeout', timed.kind === 'timeout', timed)
        // 外部中止优先于超时
        const gate = new AbortController()
        const aborting = { fetchImpl: ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })) as unknown as typeof fetch }
        const pending = postChatCompletions('u', 'k', {}, gate.signal, { fetchImpl: aborting.fetchImpl, timeoutMs: 1000, graceMs: 100 })
        gate.abort()
        check('postChatCompletions：外部中止 = aborted（不是失败）', (await pending).kind === 'aborted')
        // 有界读取：超长错误体截断进内存
        const huge = stubFetch(() => respond(400, 'x'.repeat(WIRE_BODY_LIMIT * 3)))
        const bounded = await postChatCompletions('u', 'k', {}, new AbortController().signal, { fetchImpl: huge.fetchImpl })
        check('postChatCompletions：响应体有界读取（超限即截断）', bounded.kind === 'http' && bounded.text.length === WIRE_BODY_LIMIT, bounded.kind === 'http' ? bounded.text.length : bounded.kind)
    }

    // ---------- 计划展开：模型 × 能力，配额硬闸 ----------
    {
        const probes = planCapProbes({ models: [{ provider: 'acme', model: 'm1' }, { provider: 'acme', model: 'm2' }], capabilities: ['image', 'tool'] })
        check('planCapProbes：模型 × 能力逐条展开', probes !== undefined && probes.length === 4 && probes.every((p) => p.capability !== undefined), probes)
        check('planCapProbes：能力按载荷序去重', stable(planCapProbes({ models: [{ provider: 'a', model: 'm' }], capabilities: ['tool', 'tool'] })) === stable([{ provider: 'a', model: 'm', capability: 'tool' }]))
        check('planCapProbes：efforts 一概忽略', stable(planCapProbes({ models: [{ provider: 'a', model: 'm', efforts: ['high'] }], capabilities: ['image'] })) === stable([{ provider: 'a', model: 'm', capability: 'image' }]))
        check('planCapProbes：非法能力取值拒绝', planCapProbes({ models: [{ provider: 'a', model: 'm' }], capabilities: ['audio'] }) === undefined)
        check('planCapProbes：空能力 / 空模型清单拒绝', planCapProbes({ models: [{ provider: 'a', model: 'm' }], capabilities: [] }) === undefined
            && planCapProbes({ models: [], capabilities: ['image'] }) === undefined)
        check('planCapProbes：坏条目拒绝', planCapProbes({ models: [{ provider: 'a' }], capabilities: ['image'] }) === undefined)
        check('planCapProbes：能力取值域即 CAP_IDS', stable([...CAP_IDS]) === stable(['image', 'tool']))
        const many = Array.from({ length: 201 }, (_, i) => ({ provider: 'a', model: `m${i}` }))
        check('planCapProbes：超配额整体拒绝（不静默截断）', planCapProbes({ models: many, capabilities: ['image'] }) === undefined)
        check('CAPS_LIMITS：每能力每轮 ≤200 请求', CAPS_LIMITS.maxModels === 200 && CAPS_LIMITS.maxProbes === 400)
    }

    // ---------- 同一聚合网关内按逻辑渠道隔离 credential short-circuit ----------
    {
        const { calls, fetchImpl } = stubFetch((_url, init) => {
            const body = JSON.parse(String(init.body)) as { model?: string }
            if (body.model === 'freelane/m1') return respond(401, 'unauthorized')
            return respond(200, '{"choices":[{"message":{"tool_calls":[{"id":"1"}]},"finish_reason":"tool_calls"}]}')
        })
        const groups = planCapGroups({
            models: [
                { provider: 'bifrost', model: 'freelane/m1' },
                { provider: 'bifrost', model: 'tokenrhythm/m1' },
                { provider: 'bifrost', model: 'freelane/m2' },
                { provider: 'bifrost', model: 'wb/cn:model' },
            ],
            capabilities: ['tool'],
        })
        const runner = makeCapGroupRunner(new Map([
            ['bifrost', { kind: 'ok', baseURL: 'https://gw.example.com/v1', apiKey: 'sk-test' } as const],
        ]), { fetchImpl })
        const frames: VerifyProgressFrame[] = []
        const summary = await runProbeGroups(
            { stream: () => { throw new Error('capability runner must not use llm.stream') } } as unknown as Pick<LlmRuntime, 'stream'>,
            groups,
            runner,
            { onProgress: (frame) => { frames.push(frame) } },
        )
        const freelane = summary.providers.find((report) => report.provider === 'freelane')
        const tokenrhythm = summary.providers.find((report) => report.provider === 'tokenrhythm')
        const wb = summary.providers.find((report) => report.provider === 'wb')
        check(
            '能力探测聚合器渠道隔离：freelane 401 后只跳过 freelane，其他渠道仍请求',
            stable(calls.map((call) => (call.body as { model: string }).model)) === stable(['freelane/m1', 'tokenrhythm/m1', 'wb/cn:model'])
            && freelane !== undefined && freelane.blockedBy === 'credential' && freelane.planned === 2 && freelane.probed === 1
            && tokenrhythm !== undefined && tokenrhythm.blockedBy === undefined && tokenrhythm.probed === 1
            && wb !== undefined && wb.blockedBy === undefined && wb.probed === 1
            && summary.planned === 4 && summary.probed === 3,
            { calls: calls.map((call) => call.body), providers: summary.providers, planned: summary.planned, probed: summary.probed },
        )
        check(
            '能力探测跳过帧保留逻辑 route 与短路原因',
            frames.some((frame) => frame.type === 'probed' && frame.route === 'freelane' && frame.skippedReason === 'credential' && frame.skipped === 1),
            frames.filter((frame) => frame.type === 'probed'),
        )
    }

    // ---------- 写回计划：只动 input、绝不产 reasoningEfforts op、unknown 零 op ----------
    {
        const entries = imageInputEntries([
            result('m1', 'image', 'supported'),
            result('m2', 'image', 'unsupported'),
            result('m3', 'image', 'unknown'),
            result('m1', 'tool', 'supported'),
            result('m4', 'tool', 'unsupported'),
        ], false)
        check('imageInputEntries：只收图片结论，unsupported 默认不删（只增不减）', stable(entries) === stable([{ provider: 'acme', model: 'm1', op: 'set' }]), entries)
        const dropping = imageInputEntries([
            result('m1', 'image', 'supported'),
            result('m2', 'image', 'unsupported'),
            result('m3', 'image', 'unknown'),
            result('m1', 'tool', 'unsupported'),
        ], true)
        check('imageInputEntries：剔除开时 unsupported 删键、unknown 仍不动、工具调用永不入写回',
            stable(dropping) === stable([{ provider: 'acme', model: 'm1', op: 'set' }, { provider: 'acme', model: 'm2', op: 'unset' }]), dropping)
        check('capTallyOf：三态计数', stable(capTallyOf([
            result('m1', 'image', 'supported'),
            result('m2', 'image', 'unknown'),
            result('m1', 'tool', 'unsupported'),
        ])) === stable({ supported: 1, unsupported: 1, unknown: 1 }))

        const providers = {
            acme: {
                models: [
                    { id: 'm1', reasoningEfforts: { high: 'high' }, contextWindow: 128000 },
                    { id: 'm2', input: ['text', 'image'] },
                    { id: 'm3', input: ['text'] },
                    { id: 'm4', reasoningEfforts: {} },
                ],
            },
        }
        const plan = planCapInput(providers, [
            { provider: 'acme', model: 'm1', op: 'set' },
            { provider: 'acme', model: 'm2', op: 'set' },
            { provider: 'acme', model: 'm3', op: 'unset' },
            { provider: 'acme', model: 'm4', op: 'set' },
            { provider: 'acme', model: 'gone', op: 'set' },
        ])
        check('planCapInput：set 补 [text,image]、unset 删键、已达成与已删目标零变更', plan.models === 3 && plan.added === 2 && plan.removed === 1, plan)
        check('planCapInput：一个 provider 一条 models 整段 op', plan.modelOps.length === 1 && stable(plan.modelOps[0].path) === stable(['providers', 'acme', 'models']))
        const written = (plan.modelOps[0] as { value: Record<string, unknown>[] }).value
        check('planCapInput：只动 input 一个字段（其余原样保留）', stable(written[0]) === stable({ id: 'm1', reasoningEfforts: { high: 'high' }, contextWindow: 128000, input: ['text', 'image'] }), written[0])
        check('planCapInput：绝不写 reasoningEfforts 空壳（顺手删键）', written[3].reasoningEfforts === undefined && written[3].input !== undefined, written[3])
        check('planCapInput：unset 连 input 键一起删', written[2].input === undefined && stable(written[2]) === stable({ id: 'm3' }), written[2])
        check('planCapInput：目标态已达成不重建（m2 不出 op）', stable(written[1]) === stable({ id: 'm2', input: ['text', 'image'] }) && plan.added === 2)
        const none = planCapInput(providers, [{ provider: 'acme', model: 'm2', op: 'set' }, { provider: 'nowhere', model: 'x', op: 'set' }])
        check('planCapInput：零变更零 op', none.modelOps.length === 0 && none.models === 0, none)
    }
}
