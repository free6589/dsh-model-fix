/** 验证与探测记录区的纯文案层：TerminalBlock 展示文案、结论→文案键对照、记录行合成；零状态、零 React。 */

import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CardKey } from '@/client/locale-keys'
import { isProviderBlocking } from '@/shared/verify-progress'
import type { ProbeOutcome, VerifyProbedFrame } from '@/shared/verify-progress'

/** 宿主 TerminalBlock 展示文案（该包无语言回退，经 t() 提供）；宿主 0.2.1-alpha.2 起新增必填字段 commandLine 而 devDep 未跟上，并入期望类型以避开 excess-property，见 docs/host-api.md */
export type TerminalLabels = TerminalBlockLabels & { commandLine: (line: number) => string }

export function terminalLabelsOf(t: TranslateNS<'settings.modelFix'>): TerminalLabels {
    return {
        commandLine: (n) => t('terminalCommandLine', { n: String(n) }),
        signal: (signal) => t('terminalSignal', { signal }),
        exitCode: (code) => t('terminalExitCode', { code: String(code) }),
        noExitCode: t('terminalNoExitCode'),
        running: t('terminalRunning'),
        failed: t('terminalFailed'),
        done: t('terminalDone'),
        copy: t('terminalCopy'),
        copied: t('terminalCopied'),
        noOutput: t('terminalNoOutput'),
        collapseAria: '',
        collapse: '',
        expandAria: () => '',
        expand: () => '',
    }
}

/** 探测结论→文案键对照；aborted 只占类型位（中止不入账） */
const OUTCOME_KEYS: Record<ProbeOutcome, CardKey> = {
    usable: 'verifyOutUsable',
    'unsupported-effort': 'verifyOutUnsupported',
    unreachable: 'verifyOutUnreachable',
    quota: 'verifyOutQuota',
    credential: 'verifyOutCredential',
    'rate-limit': 'verifyOutRateLimit',
    timeout: 'verifyOutTimeout',
    aborted: 'verifyOutAborted',
    other: 'verifyOutOther',
}

/** 一条探测结论记录行；provider 级失败不带模型与档位，带 skipped 时补剩余条数 */
export function verifyLineOf(frame: VerifyProbedFrame, t: TranslateNS<'settings.modelFix'>): string {
    // 这类帧是“未派发”的进度占位，不是请求被中止；显示真正触发短路的提供方原因。
    if (frame.skippedReason !== undefined) {
        const reason = t(OUTCOME_KEYS[frame.skippedReason])
        const line = t('verifyLineProvider', { provider: frame.route ?? frame.provider, result: reason })
        return `${line}${t('verifySkipped', { count: String(frame.skipped ?? 0) })}`
    }
    const result = t(OUTCOME_KEYS[frame.outcome])
    const line = isProviderBlocking(frame.outcome)
        ? t('verifyLineProvider', { provider: frame.route ?? frame.provider, result })
        : frame.effort === undefined
            ? t('verifyLinePlain', { provider: frame.provider, model: frame.model, result })
            : t('verifyLine', { provider: frame.provider, model: frame.model, effort: frame.effort, result })
    return frame.skipped === undefined ? line : `${line}${t('verifySkipped', { count: String(frame.skipped) })}`
}

/** 一条能力探测记录行：一「模型 × 能力」一行，三态文案后附原因（`capReason`）；带 skipped 时补剩余条数。
 * 结论轴是 `cap`（wire 级三态），`frame.outcome` 只是短路与计数的机器账本；无 `cap` 的帧（理论上不出现）回落验证行模板 */
export function capLineOf(frame: VerifyProbedFrame, t: TranslateNS<'settings.modelFix'>): string {
    const cap = frame.cap
    if (cap === undefined) return verifyLineOf(frame, t)
    const verdict = t(cap.result === 'supported' ? 'capSupported' : cap.result === 'unsupported' ? 'capUnsupported' : 'capUnknown')
    const result = cap.reason === undefined ? verdict : `${verdict}${t('capReason', { reason: cap.reason })}`
    const line = t('capLine', {
        provider: frame.provider,
        model: frame.model,
        capability: t(cap.capability === 'image' ? 'capImage' : 'capTool'),
        result,
    })
    return frame.skipped === undefined ? line : `${line}${t('verifySkipped', { count: String(frame.skipped) })}`
}
