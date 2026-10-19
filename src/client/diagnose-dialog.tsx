/** 诊断弹层的自足外壳 `DiagnoseDialog`（浏览器半）：「验证模型」与「探测档位」共用——两个选项卡（模型列表 / 验证或探测记录）+ 选项卡行右侧小键 + 底部动作行。状态与动作全由卡片经 props 递进来。样式数值见 `card-styles.ts` */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CardKey } from '@/client/locale-keys'
import { groupAllPicked, verifyKey } from '@/client/model'
import type { VerifyCandidate } from '@/client/model'

const { Button, Modal, StateDot, TerminalBlock } = primitives

/** 选项卡 id：既作页签/面板的 DOM id 后缀（aria-controls 与之配对），也作当前页的状态值 */
type DiagnoseTab = 'models' | 'records'

/** 选项卡行右侧的小键（在途一律禁用） */
export interface DiagnoseTool {
    label: string
    onClick: () => void
}

interface DiagnoseDialogProps {
    t: TranslateNS<'settings.modelFix'>
    /** 弹层标题，也作选项卡条的 aria-label */
    titleKey: CardKey
    descriptionKey: CardKey
    /** 额度提示（选项卡行之上，对两页都成立） */
    quotaKey: CardKey
    modelsTabKey: CardKey
    recordsTabKey: CardKey
    listEmptyKey: CardKey
    /** 记录区抬头（cwd 取功能名、command 是进度段） */
    terminalCwdKey: CardKey
    terminalCommandKey: CardKey
    /** 在途主键就地变「停止」，两态各一个文案键 */
    runKey: CardKey
    stopKey: CardKey
    open: boolean
    /** 关窗即中止在途诊断（取消键 / 遮罩 / Escape / × 都落这一个回调） */
    onClose: () => void
    /** 在途：键就地变「停止」，列表与小键全禁 */
    running: boolean
    /** 无任何动作在途：与「未勾选任何模型」一同决定发起键是否可点 */
    idle: boolean
    /** 发起键的追加禁用条件（能力探测的「一项能力都没勾」）；缺省只看 idle 与模型勾选数 */
    runDisabled?: boolean
    /** 候选（原始即可，本层自会归组） */
    candidates: readonly VerifyCandidate[]
    picked: ReadonlySet<string>
    onTogglePick: (key: string) => void
    onToggleGroup: (models: readonly VerifyCandidate[]) => void
    /** 选项卡行右侧小键（数组序渲染） */
    tools?: readonly DiagnoseTool[]
    /** 插槽：渲染在整个选项卡容器（页签条 + 两面板）之下（探测的开关组用） */
    extras?: React.ReactNode
    /** 记录区抬头：总项数（0 = 还没发起过，给一行空态） */
    total: number
    /** 记录区抬头：进度段（已完成条数，逐帧更新） */
    done: number
    lines: readonly string[]
    terminalLabels: TerminalBlockLabels
    onRun: () => void
    onStop: () => void
}

