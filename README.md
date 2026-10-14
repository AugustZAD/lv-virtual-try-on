# LV Fitting Room

一个轻量的 AI 真人试穿网页：上传 1 张真人照片与 1–6 张服装参考，默认使用 Pruna 标准模式快速试穿，可选择 GPT Image 2 精细模式。

## 架构

- **GitHub Pages**：静态网页与本地图片预览。
- **Cloudflare Worker + Workflows**：校验上传内容并启动持久后台任务；每个 `Separate look` 使用独立子流程生成与轮询，网页接口直接汇总子流程结果，父流程延迟清理原图，避免一组衣服耗尽单次请求额度。用户关闭页面后仍会继续运行。
- **Pruna `p-image-try-on`**：默认标准模式，独立异步任务；保持输入尺寸，输出质量 95 的 JPEG，支持原姿势和参考姿势。分件模式每件独立生成，整套模式传入全部衣服。提交与状态请求不重试，上游错误直接展示。
- **Mob AI `image-gpt`**：可选精细模式，由网关路由至 GPT Image 2；Studio pose 自动选用这个模式。旧任务继续使用原模型。
- **MobAI R2**：使用不可猜的临时路径向网关提供参考图，子流程启动窗口结束后删除；生命周期规则会在 24 小时后兜底清理中断任务。

密钥、上游任务 ID 和参考图地址都不会进入前端包或日志。浏览器会在提交前保存一个不可猜的幂等任务 ID，即使移动网络在提交响应时中断，重新打开页面也能恢复查询而不会重复付费提交。每个任务会保存一份不含图片地址的结果清单，用于准确恢复多件衣服的进度；源图在子流程启动窗口结束后删除，结果与清单保留 3 天。

## 本地运行

前端：

```bash
python3 -m http.server 4173
```

Worker：

```bash
cp .dev.vars.example .dev.vars
npm install
npm run cf:dev
```

在 `.dev.vars` 中填写 `PRUNA_API_KEY`、`MOB_AI_API_KEY` 和 R2 访问密钥。不要提交这个文件。

## 检查与部署

```bash
npm run cf:types
npm run check
npx wrangler deploy --dry-run
npx wrangler secret put MOB_AI_API_KEY
npx wrangler secret put PRUNA_API_KEY
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npm run cf:deploy
```

静态网页可与 `atelier-board` 相同，通过 GitHub Pages 从仓库根目录发布。
