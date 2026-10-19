/** 「能力探测」编排 hook：模型勾选集、两个能力勾选、两个写回开关、记录区与发跑 / 停止 / 关窗；只编排不渲染，busy 由卡片传入。
 * 形态对齐 `card-probe.ts`（开关语义、占用态、中止链路同源），差异只有载荷多带能力勾选、记录行走三态模板、写回只动 `input` 图片模态。 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CapId } from '@/shared/cap-probe'
import { errorText } from '@/shared/errors'
import type { VerifyProgressUpdate, VerifySummary } from '@/shared/verify-progress'
import { toggleGroupPicks, verifyCandidatesOf, verifyTargets } from '@/client/model'
import type { VerifyCandidate, VerifyTarget } from '@/client/model'
import { truncateMessage } from '@/client/card-notice'
import type { CardBusy, Notice } from '@/client/card-notice'
import { capLineOf, terminalLabelsOf } from '@/client/card-records'

export interface CapRunOptions {
    t: TranslateNS<'settings.modelFix'>
    /** 卡片全局占用态 */
    busy: CardBusy
    setBusy: (busy: CardBusy) => void
    /** llm-pi-ai user 层（候选源，与验证 / 探测档位同源） */
    user: unknown
    /** 发起一轮能力探测（Node 半经进度流回帧）；返回 undefined = 被中止 */
    probeCapabilities: (
        models: readonly VerifyTarget[],
        flags: { capabilities: readonly CapId[]; dropUnsupported: boolean; autoWrite: boolean },
        onFrame: (frame: VerifyProgressUpdate) => void,
        signal: AbortSignal,
    ) => Promise<VerifySummary | undefined>
    /** 结果 / 失败提示落卡片状态行 */
    onNotice: (notice: Notice) => void
}

export function useCapRun(options: CapRunOptions) {
    const { t } = options
    const [open, setOpen] = useState(false)
    const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
    // 两个能力勾选缺省全选；「自动写入」缺省开（每次开窗重置为开）、「剔除不支持」缺省关（关窗复位）——与探测档位同口径
    const [capImage, setCapImage] = useState(true)
    const [capTool, setCapTool] = useState(true)
    const [autoWrite, setAutoWrite] = useState(true)
    const [dropUnsupported, setDropUnsupported] = useState(false)
    const [lines, setLines] = useState<readonly string[]>([])
    const [total, setTotal] = useState(0)
    const [done, setDone] = useState(0)
    const [stopped, setStopped] = useState(false)
    const abort = useRef<AbortController | null>(null)
    useEffect(() => () => { abort.current?.abort() }, [])
    const terminalLabels = useMemo<TerminalBlockLabels>(
        () => ({ ...terminalLabelsOf(t), done: stopped ? t('verifyStopped') : t('terminalDone') }),
        [t, stopped],
    )
    // 候选清单（与验证同源），发跑时冻结
    const candidates = useMemo(
        () => verifyCandidatesOf(options.user),
        [options.user],
    )
    /** 发跑一轮能力探测：勾选集与能力勾选在发跑时冻结为探测对象；一项能力都没勾即无可跑 */
    const run = () => {
        if (options.busy !== null) return
        const capabilities: CapId[] = [...(capImage ? ['image' as const] : []), ...(capTool ? ['tool' as const] : [])]
        const models = verifyTargets(candidates, picked)
        if (models.length === 0 || capabilities.length === 0) return
        setLines([])
        setTotal(0)
        setDone(0)
        setStopped(false)
        options.setBusy('caps')
        const controller = new AbortController()
        abort.current = controller
        const autoWriteValue = autoWrite
        options.probeCapabilities(models, { capabilities, dropUnsupported, autoWrite: autoWriteValue }, (frame) => {
            if (frame.type === 'opened') {
                setTotal(frame.total)
                return
            }
            setDone(frame.done)
            setLines((current) => [...current, capLineOf(frame, t)])
        }, controller.signal)
            .then((summary) => {
                if (summary === undefined) {
                    setStopped(true)
                    return
                }
                const fill = summary.fill
                const tally = summary.caps ?? { supported: 0, unsupported: 0, unknown: 0 }
                const stats = t('capDone', {
                    models: String(summary.tested),
                    probes: String(summary.planned),
                    supported: String(tally.supported),
                    unsupported: String(tally.unsupported),
                    unknown: String(tally.unknown),
                })
                setLines((current) => [...current, stats])
                if (autoWriteValue) {
                    const filled = t('capFilled', {
                        models: String(fill?.models ?? 0),
                        added: String(fill?.added ?? 0),
                        removed: String(fill?.removed ?? 0),
                    })
                    options.onNotice({ text: filled, tone: 'success' })
                    setLines((current) => [...current, filled])
                } else {
                    const held = t('capFillSkipped', {
                        models: String(fill?.models ?? 0),
                        added: String(fill?.added ?? 0),
                        removed: String(fill?.removed ?? 0),
                    })
                    setLines((current) => [...current, held])
                }
            })
            .catch((error: unknown) => {
                const failed = t('capFillFailed', { message: truncateMessage(errorText(error)) })
                options.onNotice({ text: failed, tone: 'error' })
                setLines((current) => [...current, failed])
            })
            .finally(() => {
                abort.current = null
                options.setBusy(null)
            })
    }
    const stop = () => {
        if (abort.current === null) return
        abort.current.abort()
        setLines((current) => [...current, t('capStoppedLine')])
    }
    const close = () => {
        abort.current?.abort()
        setOpen(false)
        setPicked(new Set())
        setCapImage(true)
        setCapTool(true)
        setLines([])
        setTotal(0)
        setDone(0)
        setStopped(false)
        setDropUnsupported(false)
    }
    const onOpen = () => {
        if (options.busy !== null) return
        setAutoWrite(true)
        setOpen(true)
    }
    const togglePick = (key: string) => {
        setPicked((current) => {
            const next = new Set(current)
            if (!next.delete(key)) next.add(key)
            return next
        })
    }
    const toggleGroup = (models: readonly VerifyCandidate[]) => {
        setPicked((current) => toggleGroupPicks(current, models))
    }
    const toggleAll = () => {
        setPicked((current) => toggleGroupPicks(current, candidates))
    }
    return {
        open, picked, candidates, capImage, setCapImage, capTool, setCapTool,
        autoWrite, setAutoWrite, dropUnsupported, setDropUnsupported,
        lines, total, done, running: options.busy === 'caps', terminalLabels,
        onOpen, run, stop, close, togglePick, toggleGroup, toggleAll,
    }
}
