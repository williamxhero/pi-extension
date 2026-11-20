# Pi 扩展集合

每个扩展单独放在 `extensions/<名称>/`，可以按需加载，不需要一起启用。

| 扩展 | 用途 |
| --- | --- |
| [loop-to-done](extensions/loop-to-done/README.md) | 通过 CPA 监督当前 Pi 会话，按任务进展继续执行，或在完成、硬阻塞时停止。 |

快速试用：在仓库根目录运行 `pi -e ./extensions/loop-to-done/loop-to-done.ts`。首次使用请先阅读扩展说明中的模型配置与数据发送范围。

Pi Web 顶部按钮的实现位于 [pi-web-ex](https://github.com/williamxhero/pi-web-ex)，使用扩展命令本身不依赖该分叉版。
