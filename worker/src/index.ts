import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";

const MOB_AI_GENERATIONS_URL = "https://ai.mob-ai.cn/api/v1/generations";
const MOB_AI_IMAGE_MODEL = "image-gpt";
const MAX_GARMENTS = 6;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_WORKFLOW_POLLS = 360;
const UPLOAD_PREFIX = "temporary/lv-virtual-try-on";
const RESULT_PREFIX = "temporary/lv-virtual-try-on-results";
const LOCAL_ORIGIN_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const JOB_PATTERN = /^job_[a-f0-9]{32}$/;
const STORAGE_PREFIX_PATTERN = /^temporary\/lv-virtual-try-on\/[a-f0-9]{32}$/;
const RESULT_KEY_PATTERN = /^temporary\/lv-virtual-try-on-results\/job_[a-f0-9]{32}\.(?:jpg|png|webp)$/;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const QUALITY_VALUES = new Set(["low", "medium", "high"]);
const PROCESSING_STATUSES = new Set(["submitted", "queued", "pending", "processing", "running"]);
const FAILED_STATUSES = new Set(["failed", "error", "canceled", "cancelled"]);
const SUCCEEDED_STATUSES = new Set(["succeeded", "success", "completed", "complete"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return handleOptions(request, env);
    if (request.method === "GET" && url.pathname === "/") {
      return json({ background: "cloudflare-workflows", gateway: "mob-ai", model: MOB_AI_IMAGE_MODEL, service: "lv-virtual-try-on", status: "ok" }, 200);
    }

    const cors = corsFor(request, env);
    if (!cors) return json({ error: "Origin not allowed" }, 403);
    if (!hasRequiredConfiguration(env)) return json({ error: "图像生成服务尚未配置" }, 503, cors);

    try {
      if (request.method === "POST" && url.pathname === "/api/try-on") {
        return await createTryOn(request, env, cors);
      }
      const jobMatch = request.method === "GET"
        ? url.pathname.match(/^\/api\/try-on\/jobs\/(job_[a-f0-9]{32})$/)
        : null;
      if (jobMatch) return await getTryOnJob(jobMatch[1], env, cors);
      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "try_on_request_failed",
        requestId: request.headers.get("CF-Ray") || "unknown"
      }));
      return json({ error: "服务暂时不可用，请稍后再试" }, 500, cors);
    }
  }
} satisfies ExportedHandler<Env>;

export class TryOnWorkflow extends WorkflowEntrypoint<Env, TryOnWorkflowParams> {
  async run(event: WorkflowEvent<TryOnWorkflowParams>, step: WorkflowStep): Promise<TryOnWorkflowOutput> {
    const params = event.payload;
    try {
      const submitted = await step.do("submit Mob AI generation", {
        retries: { limit: 0, delay: "1 second", backoff: "constant" },
        timeout: "1 minute"
      }, async () => {
        const response = await mobPost(this.env, {
          model: MOB_AI_IMAGE_MODEL,
          mode: "async",
          input: { aspectRatio: "2:3", prompt: params.prompt, references: params.references }
        });
        const taskId = response.task?.id ?? response.result?.taskId;
        if (!taskId || taskId.length > 300) throw new Error("Mob AI submit response omitted task id");
        return { taskId };
      });

      for (let index = 0; index < MAX_WORKFLOW_POLLS; index += 1) {
        await step.sleep(`wait for generation ${index + 1}`, index < 30 ? "4 seconds" : "10 seconds");
        const response = await step.do(`check generation ${index + 1}`, {
          retries: { limit: 6, delay: "3 seconds", backoff: "exponential" },
          timeout: "1 minute"
        }, async () => mobPost(this.env, {
          model: MOB_AI_IMAGE_MODEL,
          mode: "async",
          input: { taskId: submitted.taskId }
        }));
        const status = normalizedMobStatus(response);
        if (PROCESSING_STATUSES.has(status)) continue;
        if (FAILED_STATUSES.has(status)) {
          await step.do("remove failed source images", async () => deleteTemporaryImages(this.env, params.storagePrefix, params.extensions));
          return { message: "这组图片暂时无法完成，请换一组更清晰的照片再试", status: "failed" };
        }
        if (!SUCCEEDED_STATUSES.has(status)) throw new Error(`Mob AI returned unknown status: ${status || "empty"}`);

        const outputUrl = response.output?.url ?? response.result?.imageUrl ?? response.result?.url ?? response.images?.[0]?.url;
        if (!outputUrl || new URL(outputUrl).protocol !== "https:") throw new Error("Mob AI completed without a valid image URL");
        const result = await step.do("store completed image", {
          retries: { limit: 4, delay: "3 seconds", backoff: "exponential" },
          timeout: "2 minutes"
        }, async () => storeCompletedImage(this.env, params.jobId, outputUrl));
        await step.do("remove completed source images", async () => deleteTemporaryImages(this.env, params.storagePrefix, params.extensions));
        return { ...result, status: "succeeded" };
      }

      await step.do("remove timed out source images", async () => deleteTemporaryImages(this.env, params.storagePrefix, params.extensions));
      return { message: "生成时间过长，请重新提交一次", status: "failed" };
    } catch (error) {
      await step.do("remove source images after error", async () => deleteTemporaryImages(this.env, params.storagePrefix, params.extensions));
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "try_on_workflow_failed",
        workflowId: event.instanceId
      }));
      return { message: "图像生成服务暂时不可用，请稍后再试", status: "failed" };
    }
  }
}

