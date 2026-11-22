# Pi 扩展集合

每个扩展单独放在 `extensions/<名称>/`，可以按需加载，不需要一起启用。

| 扩展 | 用途 |
| --- | --- |
| [loop-to-done](extensions/loop-to-done/README.md) | 通过 CPA 监督当前 Pi 会话，按任务进展继续执行，或在完成、硬阻塞时停止。 |

快速试用：在仓库根目录运行 `pi -e ./extensions/loop-to-done/loop-to-done.ts`。首次使用请先阅读扩展说明中的模型配置与数据发送范围。

Pi Web 顶部按钮的实现位于 [pi-web-ex](https://github.com/williamxhero/pi-web-ex)，使用扩展命令本身不依赖该分叉版。

## 后续开发约定：插件与 Web UI 联动

目前保留 `loop-to-done` 专用按钮，不提前重构。**下一个功能也需要在 Pi Web 展示插件状态或触发插件命令时，先实现通用联动机制，不再为第二个插件硬编码按钮。** 插件声明操作名称、当前状态和对应命令；`pi-web-ex` 负责渲染和转发点击，不另存一份业务状态。届时让现有「自动续跑」和新功能共用这套机制。纯插件逻辑不需要 Web UI 时，不触发这项改造。
