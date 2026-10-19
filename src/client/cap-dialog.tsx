/** 「能力探测」弹层（浏览器半）：`DiagnoseDialog` 外壳的组装层——两个能力勾选（图片输入 / 工具调用）与两个写回开关经 `extras` 插槽渲染在选项卡容器之下，
 * 选项卡行右侧「全选 / 取消全选」经 `tools` 递入。开关沿用探测档位的 `Switch` 组装与文案（「剔除不支持」给能力专属释义） */

import { useMemo } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { DiagnoseDialog } from '@/client/diagnose-dialog'
import type { DiagnoseTool } from '@/client/diagnose-dialog'
import type { VerifyCandidate } from '@/client/model'
import { TIP_MAX_WIDTH } from '@/client/card-styles'

const { Switch, Tooltip, IconInfoOutlineRegular } = primitives

interface CapDialogProps {
    t: TranslateNS<'settings.modelFix'>
    open: boolean
    /** 关窗即中止在途探测：连接一断，Node 半随即早停且整轮不写回 */
    onClose: () => void
    /** 在途（卡片 busy 判为 caps）：主键就地变「停止」，列表、小键与开关全禁 */
    running: boolean
    /** 无任何动作在途（卡片 busy 为空）：与「未勾选任何模型 / 未勾选任何能力」一同决定发起键是否可点 */
    idle: boolean
    /** 候选按提供方归组（外壳自会归组，传原始候选即可） */
    candidates: readonly VerifyCandidate[]
    picked: ReadonlySet<string>
    onTogglePick: (key: string) => void
    onToggleGroup: (models: readonly VerifyCandidate[]) => void
    /** 选项卡行右侧小键：全选 / 取消全选（由卡片组装，含文案判据） */
    tools: readonly DiagnoseTool[]
    /** 两个能力勾选（缺省全选）：至少留一项才能发跑 */
    capImage: boolean
    onCapImageChange: (value: boolean) => void
    capTool: boolean
    onCapToolChange: (value: boolean) => void
    /** 「自动写入」：关闭时只探测只汇报，`input` 图片模态不动 */
    autoWrite: boolean
    onAutoWriteChange: (value: boolean) => void
    /** 「剔除不支持」：只作用于图片模态（工具调用没有可写的官方字段） */
    dropUnsupported: boolean
    onDropUnsupportedChange: (drop: boolean) => void
    /** 记录区抬头：总项数取自 opened 帧；0 意味还没发起过 */
    total: number
    /** 记录区抬头进度段：已完成条数，逐条 probed 帧更新 */
    done: number
    lines: readonly string[]
    terminalLabels: TerminalBlockLabels
    onRun: () => void
    onStop: () => void
}

export function CapDialog(props: CapDialogProps) {
    const t = props.t
    // 取出 extras 用到的具名值：useMemo 闭包不捕整个 props（exhaustive-deps 要求依赖按值列出）
    const { running, capImage, capTool, autoWrite, dropUnsupported } = props
    const { onCapImageChange, onCapToolChange, onAutoWriteChange, onDropUnsupportedChange } = props
    const extras = useMemo(() => (
        <div className="dsh-mf-verifyOptions">
            <span className="dsh-mf-verifyOption">
                <label className="dsh-mf-verifyLabel">
                    <input
                        type="checkbox"
                        checked={capImage}
                        disabled={running}
                        onChange={() => { onCapImageChange(!capImage) }}
                    />
                    {t('capImage')}
                </label>
            </span>
            <span className="dsh-mf-verifyOption">
                <label className="dsh-mf-verifyLabel">
                    <input
                        type="checkbox"
                        checked={capTool}
                        disabled={running}
                        onChange={() => { onCapToolChange(!capTool) }}
                    />
                    {t('capTool')}
                </label>
            </span>
            <span className="dsh-mf-verifyOption">
                <Switch
                    checked={autoWrite}
                    disabled={running}
                    label={t('probeAutoWrite')}
                    onChange={onAutoWriteChange}
                />
                <span>{t('probeAutoWrite')}</span>
                {/* portal 必需（缺失会被模态层层叠上下文裁掉气泡） */}
                <Tooltip label={t('probeAutoWriteTip')} side="top" maxWidth={TIP_MAX_WIDTH} portal>
                    <button type="button" className="dsh-mf-help" aria-label={t('probeAutoWriteTip')}>
                        <IconInfoOutlineRegular size={12} />
                    </button>
                </Tooltip>
            </span>
            <span className="dsh-mf-verifyOption">
                <Switch
                    checked={dropUnsupported}
                    disabled={running || !autoWrite}
                    label={t('probeDropUnsupported')}
                    onChange={onDropUnsupportedChange}
                />
                <span>{t('probeDropUnsupported')}</span>
                <Tooltip label={t('capDropUnsupportedTip')} side="top" maxWidth={TIP_MAX_WIDTH} portal>
                    <button type="button" className="dsh-mf-help" aria-label={t('capDropUnsupportedTip')}>
                        <IconInfoOutlineRegular size={12} />
                    </button>
                </Tooltip>
            </span>
        </div>
    ), [t, running, capImage, capTool, autoWrite, dropUnsupported,
        onCapImageChange, onCapToolChange, onAutoWriteChange, onDropUnsupportedChange])
    return (
        <DiagnoseDialog
            t={t}
            titleKey="capTitle"
            descriptionKey="capDesc"
            quotaKey="capQuota"
            modelsTabKey="verifyTabModels"
            recordsTabKey="capTabRecords"
            listEmptyKey="verifyEmpty"
            terminalCwdKey="capProbe"
            terminalCommandKey="verifyCommand"
            runKey="capGo"
            stopKey="capStop"
            open={props.open}
            onClose={props.onClose}
            running={props.running}
            idle={props.idle}
            runDisabled={!props.capImage && !props.capTool}
            candidates={props.candidates}
            picked={props.picked}
            onTogglePick={props.onTogglePick}
            onToggleGroup={props.onToggleGroup}
            tools={props.tools}
            extras={extras}
            total={props.total}
            done={props.done}
            lines={props.lines}
            terminalLabels={props.terminalLabels}
            onRun={props.onRun}
            onStop={props.onStop}
        />
    )
}