async function createTryOn(request: Request, env: Env, cors: Headers): Promise<Response> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.startsWith("multipart/form-data")) return json({ error: "请上传真人照和服装图片" }, 415, cors);
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_TOTAL_BYTES) return json({ error: "图片总大小不能超过 40 MB" }, 413, cors);

  const input = await request.formData();
  const person = input.get("person");
  const garments = input.getAll("garments");
  const consent = stringValue(input.get("consent"));
  const direction = stringValue(input.get("direction")).slice(0, 300);
  const qualityInput = stringValue(input.get("quality"));
  const quality = QUALITY_VALUES.has(qualityInput) ? qualityInput : "medium";

  if (consent !== "true") return json({ error: "请先确认已获得照片中人物的许可" }, 400, cors);
  if (!(person instanceof File)) return json({ error: "请先上传一张真人照片" }, 400, cors);
  if (!garments.length || garments.length > MAX_GARMENTS || garments.some((item) => !(item instanceof File))) {
    return json({ error: `请上传 1–${MAX_GARMENTS} 件衣服` }, 400, cors);
  }

  const imageFiles = [person, ...garments] as File[];
  let totalBytes = 0;
  for (const file of imageFiles) {
    if (!ACCEPTED_TYPES.has(file.type)) return json({ error: "图片仅支持 JPG、PNG 或 WEBP" }, 415, cors);
    if (file.size < 1 || file.size > MAX_FILE_BYTES) return json({ error: "单张图片不能超过 8 MB" }, 413, cors);
    totalBytes += file.size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) return json({ error: "图片总大小不能超过 40 MB" }, 413, cors);

  const rateKey = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateLimit = await env.TRY_ON_RATE_LIMITER.limit({ key: rateKey });
  if (!rateLimit.success) return json({ error: "生成得有点频繁，请一分钟后再试" }, 429, cors);

  const jobId = `job_${randomHex(16)}`;
  const storagePrefix = `${UPLOAD_PREFIX}/${randomHex(16)}`;
  const extensions = imageFiles.map((file) => imageExtension(file.type));
  let uploadedCount = 0;
  try {
    for (const [index, file] of imageFiles.entries()) {
      await putTemporaryImage(env, `${storagePrefix}/${index}.${extensions[index]}`, file);
      uploadedCount += 1;
    }
    const references = imageFiles.map((_, index) => ({
      type: "image" as const,
      url: `${trimTrailingSlash(env.R2_PUBLIC_BASE)}/${storagePrefix}/${index}.${extensions[index]}`
    }));
    await env.TRY_ON_WORKFLOW.create({
      id: jobId,
      params: {
        extensions,
        jobId,
        prompt: buildPrompt(garments.length, direction, quality),
        references,
        storagePrefix
      },
      retention: { errorRetention: "3 days", successRetention: "3 days" }
    });
    return json({ background: true, jobId, pollAfterMs: 5000, status: "processing" }, 202, cors);
  } catch (error) {
    if (uploadedCount > 0) await deleteTemporaryImages(env, storagePrefix, extensions.slice(0, uploadedCount));
    throw error;
  }
}

