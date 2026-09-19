**简体中文** | [English](README.en.md)

# dsh-approval-gate

**DeepSeek Harness 自动审批门控 —— 最小人工介入，安全自动放行、危险转人工（fail-safe）。**

Flash 模型预判每次沙箱越界：常规操作自动放行，硬风险操作（删除 / 凭据 / 远程 / 系统 / 批量）永远转人工确认；学习沉淀只针对你确认过的操作，并提供界面化人工审查入口。


## Fork说明

- 原作者好像没有在维护了, 遇到一些 dsh 0.1.15-rc2 环境的使用问题; 该项目进行修复, 但是不发布新的包
- 开发者使用, 见下方 从源码安装 章节
- 注意! 使用需要进行手动配置
- 欢迎提交MR, 我会进行合并, 但是issue的话, 可能没时间排查

## todo

- 1.原作没有写 完整的功能性自动执行测试用例 和 风险控制用例,需要进行补充
- 2.整理功能列表进行维护

## ✨ 特性

- ⚡ **Flash 风险预判**：每次沙箱越界由 Flash 模型判定（`SAFE` / `RISKY:<类别>`），可回补操作自动放行
- 🛡️ **硬风险永远人工**：删除、凭据、远程/生产、系统路径、批量不可回补五类操作直接转人工，不计数、不学习
- 🎯 **确认制学习**：同一操作确认 N-1 次后自动放行；沉淀规则携带**操作指纹**，只放行你确认过的操作
- 🧠 **语义同类验证**：措辞变化但意图相同的操作，由 Flash 对照你的确认样本语义判断，不再依赖关键词
- 🔧 **配置热更新**：`allowlist.json` 修改即时生效，无需重启
- ✅ **人工审查 UI**：自动放行时输入框上方出现绿色提示；「审批」视图（轨迹右侧）展示当前会话完整放行时间线
- 📄 **文件改动对比与撤销**（v0.5.0+）：审批涉及的文件可点击查看 **unified diff**——变动行带上下 5 行上下文、多处修改按 hunk 分区并以「N unmodified lines」分隔条折叠、绿加红删灰上下文、双行号；一键「撤销此改动」投递指令让 AI 按快照恢复文件
- 🗂️ **会话级快照管理**（v0.5.0+）：快照按事件归属会话，审批视图按当前会话统计；清理支持「仅清本会话」与「清空全部」两档，避免误删其他会话未查看的 diff 记录

## 📸 界面速览

### ① 审批视图

![审批视图](docs/screenshots/approval-view.png)

「审批」标签页（轨迹右侧）按时间倒序展示当前会话的自动放行与人工审批记录：每条记录含工具名（`bash` / `edit`）、判定标签（「自动放行 · Flash 判定安全」「人工通过」等）、时间与操作说明。顶部统计栏显示本会话的 **diff 快照占用**（`2.9 KB · 3 条`），并提供两个清理入口：**「仅清本会话」**（只删除当前会话的快照，不影响其他会话未查看的 diff）与 **「清空全部」**（二次确认后清空所有会话，防止误删）。

### ② 文件改动对比（diff）

![diff 对话框](docs/screenshots/diff-panel.png)

点击审批记录中的文件即可打开对比面板：以 **unified diff** 展示改动前后差异——新增行绿底（`+`）、删除行红底（`-`）、上下文行灰底；左侧显示**原/新双行号**；多处修改按 **hunk 分区**，块间以灰色「`6 unmodified lines`」分隔条折叠未变更区间。顶部统计 `+2 / -2 行变更 · 20 行未变`。底部 **「撤销此改动」** 一键向对话投递撤销指令，AI 将按审批前的快照恢复文件。

### ③ 设置 · 自动审批

![设置-自动审批](docs/screenshots/settings-auto-approve.png)

设置页「自动审批」分区提供完整配置：**初始化权限预设**（一键写入 `cordis.patch.yml` 的 `auto-approve` 预设）、**当前判定管道总览**（DENY → 白名单 → denyRules → Flash → 学习）、**危险词黑名单**（预置条目 + 自定义添加）、以及热更新说明（修改即时生效，无需重启）。

## 🚀 快速开始

```sh
dsh plugin --profile web add dsh-approval-gate

```


## 🚀 从源码安装

进入你的dsh根目录
```sh

pnpm dsh plugin --profile web add /your/abs/path/to/dsh-approval-gate


```



