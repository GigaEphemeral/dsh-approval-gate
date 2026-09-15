1.DSH v0.1.5rc2兼容性错误 https://github.com/moon09300731/dsh-approval-gate/issues/15
2.DSH v0.1.5rc2适配, 合并 https://github.com/moon09300731/dsh-approval-gate/pull/1  以这种修改替代上面1的修改方式
3.修复 approval/request 挂载时报 permissionPresets.currents is not a function：DSH v0.1.5-rc2 的正确 API 是 permissionPresets.current(session)（返回会话当前预设名），不存在 currents 方法。原 PR#1 引入的 currents 调用导致每次审批瀑布都抛错并 fail-closed 回退 'unavailable'。