async function getTryOnJob(jobId: string, env: Env, cors: Headers): Promise<Response> {
  if (!JOB_PATTERN.test(jobId)) return json({ error: "生成任务无效或已过期" }, 400, cors);
  let workflowStatus: InstanceStatus;
  try {
    workflowStatus = await (await env.TRY_ON_WORKFLOW.get(jobId)).status();
  } catch {
    return json({ error: "生成任务无效或已过期" }, 404, cors);
  }
  if (["queued", "running", "waiting", "waitingForPause", "paused"].includes(workflowStatus.status)) {
    return json({ background: true, jobId, pollAfterMs: 5000, status: "processing" }, 202, cors);
  }
  if (workflowStatus.status !== "complete") {
    return json({ error: "后台任务未能完成，请重新提交" }, 502, cors);
  }
  const output = parseWorkflowOutput(workflowStatus.output);
  if (!output || output.status === "failed") {
    return json({ error: output?.message || "后台任务未能完成，请重新提交" }, 502, cors);
  }

  const stored = await getStoredImage(env, output.resultKey);
  if (!stored?.body) return json({ error: "结果已过期，请重新生成" }, 410, cors);
  const headers = new Headers(cors);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Disposition", 'inline; filename="lv-fitting.png"');
  headers.set("Content-Type", output.contentType);
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(stored.body, { status: 200, headers });
}

async function mobPost(env: Env, body: Record<string, unknown>): Promise<MobResponse> {
  const response = await fetch(MOB_AI_GENERATIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.MOB_AI_API_KEY}`, "Content-Type": "application/json", "User-Agent": "lv-virtual-try-on/1.0" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = await readMobError(response);
    console.error(JSON.stringify({ event: "mob_ai_image_failed", message: detail, status: response.status }));
    throw new Error(`Mob AI request failed: ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  const value = await response.json<unknown>();
  if (!value || typeof value !== "object") throw new Error("Mob AI returned malformed JSON");
  return value as MobResponse;
}

async function readMobError(response: Response): Promise<string> {
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > 64 * 1024) return "";
  try {
    const payload = await response.json<{ error?: string | { message?: string }; message?: string }>();
    const message = typeof payload.error === "string" ? payload.error : typeof payload.error?.message === "string" ? payload.error.message : typeof payload.message === "string" ? payload.message : "";
    return message.slice(0, 300);
  } catch {
    return "";
  }
}

function storageClient(env: Env): AwsClient {
  return new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
}

function storageUrl(env: Env, key: string): string {
  return `${trimTrailingSlash(env.R2_ENDPOINT)}/${encodeURIComponent(env.R2_BUCKET)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function putTemporaryImage(env: Env, key: string, file: File): Promise<void> {
  const response = await storageClient(env).fetch(storageUrl(env, key), {
    method: "PUT",
    headers: { "Cache-Control": "private, no-store", "Content-Type": file.type },
    body: file
  });
  if (!response.ok) throw new Error(`Temporary image upload failed: ${response.status}`);
}

async function storeCompletedImage(env: Env, jobId: string, outputUrl: string): Promise<{ contentType: string; resultKey: string }> {
  if (!JOB_PATTERN.test(jobId)) throw new Error("Invalid workflow job id");
  const output = await fetch(outputUrl, { redirect: "follow" });
  if (!output.ok) throw new Error(`Mob AI image download failed: ${output.status}`);
  const contentType = output.headers.get("Content-Type") || "image/png";
  if (!ACCEPTED_TYPES.has(contentType)) throw new Error("Mob AI output was not a supported image");
  const resultKey = `${RESULT_PREFIX}/${jobId}.${imageExtension(contentType)}`;
  const response = await storageClient(env).fetch(storageUrl(env, resultKey), {
    method: "PUT",
    headers: { "Cache-Control": "private, no-store", "Content-Type": contentType },
    body: await output.arrayBuffer()
  });
  if (!response.ok) throw new Error(`Completed image storage failed: ${response.status}`);
  return { contentType, resultKey };
}

async function getStoredImage(env: Env, key: string): Promise<Response | null> {
  if (!RESULT_KEY_PATTERN.test(key)) return null;
  const response = await storageClient(env).fetch(storageUrl(env, key));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Completed image read failed: ${response.status}`);
  return response;
}

