/** src/client/card-records.ts 纯文案层用例：渠道级短路帧按逻辑渠道显示原因（不被失败模型/实际 provider 冒名），
 * 以及能力探测的短路占位帧走同一条 provider 行模板而不是假装成某模型的 cap 结论 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CardKey } from '@/client/locale-keys'
import { zh } from '@/client/locale-zh'
import { capLineOf, verifyLineOf } from '@/client/card-records'
import type { VerifyProbedFrame } from '@/shared/verify-progress'
import { check } from '@test/helper'

/** 用真实中文词典拼文案：占位符替换与宿主 t() 同形，避免测试另造一套期望文案 */
const t = ((key: CardKey, params?: Record<string, string>) => {
    const template = zh[key]
    return template.replace(/\{(\w+)\}/g, (_, name: string) => params?.[name] ?? `{${name}}`)
}) as unknown as TranslateNS<'settings.modelFix'>

const frame = (overrides: Partial<VerifyProbedFrame>): VerifyProbedFrame => ({
    type: 'probed',
    provider: 'bifrost',
    model: 'freelane/m1',
    effort: undefined,
    outcome: 'aborted',
    done: 1,
    total: 2,
    ...overrides,
})

/** 执行本文件的全部用例 */
export function run(): void {
    check(
        'verifyLineOf 渠道级短路帧：显示逻辑渠道与真实原因，不显示失败模型',
        verifyLineOf(frame({ skipped: 2, skippedReason: 'unreachable', route: 'freelane' }), t) === 'freelane：无法连接（已跳过 2 项）',
        verifyLineOf(frame({ skipped: 2, skippedReason: 'unreachable', route: 'freelane' }), t),
    )
    check(
        'capLineOf 渠道级短路帧：按逻辑渠道显示原因，不拿失败模型的 cap 冒充分结论',
        capLineOf(frame({
            skipped: 2,
            skippedReason: 'credential',
            route: 'freelane',
            cap: { capability: 'tool', result: 'unknown', reason: 'HTTP 401' },
        }), t) === 'freelane：凭据无效（已跳过 2 项）',
        capLineOf(frame({
            skipped: 2,
            skippedReason: 'credential',
            route: 'freelane',
            cap: { capability: 'tool', result: 'unknown', reason: 'HTTP 401' },
        }), t),
    )
    check(
        'verifyLineOf 普通渠道级失败：仍按实际 provider 显示',
        verifyLineOf(frame({ provider: 'acme', model: 'm1', outcome: 'unreachable' }), t) === 'acme：无法连接',
        verifyLineOf(frame({ provider: 'acme', model: 'm1', outcome: 'unreachable' }), t),
    )
}
