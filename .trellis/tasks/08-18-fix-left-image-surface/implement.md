# Implement - 修复生图左侧显示工具结果关联

## Steps

1. 将 `generate_image.execute()` 改为同步执行“左侧展示 append + 模型 surface replacement”，并按 attachment id 累积图片。
2. 更新现有左侧展示测试，断言展示 append、覆盖完整范围的 replacement 元数据、无 deferred context及原内容保留。
3. 增加一个最小并发回归测试：四次工具完成后折叠 surface，断言一组调用、四张图片和四个可配对结果。
4. 运行静态检查和完整测试。
5. 重启本地 DSH Web，在新分支会话中并发生图并发送“继续”，确认左侧展示和后续模型请求。

## Validation

- `npm test`
- `node --check lib/index.js lib/client.js`
- `python3 ./.trellis/scripts/task.py validate .trellis/tasks/08-18-fix-left-image-surface`
- DSH Web：至少两个并发 `generate_image` 调用，图片只在左侧，后续请求无 `No tool output found`。

## Risk And Rollback Points

- 风险集中在 replacement 的 seq/provenance 元数据；测试必须使用与 DSH 相同的 append/replace surface fold，而不是只记录 append 调用。
- 若真实 DSH 版本拒绝 replacement，停止验证并回到设计阶段，不以 `deferContext` 作为静默回退。
