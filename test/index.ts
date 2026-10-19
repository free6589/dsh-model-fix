// 测试入口：依次执行各模块用例并汇总退出码
import { run as runCatalog } from '@test/catalog.test'
import { run as runClientModel } from '@test/client-model.test'
import { run as runCompat } from '@test/compat.test'
import { run as runConfig } from '@test/config.test'
import { run as runEffort } from '@test/effort.test'
import { run as runEffortName } from '@test/effort-name.test'
import { run as runEmpty } from '@test/empty.test'
import { run as runFix } from '@test/fix.test'
import { run as runGuard } from '@test/guard.test'
import { run as runLookup } from '@test/lookup.test'
import { run as runMemory } from '@test/memory.test'
import { run as runMigrate } from '@test/migrate.test'
import { run as runOfficialFilter } from '@test/official-filter.test'
import { run as runUpgrade } from '@test/upgrade.test'
import { run as runProbe } from '@test/probe.test'
import { run as runProbeBackup } from '@test/probe-backup.test'
import { run as runProbeCaps } from '@test/probe-caps.test'
import { run as runCapRun } from '@test/cap-run.test'
import { run as runRefresh } from '@test/refresh.test'
import { run as runReset } from '@test/reset.test'
import { run as runRestore } from '@test/restore.test'
import { run as runRpcCarrier } from '@test/rpc-carrier.test'
import { run as runRpcRoute } from '@test/rpc-route.test'
import { run as runRpc } from '@test/rpc.test'
import { run as runSelfTune } from '@test/self-tune.test'
import { run as runSubagent } from '@test/subagent.test'
import { run as runVerify } from '@test/verify.test'
import { section, summary } from '@test/helper'

section('catalog.test.ts')
runCatalog()
section('client-model.test.ts')
runClientModel()
section('compat.test.ts')
runCompat()
section('config.test.ts')
runConfig()
section('effort.test.ts')
runEffort()
section('effort-name.test.ts')
runEffortName()
section('empty.test.ts')
runEmpty()
section('guard.test.ts')
runGuard()
section('lookup.test.ts')
runLookup()
section('memory.test.ts')
await runMemory()
section('migrate.test.ts')
runMigrate()
section('upgrade.test.ts')
runUpgrade()
section('official-filter.test.ts')
runOfficialFilter()
section('refresh.test.ts')
await runRefresh()
section('reset.test.ts')
runReset()
section('restore.test.ts')
runRestore()
section('verify.test.ts')
await runVerify()
section('probe.test.ts')
await runProbe()
section('probe-backup.test.ts')
await runProbeBackup()
section('probe-caps.test.ts')
await runProbeCaps()
section('cap-run.test.ts')
await runCapRun()
section('rpc-carrier.test.ts')
await runRpcCarrier()
section('rpc-route.test.ts')
await runRpcRoute()
section('rpc.test.ts')
await runRpc()
section('self-tune.test.ts')
await runSelfTune()
section('fix.test.ts')
await runFix()
section('subagent.test.ts')
await runSubagent()
summary()