async function deleteTemporaryImages(env: Env, prefix: string, extensions: string[]): Promise<void> {
  if (!STORAGE_PREFIX_PATTERN.test(prefix) || extensions.length < 1 || extensions.length > MAX_GARMENTS + 1 || extensions.some((extension) => !/^(?:jpg|png|webp)$/.test(extension))) return;
  await Promise.all(extensions.map(async (extension, index) => {
    try {
      const response = await storageClient(env).fetch(storageUrl(env, `${prefix}/${index}.${extension}`), { method: "DELETE" });
      if (!response.ok && response.status !== 404) console.error(JSON.stringify({ event: "temporary_image_delete_failed", status: response.status }));
    } catch (error) {
      console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), event: "temporary_image_delete_failed" }));
    }
  }));
}

function buildPrompt(garmentCount: number, direction: string, quality: string): string {
  const optionalDirection = direction ? `\nStyling direction from the user: ${direction}` : "";
  const detail = quality === "high" ? "Prioritize maximum textile and construction detail." : quality === "low" ? "Prioritize a clean, fast fashion preview." : "Use balanced editorial detail.";
  return `Create one photorealistic virtual try-on image. The FIRST reference image is the source person. The remaining ${garmentCount} reference image${garmentCount === 1 ? " is a garment" : "s are garments"} that must be worn together as one coherent outfit.

Preserve the source person's recognizable facial identity, hairstyle, skin tone, body proportions, pose, hands, camera angle, framing, and background. Change only the clothing needed for the outfit. Reproduce each referenced garment faithfully, including its silhouette, material, color, pattern, construction details, branding, and fit. Layer garments in a physically plausible order. Render natural drape, folds, occlusion, lighting, shadows, and contact with the body. Keep original shoes and accessories unless a supplied garment clearly replaces them. Do not add unrelated garments, accessories, text, logos, watermarks, extra people, or extra limbs. The result must look like a real fashion photograph, not a collage or illustration. ${detail}${optionalDirection}`;
}

type ImageReference = { type: "image"; url: string };
type TryOnWorkflowParams = { extensions: string[]; jobId: string; prompt: string; references: ImageReference[]; storagePrefix: string };
type TryOnWorkflowOutput =
  | { contentType: string; resultKey: string; status: "succeeded" }
  | { message: string; status: "failed" };
type MobResponse = {
  status?: string;
  task?: { id?: string; providerStatus?: string; status?: string };
  result?: { imageUrl?: string; status?: string; taskId?: string; url?: string };
  output?: { type?: string; url?: string };
  images?: Array<{ url?: string }>;
};

function normalizedMobStatus(response: MobResponse): string {
  const candidates = [response.status, response.task?.providerStatus, response.task?.status, response.result?.status];
  return candidates.find((value) => typeof value === "string" && (PROCESSING_STATUSES.has(value.toLowerCase()) || FAILED_STATUSES.has(value.toLowerCase()) || SUCCEEDED_STATUSES.has(value.toLowerCase())))?.toLowerCase() || "";
}

function parseWorkflowOutput(value: unknown): TryOnWorkflowOutput | null {
  if (!value || typeof value !== "object" || !("status" in value)) return null;
  const output = value as Partial<TryOnWorkflowOutput>;
  if (output.status === "failed" && typeof output.message === "string") return { message: output.message, status: "failed" };
  if (output.status === "succeeded" && typeof output.resultKey === "string" && RESULT_KEY_PATTERN.test(output.resultKey) && typeof output.contentType === "string" && ACCEPTED_TYPES.has(output.contentType)) {
    return { contentType: output.contentType, resultKey: output.resultKey, status: "succeeded" };
  }
  return null;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
}

function imageExtension(contentType: string): string {
  return contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function stringValue(value: string | File | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasRequiredConfiguration(env: Env): boolean {
  return Boolean(env.MOB_AI_API_KEY && env.TRY_ON_WORKFLOW && env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && env.R2_PUBLIC_BASE);
}

function corsFor(request: Request, env: Env): Headers | null {
  const origin = request.headers.get("Origin");
  const allowed = origin === env.ALLOWED_ORIGIN || (origin !== null && LOCAL_ORIGIN_PATTERN.test(origin));
  if (!origin || !allowed) return null;
  return new Headers({
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  });
}

function handleOptions(request: Request, env: Env): Response {
  const cors = corsFor(request, env);
  return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });
}

function json(body: Record<string, unknown>, status: number, extraHeaders?: Headers): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json;charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(body, { status, headers });
}
