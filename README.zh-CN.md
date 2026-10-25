# dsh-model-fix

[English](README.md) | **简体中文**

让 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 里的第三方模型更容易配置和使用。

dsh-model-fix 是一个社区插件，可以自动补全缺失的模型参数，并提供兼容性、推理级别和模型能力检测工具。新手直接使用默认设置即可，不需要手动编辑 YAML。

## 极简安装

**推荐安装预构建版本。** 请先安装 DSH，然后在终端复制执行这一条命令：

```bash
dsh plugin --profile web add "https://github.com/TikaFlow/dsh-model-fix/releases/latest/download/dsh-model-fix.tgz"
```

安装完成后，重启 DSH：

```bash
dsh web
```

如果 DSH 正在运行，先按 `Ctrl+C` 停止，再执行 `dsh web`。

想用图形界面？如果已经安装 DSH Plugin Market，打开市场，搜索 **dsh-model-fix**，点击 **Install** 即可。

## 它能做什么？

- **自动补全模型参数**：推理级别、上下文窗口、最大输出和图片输入信息；数据来自 [models.dev](https://models.dev/) 并使用本地缓存。
- **改善模型兼容性**：可选禁用部分端点不支持的 `developer` 角色或 `store` 请求字段。
- **记住推理级别**：每个模型单独记住你的选择；也可选择默认使用 `high`，或让 AI 根据任务调整档位。
- **检测模型能力**：检查模型是否可用，并探测推理级别、图片输入和工具调用能力。
- **让子智能体跟随父智能体**：可选同步父智能体的模型和推理级别。

## 安装后怎么用？

1. 启动或重启 DSH。
2. 打开 **设置 → 模型 → 模型参数填充**。
3. 保持默认设置即可自动补全缺失参数；只有需要调整行为时，才修改卡片中的选项。

默认情况下，插件只补全缺失值，不覆盖你已经手动配置的参数。只有开启 **允许更新** 后，才会更新已有参数。如果不希望插件处理某个提供方，把它的 ID 加入 **排除提供方** 即可。

> **注意：** 模型能力和推理级别探测会向你选中的端点发送真实的小请求，可能消耗 API 额度。只对确实需要检测的模型运行探测。

## 安装本仓库源码

上面的极简安装命令使用上游项目发布的预构建版本。如果你需要安装本仓库的源码版本：

```bash
dsh plugin --profile web add github:free6589/dsh-model-fix
```

源码安装可能会在本地构建，也可能需要你确认构建脚本权限。

## 反馈与许可

- [提交问题或功能建议](https://github.com/free6589/dsh-model-fix/issues)
- [查看源代码](https://github.com/free6589/dsh-model-fix)
- 许可证：[MIT](LICENSE)
