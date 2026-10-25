# dsh-model-fix

**English** | [简体中文](README.zh-CN.md)

Make custom models easier to use in [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

dsh-model-fix is a community plugin that fills in missing model settings and adds practical tools for compatibility, reasoning levels, and model capability checks. You can start with the default settings—no YAML editing required.

## Quick install

**Recommended: install the prebuilt release.** Make sure DSH is installed, then run this one command:

```bash
dsh plugin --profile web add "https://github.com/TikaFlow/dsh-model-fix/releases/latest/download/dsh-model-fix.tgz"
```

When installation finishes, restart DSH:

```bash
dsh web
```

If DSH is already running, stop it with `Ctrl+C` first, then run `dsh web` again.

Prefer clicking? If the DSH Plugin Market is available, open it, search for **dsh-model-fix**, and click **Install**.

## What it does

- **Fills missing model settings** — reasoning levels, context window, maximum output, and image input, using cached data from [models.dev](https://models.dev/).
- **Improves compatibility** — optional switches for endpoints that reject the `developer` role or the `store` request field.
- **Remembers your reasoning level** — saves your choice per model; optional settings can default to `high` or let the AI adjust the level.
- **Tests models** — checks availability and can probe reasoning levels, image input, and tool calls.
- **Helps subagents follow you** — optionally keeps a child agent in sync with its parent’s model and reasoning level.

## Start using it

1. Start or restart DSH.
2. Open **Settings → Model → Model Parameter Fill**.
3. Leave the defaults enabled to fill in missing model settings automatically. Change options in the card only when you need to.

By default, the plugin fills missing values without replacing settings you already configured. Turn on **Allow Update** only when you want existing values to be updated. Add a provider ID to **Excluded Providers** if you want the plugin to leave that provider alone.

> **Note:** Model capability and reasoning-level probes send real, small requests to the selected endpoints. They may use your provider's API quota. Run them only for the models you want to test.

## Install this repository's source

The quick-install command above uses the upstream project's prebuilt release. To install the source code from this repository instead:

```bash
dsh plugin --profile web add github:free6589/dsh-model-fix
```

Source installs may build locally and can require build-script approval.

## Help and license

- [Report a bug or request a feature](https://github.com/free6589/dsh-model-fix/issues)
- [Browse the source code](https://github.com/free6589/dsh-model-fix)
- License: [MIT](LICENSE)