export function DiagnoseDialog(props: DiagnoseDialogProps) {
    const t = props.t
    // join 按 lines 引用缓存
    const output = useMemo(() => props.lines.join('\n'), [props.lines])
    const tabsId = useId()
    const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
    const [tab, setTab] = useState<DiagnoseTab>('models')
    // 开窗回「模型列表」
    useEffect(() => { if (props.open) setTab('models') }, [props.open])
    // running 时 total>0 才切记录页
    useEffect(() => { if (props.running && props.total > 0) setTab('records') }, [props.running, props.total])
    // 相邻同提供方成组
    const groups = useMemo(() => {
        const grouped: { provider: string; models: VerifyCandidate[] }[] = []
        for (const candidate of props.candidates) {
            const last = grouped[grouped.length - 1]
            if (last !== undefined && last.provider === candidate.provider) last.models.push(candidate)
            else grouped.push({ provider: candidate.provider, models: [candidate] })
        }
        return grouped
    }, [props.candidates])
    // 页签键盘：左右循环、Home / End 首尾
    const onTabKeyDown = (index: number, event: KeyboardEvent<HTMLButtonElement>) => {
        let nextIndex: number
        switch (event.key) {
            case 'ArrowRight': nextIndex = (index + 1) % 2; break
            case 'ArrowLeft': nextIndex = (index - 1 + 2) % 2; break
            case 'Home': nextIndex = 0; break
            case 'End': nextIndex = 1; break
            default: return
        }
        event.preventDefault()
        setTab(nextIndex === 0 ? 'models' : 'records')
        tabRefs.current[nextIndex]?.focus()
    }
    const tabs: readonly { id: DiagnoseTab; label: CardKey }[] = [
        { id: 'models', label: props.modelsTabKey },
        { id: 'records', label: props.recordsTabKey },
    ]
    return (
        <Modal
            open={props.open}
            onClose={props.onClose}
            title={t(props.titleKey)}
            closeLabel={t('close')}
            description={t(props.descriptionKey)}
            className="dsh-mf-verifyDialog"
            footer={
                <div className="dsh-mf-verifyButtons">
                    <Button variant="outline" data-modal-autofocus onClick={props.onClose}>{t('cancel')}</Button>
                    <Button
                        variant="outline"
                        className="dsh-mf-warn"
                        disabled={props.running ? false : !props.idle || props.picked.size === 0 || props.runDisabled === true}
                        onClick={() => {
                            if (props.running) props.onStop()
                            else props.onRun()
                        }}
                    >
                        {props.running ? <StateDot state="ongoing" /> : null}
                        {t(props.running ? props.stopKey : props.runKey)}
                    </Button>
                </div>
            }
        >
            <div className="dsh-mf-verifyBody">
                <p className="dsh-mf-verifyQuota">{t(props.quotaKey)}</p>
                <div className="dsh-mf-verifyTabsRow">
                    <div className="dsh-mf-verifyTabs" role="tablist" aria-label={t(props.titleKey)}>
                        {tabs.map((row, index) => {
                            const selected = row.id === tab
                            return (
                                <button
                                    key={row.id}
                                    ref={(element) => { tabRefs.current[index] = element }}
                                    id={`${tabsId}-tab-${row.id}`}
                                    type="button"
                                    role="tab"
                                    className="dsh-mf-verifyTab"
                                    aria-selected={selected}
                                    aria-controls={`${tabsId}-panel-${row.id}`}
                                    data-active={selected ? 'true' : undefined}
                                    tabIndex={selected ? 0 : -1}
                                    onClick={() => { setTab(row.id) }}
                                    onKeyDown={(event) => { onTabKeyDown(index, event) }}
                                >
                                    {t(row.label)}
                                </button>
                            )
                        })}
                    </div>
                    {props.tools && props.tools.length > 0 ? (
                        <div className="dsh-mf-verifyTools">
                            {props.tools.map((tool) => (
                                <Button
                                    key={tool.label}
                                    variant="ghost"
                                    size="sm"
                                    disabled={props.running}
                                    onClick={tool.onClick}
                                >
                                    {tool.label}
                                </Button>
                            ))}
                        </div>
                    ) : null}
                </div>
                {/* 面板常驻挂载，切页只改 hidden */}
                <div
                    id={`${tabsId}-panel-models`}
                    className="dsh-mf-verifyPanel"
                    role="tabpanel"
                    aria-labelledby={`${tabsId}-tab-models`}
                    hidden={tab !== 'models'}
                >
                    {groups.length === 0 ? (
                        <p className="dsh-mf-verifyEmpty" role="status">{t(props.listEmptyKey)}</p>
                    ) : (
                        <ul className="dsh-mf-verifyList">
                            {groups.map((group) => [
                                <li key={`g-${group.provider}`} className="dsh-mf-verifyGroup">
                                    {group.provider}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="dsh-mf-verifyGroupAll"
                                        disabled={props.running}
                                        onClick={() => { props.onToggleGroup(group.models) }}
                                    >
                                        {groupAllPicked(props.picked, group.models) ? t('verifyDeselectAll') : t('verifySelectAll')}
                                    </Button>
                                </li>,
                                ...group.models.map((candidate) => {
                                    const key = verifyKey(candidate.provider, candidate.model)
                                    return (
                                        <li key={key} className="dsh-mf-verifyRow">
                                            {/* 点整行即切换 */}
                                            <label className="dsh-mf-verifyLabel">
                                                <input
                                                    type="checkbox"
                                                    checked={props.picked.has(key)}
                                                    disabled={props.running}
                                                    onChange={() => { props.onTogglePick(key) }}
                                                />
                                                <span className="dsh-mf-verifyId" title={candidate.model}>{candidate.model}</span>
                                            </label>
                                        </li>
                                    )
                                }),
                            ])}
                        </ul>
                    )}
                </div>
                <div
                    id={`${tabsId}-panel-records`}
                    className="dsh-mf-verifyPanel"
                    role="tabpanel"
                    aria-labelledby={`${tabsId}-tab-records`}
                    hidden={tab !== 'records'}
                >
                    {props.total > 0 ? (
                        <TerminalBlock
                            cwd={t(props.terminalCwdKey)}
                            command={t(props.terminalCommandKey, { done: String(props.done), total: String(props.total) })}
                            output={output}
                            running={props.running}
                            maxLines={Infinity}
                            labels={props.terminalLabels}
                            className="dsh-mf-verifyLog"
                        />
                    ) : (
                        <p className="dsh-mf-verifyEmpty">{t('recordsEmpty')}</p>
                    )}
                </div>
                {props.extras}
            </div>
        </Modal>
    )
}
