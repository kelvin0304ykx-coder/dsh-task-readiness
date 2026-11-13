首个公开发布版本：DSH 功能体检助手 0.1.0（宿主基线 DSH 0.2.2-rc.2）。

## 它能做什么

开工前判断“这个会话现在到底能不能做这件事”：把任务变成结构化能力要求，只读采集本轮工具准入、模型路由、工作目录、写入边界、审批策略、文档引擎与 MCP 可见性，给出逐项状态、依据和下一步。

- 工具：`readiness_check`、`readiness_probe`、`readiness_remedy`
- 命令：`/readiness`、`/readiness-list`、`/readiness-refresh`
- 内置模板：research / documents / images / browser / mcp
- 最小探测：文件读写、固定示例页抓取、一次限额检索、合成文档的转换/渲染/工作簿重算
- 受控处理：本插件自有任务选项（输出目录、替代路线、恢复），执行需宿主审批 allowed-once，执行后复检
- 运行时自包含：不 import 任何宿主包，零额外依赖

## 已知边界

- 图片理解、浏览器读取、MCP 连接、文档生成四类没有自动探测，报告中显示“未知 + 人工验证办法”。
- 只在 macOS arm64 + DSH 0.2.2-rc.2 上验证；Windows/Linux 未验证。
- 真实联网搜索/抓取、MCP、浏览器调用未执行；Office 引擎已用合成材料实测。
- 未做：真实宿主中的模型回合调用（隔离环境无模型凭据）。

## 安装

```sh
# 发布到 npm 后
dsh plugin --profile <profile> add dsh-task-readiness
# 或直接装本仓库的 Release 包
dsh plugin --profile <profile> add ./dsh-task-readiness-0.1.0.tgz
dsh plugin --profile <profile> remove dsh-task-readiness
```

MIT License。
