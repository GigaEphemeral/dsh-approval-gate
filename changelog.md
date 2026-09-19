1.DSH v0.1.5rc2兼容性错误 https://github.com/moon09300731/dsh-approval-gate/issues/15

2.DSH v0.1.5rc2适配, 合并 https://github.com/moon09300731/dsh-approval-gate/pull/1  以这种修改替代上面1的修改方式

3.修复 approval/request 挂载时报 permissionPresets.currents is not a function：DSH v0.1.5-rc2 的正确 API 是 permissionPresets.current(session)（返回会话当前预设名），不存在 currents 方法。原 PR#1 引入的 currents 调用导致每次审批瀑布都抛错并 fail-closed 回退 'unavailable'。


4.【启动崩溃】修复手动修改 bundle patch 导致的重复服务注册：`failed to apply loader entry permission2 (@deepseek-ai/dsh-permission-presets): service "permissionPresets" has been registered`。
   - 现象：`dsh web` 启动到「插件树加载」阶段失败，web 无法启动。
   - 原因：插件的 bundle patch（cordis.patch.yml）被手动改为 `- insert: - id: permission`（@deepseek-ai/dsh-permission-presets）。而基础 bundle（@deepseek-ai/dsh-base）已 insert 同 id 的 permission 行，loader 将后一个自动改名 permission2，两者都注册 permissionPresets 服务 → 第二次注册抛错。
   - 是否特殊情况：是。由手动误改 bundle patch 触发；正确做法是 auto-approve 预设写在 profile 自己的 cordis.patch.yml（顶层 id-targeted patch），插件 bundle patch 只 insert 插件自身行。已回退为只 insert `dsh-approval-gate`。

5.【审批不可用】修复 flash 判定失败：`provider "huoshan-186" model "DeepSeek-V4-Flash" does not support reasoning effort "off"`。
   - 现象：审批（approval/request）每次 flash 风险判定都异常，重试 2 次后仍失败 → fail-safe 转人工/不可用。
   - 原因：callFlash 硬编码 `reasoningEffort: 'off'`；当前会话默认模型是第三方 provider（huoshan-186 / DeepSeek-V4-Flash），其声明的能力档位不含 off，llm 运行时校验直接抛 UNSUPPORTED_REASONING_EFFORT。
   - 是否特殊情况：是（环境相关，取决于当前选用的模型/provider 是否支持 off 档位；官方 deepseek-official 系列支持）。
   - 修复：请求前用 `llm.resolveModelInfo(provider, model)` 查询该模型是否支持 off（按 provider/model 缓存），支持才发送、否则省略（走模型默认档位）；同时 reasoning-delta 不再计入答案文本，避免模型开思考时思考内容污染 SAFE/RISKY 判定。

6.【环境修复】恢复 web profile 中被移除的 dsh-approval-gate 插件。
   - 现象：审批完全失效（插件未加载，门控不生效）。
   - 原因：web profile 的 package.json 中 dsh-approval-gate 被移出 bundles/dependencies（排查启动崩溃过程中被移除，node_modules 仅残留失效链接）。
   - 是否特殊情况：是（本机 profile 环境变更，插件代码本身无问题）。已按原样恢复 link: 依赖与 bundles 项。

7.【测试】新增隔离功能测试（.ag-test/isolated-test.mjs）与 loader 合成树校验（.ag-test/verify-loader-tree.mjs）：前者用真实 DSH 运行时包 + 临时数据目录在独立进程验证审批管道与 reasoningEffort 兼容（15 用例全绿，含「模型不支持 off 仍正常判定」「思考文本不污染结论」）；后者校验 profile 各 bundle 层无重复 insert id。均不触碰主进程。

8.【环境参数】修复验证环境：DSH @deepseek-ai/dsh 0.1.5-rc.2（cordis 4.0.2）、Node v22.23.2、npm 10.9.8、插件 dsh-approval-gate 0.5.2、触发模型为第三方 provider huoshan-186 的 DeepSeek-V4-Flash。路径已隐私化：插件源目录、DSH_HOME、web profile 目录等一律不写具体路径。