1. **配置权限预设**：在 `~/.dsh/profiles/web/cordis.patch.yml` 添加 `auto-approve` 预设（[详见指南](docs/GUIDE.md#%E5%AE%89%E8%A3%85%E5%90%8E%E5%BF%85%E9%A1%BB%E6%89%8B%E5%8A%A8%E9%85%8D%E7%BD%AE%E6%9D%83%E9%99%90%E9%A2%84%E8%AE%BE%E5%85%B3%E9%94%AE%E6%AD%A5%E9%AA%A4)）
2. **重启** `dsh web`
3. **选择预设**：会话权限下拉选中「自动审批（Flash）」

## ⚙️ 手动配置（安装后必须做的两件事）

插件需要**两处手动配置**才能生效。以下均为**相对路径**：标注「相对 DSH 根目录」的指 `DSH_HOME`（通常 `~/.dsh`），标注「相对插件仓库根目录」的指本插件源码目录。

### ① 把插件注册进 profile

可以改用命令：`dsh plugin --profile <profile> add dsh-approval-gate`

也可以手动修改

修改 **`profiles/<profile>/package.json`**（相对 DSH 根目录；`<profile>` 通常为 `web`）：
- `dependencies` 加一行（源码 `link:` 安装，值为插件仓库的**绝对路径**）：
  ```json
  "dsh-approval-gate": "link:<插件仓库绝对路径>"
  ```
- `dsh.profile.bundles` 数组里加一项：`"dsh-approval-gate"`

### ② 配置 auto-approve 权限预设

修改 **`profiles/<profile>/cordis.patch.yml`**（相对 DSH 根目录），追加下面这段**顶层 id-targeted patch**（不要用 `- insert:`）：

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
      auto-approve:
        sandbox: workspace-write
        approval: ask
        name: 自动审批（Flash）
        description: 多级判定：工作区写入自动放行，危险操作转人工审批。
```

⚠️ **不要**把这个 `permission` 预设写进插件仓库里的 **`cordis.patch.yml`**（相对插件仓库根目录）——基础 bundle（`@deepseek-ai/dsh-base`）已注册同名 `permission` 行，再用 `- insert:` 插入会冲突，导致启动崩溃（`permission2` 重复服务注册）。插件仓库的 `cordis.patch.yml` 只负责插入插件自身行，保持默认即可。

### ③ 重启并选择预设

1. 重启 `dsh web`
2. 会话权限下拉选择「自动审批（Flash）」

### Flash 判定用哪个模型？

插件**不硬编码 provider/model**：flash 判定跟随会话当前选用的模型（读取 `agentDefaultModel` 的当前选择，动态获取）。仅当该服务不可用时才回退到内置默认（`deepseek-official / deepseek-v4-flash`），属 fail-safe 兜底。若你的模型不支持 `reasoningEffort: 'off'` 档位，插件会自动省略该字段、按模型默认档位执行，无需手动配置。

## 🧪 测试

一条命令自动执行全部检查（`npm test`）：

| 层 | 命令 | 覆盖内容 |
|---|---|---|
| 语法 | `node --check src/index.mjs`、`node --check client.js` | 宿主插件与浏览器端 bundle 语法 |
| 功能+风险用例 | `node .ag-test/isolated-test.mjs` | 21 个用例：权限预设门控、flash SAFE 放行、硬风险类别（deletion 等）转人工、DENY 危险词、白名单、中立确认计数、学习沉淀/指纹、同类验证（SAME/DIFFERENT）、`reasoningEffort: 'off'` 兼容（模型不支持时省略）、**防误放行回归**（正文含 SAFE/RISKY/SAME 反例一律不得自动放行）、思考文本不污染结论 |
| loader 合成树 | `node .ag-test/verify-loader-tree.mjs` | 校验 profile 各 bundle 层 + 用户层**无重复 insert id**（启动崩溃 `permission2` 的回归检查），并确认 `permission` / `dsh-approval-gate` 各只 insert 一次 |

- 功能/风险用例**完全隔离**：独立 Node 进程 + 临时数据目录 + 桩 llm/webServer，不触碰主进程、不绑定端口、不发真实模型请求。
- 没有安装 DSH 运行时（找不到 `<DSH_HOME>/profiles/node_modules`）或指定 profile 不存在时，相关用例**自动 SKIP 并以 0 退出**，不影响裸克隆/CI。
- loader 校验默认检查 `profiles/web`（相对 DSH_HOME），可用 `--profile <目录>` 指定其他 profile。

## 📖 文档

- [完整指南（管道 / 配置 / 安全设计 / 审查 UI）](docs/GUIDE.md) · [English Guide](docs/GUIDE.en.md)

## 📄 License

MIT
