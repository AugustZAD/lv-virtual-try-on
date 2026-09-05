# LV Fitting Room

一个轻量的 AI 真人试穿网页：上传 1 张真人照片与 1–6 张服装参考，使用 GPT Image 2 生成完整穿搭效果。

## 架构

- **GitHub Pages**：静态网页与本地图片预览。
- **Cloudflare Worker**：校验上传内容、限制生成频率，并安全调用 OpenAI Images Edit API。
- **GPT Image 2**：以真人照为第一张高保真输入，其余图片作为一组服装参考。

图片不会写入 KV、R2、数据库或日志。Worker 只在当前请求中转发图片，并把生成结果直接返回浏览器。

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

在 `.dev.vars` 中填写 `OPENAI_API_KEY`。不要提交这个文件。

## 检查与部署

```bash
npm run cf:types
npm run check
npx wrangler deploy --dry-run
npx wrangler secret put OPENAI_API_KEY
npm run cf:deploy
```

静态网页可与 `atelier-board` 相同，通过 GitHub Pages 从仓库根目录发布。