9.【代码审查与加固】对第 3/5 条修改做安全审查，并修复审查发现的「误自动放行」风险。
   - 审查结论：
     a) 无 provider/model 硬编码：flash 判定跟随会话当前模型（agentDefaultModel 当前选择，动态读取），未写死 huoshan-186 等任何具体 provider；仅当该服务缺失时回退内置默认（deepseek-official/deepseek-v4-flash），属 fail-safe 兜底，不会改变正常路径的模型选择。
     b) 风险点：原判定解析用 `includes('SAFE')` / `includes('RISKY')` 匹配。模型不支持 reasoningEffort 'off' 时（第 5 条修复后）会走默认思考档位，若模型把分析文字放进正文，出现“该操作并不 SAFE”“有 RISKY 风险”等反例措辞会被误判为 SAFE → **误自动放行**（安全风险）；同类验证的 `includes('SAME')` 同理可误放行。
     c) 结论：该风险由「省略 reasoningEffort 允许模型思考」这一修复放大，必须一并加固。
   - 加固：判定词只认**文本末尾结论**（后面只允许空白/标点），正文中的 SAFE/RISKY/SAME/DIFFERENT 字样一律不算数（新增 trailingVerdict 辅助，judgeOnce 与 verifySimilarity 共用）；解析失败或无末尾结论 → fail-safe 转人工，**绝不自动放行**。另：reasoning-delta 不计入答案文本（第 5 条已改），双保险。
   - 对主题功能的影响：正常判定路径（SAFE 放行 / RISKY 硬类别转人工 / DENY / 白名单 / 学习计数 / 指纹命中）**全部不变**；唯一收紧点是「输出模糊无法确认末尾结论」由原来的猜测解析改为转人工（更保守、更安全，符合 fail-safe 设计）。代价：不支持 'off' 的模型每次 flash 判定耗 token/耗时略增（思考档位），且其输出必须带末尾结论才会被自动采纳。
   - 验证：隔离测试扩至 21 用例全绿，新增「正文含 SAFE 但结论不是 SAFE → 转人工（防误放行回归）」「正文含 RISKY 无末尾结论 → 转人工」「末尾结论带标点 → 正常放行」「同类验证正文含 SAME 但结论 DIFFERENT → 转人工」等。

10.【测试自动化】测试用例接入 `npm test` 自动执行（此前只有语法检查）。
   - `npm test` 现按顺序执行：语法检查（src/index.mjs + client.js）→ 隔离功能/风险用例（.ag-test/isolated-test.mjs，21 用例）→ loader 合成树校验（.ag-test/verify-loader-tree.mjs）。
   - 隔离用例完全自包含：独立进程 + 临时数据目录 + 桩服务，不触碰主进程；未安装 DSH 运行时或 profile 不存在时自动 SKIP 并以 0 退出，不影响裸克隆/CI。
   - verify-loader-tree 支持 `--profile <目录>` 指定检查对象（默认 profiles/web，相对 DSH_HOME），用作 permission2 启动崩溃的回归检查。
   - README 新增「🧪 测试」章节，列出三层检查的覆盖范围与运行方式。

11.【提交汇总】本次提交包含：a) flash 判定 reasoningEffort 'off' 兼容——模型不支持时自动省略、按默认档位执行（第 5 条）；b) 判定解析加固——只认文本末尾结论，杜绝正文 SAFE/RISKY/SAME 反例措辞导致的误自动放行（第 9 条）；c) 测试自动化——21 个隔离功能/风险用例 + loader 合成树校验接入 npm test，无 DSH 运行时自动 SKIP（第 7/10 条）；d) README 新增「手动配置」「🧪 测试」章节（保留 README 中既有内容，未删改）；e) package.json 的 test 脚本接入完整测试链；f) .gitignore 加入 .idea/（IDE 本地配置不入库）。路径隐私化原则贯穿以上记录。



