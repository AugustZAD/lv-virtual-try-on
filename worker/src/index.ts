import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";

const MOB_AI_GENERATIONS_URL = "https://ai.mob-ai.cn/api/v1/generations";
const MOB_AI_IMAGE_MODEL = "image-gpt";
const MAX_GARMENTS = 6;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_RESULT_BYTES = 20 * 1024 * 1024;
const MAX_POLLS_PER_RESULT = 140;
const MAX_LOOK_POLLS = 36;
const MAX_MANIFEST_BYTES = 8 * 1024;
const UPLOAD_PREFIX = "temporary/lv-virtual-try-on";
const RESULT_PREFIX = "temporary/lv-virtual-try-on-results";
const LOCAL_ORIGIN_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const JOB_PATTERN = /^job_[a-f0-9]{32}$/;
const STORAGE_PREFIX_PATTERN = /^temporary\/lv-virtual-try-on\/[a-f0-9]{32}$/;
const RESULT_KEY_PATTERN = /^temporary\/lv-virtual-try-on-results\/job_[a-f0-9]{32}(?:-[1-6])?\.(?:jpg|png|webp)$/;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MODE_VALUES = new Set(["layered", "separate"]);
const POSE_VALUES = new Set(["original", "studio", "reference"]);
const PROCESSING_STATUSES = new Set(["submitted", "queued", "pending", "processing", "running"]);
const FAILED_STATUSES = new Set(["failed", "error", "canceled", "cancelled"]);
const SUCCEEDED_STATUSES = new Set(["succeeded", "success", "completed", "complete"]);
const LOOK_FAILURE_REASONS = new Set(["gateway_auth", "gateway_error", "internal_error", "invalid_output", "provider_failed", "provider_timeout"]);
const LOOK_FAILURE_STAGES = new Set(["generation", "poll", "result", "submit", "workflow"]);
const TRUSTED_OUTPUT_HOSTS = new Set(["fc-gw-sh.oss-accelerate.aliyuncs.com"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return handleOptions(request, env);
    if (request.method === "GET" && url.pathname === "/") {
      return json({ background: "cloudflare-workflows", gateway: "mob-ai", model: MOB_AI_IMAGE_MODEL, service: "lv-virtual-try-on", status: "ok" }, 200);
    }

    const resultMatch = request.method === "GET"
      ? url.pathname.match(/^\/api\/try-on\/jobs\/(job_[a-f0-9]{32})\/results\/([1-6])$/)
      : null;
    const cors = corsFor(request, env);
    // A regular cross-origin <img> request may omit Origin. Result IDs are
    // unguessable and this route is read-only, so allow only that exact case.
    const directImageRequest = Boolean(resultMatch && !request.headers.has("Origin"));
    if (!cors && !directImageRequest) return json({ error: "Origin not allowed" }, 403);
    const responseHeaders = cors ?? new Headers();
    if (!hasRequiredConfiguration(env)) return json({ error: "图像生成服务尚未配置" }, 503, responseHeaders);

    try {
      if (request.method === "POST" && url.pathname === "/api/try-on") {
        return await createTryOn(request, env, responseHeaders);
      }
      if (resultMatch) return await getTryOnResult(resultMatch[1], Number(resultMatch[2]), env, responseHeaders);
      const jobMatch = request.method === "GET"
        ? url.pathname.match(/^\/api\/try-on\/jobs\/(job_[a-f0-9]{32})$/)
        : null;
      if (jobMatch) return await getTryOnJob(jobMatch[1], env, responseHeaders);
      return json({ error: "Not found" }, 404, responseHeaders);
    } catch (error) {
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "try_on_request_failed",
        requestId: request.headers.get("CF-Ray") || "unknown"
      }));
      return json({ error: "服务暂时不可用，请稍后再试" }, 500, responseHeaders);
    }
  }
} satisfies ExportedHandler<Env>;

export class TryOnWorkflow extends WorkflowEntrypoint<Env, TryOnWorkflowParams> {
  async run(event: WorkflowEvent<TryOnWorkflowParams>, step: WorkflowStep): Promise<TryOnWorkflowOutput> {
    const params = event.payload;
    try {
      const submitted: Array<{ taskId: string }> = [];
      for (const [requestIndex, generation] of params.generations.entries()) {
        submitted.push(await step.do(`submit Mob AI generation ${requestIndex + 1}`, {
          retries: { limit: 0, delay: "1 second", backoff: "constant" },
          timeout: "1 minute"
        }, async () => {
          const response = await mobPost(this.env, {
            model: MOB_AI_IMAGE_MODEL,
            mode: "async",
            input: { aspectRatio: "2:3", prompt: generation.prompt, references: generation.references }
          });
          const taskId = response.task?.id ?? response.result?.taskId;
          if (!taskId || taskId.length > 300) throw new Error("Mob AI submit response omitted task id");
          return { taskId };
        }));
      }

      const results: Array<StoredResult | undefined> = new Array(submitted.length);
      const finished = new Array(submitted.length).fill(false) as boolean[];
      let failedCount = 0;
      for (let pollIndex = 0; pollIndex < MAX_POLLS_PER_RESULT && finished.some((value) => !value); pollIndex += 1) {
        await step.sleep(`wait for generation round ${pollIndex + 1}`, pollIndex < 30 ? "4 seconds" : "10 seconds");
        for (const [resultIndex, submission] of submitted.entries()) {
          if (finished[resultIndex]) continue;
          const response = await step.do(`check generation ${resultIndex + 1}-${pollIndex + 1}`, {
            retries: { limit: 6, delay: "3 seconds", backoff: "exponential" },
            timeout: "1 minute"
          }, async () => mobPost(this.env, {
            model: MOB_AI_IMAGE_MODEL,
            mode: "async",
            input: { taskId: submission.taskId }
          }));
          const status = normalizedMobStatus(response);
          if (PROCESSING_STATUSES.has(status)) continue;
          if (FAILED_STATUSES.has(status)) {
            failedCount += 1;
            finished[resultIndex] = true;
            continue;
          }
          if (!SUCCEEDED_STATUSES.has(status)) throw new Error(`Mob AI returned unknown status: ${status || "empty"}`);

          const outputUrl = response.output?.url ?? response.result?.imageUrl ?? response.result?.url ?? response.images?.[0]?.url;
          if (!outputUrl || new URL(outputUrl).protocol !== "https:") throw new Error("Mob AI completed without a valid image URL");
          results[resultIndex] = await step.do(`store completed image ${resultIndex + 1}`, {
            retries: { limit: 4, delay: "3 seconds", backoff: "exponential" },
            timeout: "2 minutes"
          }, async () => storeCompletedImage(this.env, params.jobId, resultIndex + 1, outputUrl));
          finished[resultIndex] = true;
        }
      }
      failedCount += finished.filter((value) => !value).length;

      await step.do("remove completed source images", async () => deleteTemporaryImages(this.env, params.storagePrefix, params.extensions));
      const completedResults = results.filter((result): result is StoredResult => Boolean(result));
      if (!completedResults.length) {
        return { message: "这组图片暂时无法完成，请换一组更清晰的照片再试", status: "failed" };
      }
      return { failedCount, mode: params.mode, results: completedResults, status: "succeeded" };
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

export class TryOnBatchWorkflow extends WorkflowEntrypoint<Env, TryOnWorkflowParams> {
  async run(event: WorkflowEvent<TryOnWorkflowParams>, step: WorkflowStep): Promise<TryOnBatchWorkflowOutput> {
    const params = event.payload;
    const childIds = params.generations.map((_, index) => `${event.instanceId}-look-${index + 1}`);
    try {
      await step.do("start independent look workflows", {
        retries: { limit: 4, delay: "3 seconds", backoff: "exponential" },
        timeout: "1 minute"
      }, async () => {
        await this.env.TRY_ON_LOOK_WORKFLOW.createBatch(params.generations.map((generation, index) => ({
          id: childIds[index],
          params: { generation, jobId: params.jobId, resultIndex: index + 1 },
          retention: { errorRetention: "3 days", successRetention: "3 days" }
        })));
        return { childIds };
      });

      // Child workflows own generation. The HTTP status endpoint aggregates their
      // outputs directly; this parent only keeps source references alive long enough
      // for queued children, then performs privacy cleanup.
      await step.sleep("keep source images available for child workflows", "20 minutes");
      await step.do("remove source images after child window", {
        retries: { limit: 4, delay: "3 seconds", backoff: "exponential" },
        timeout: "2 minutes"
      }, async () => deleteTemporaryImages(this.env, params.storagePrefix, params.extensions));
      console.log(JSON.stringify({
        event: "try_on_batch_delegated",
        childCount: childIds.length,
        workflowId: event.instanceId
      }));
      return { childCount: childIds.length, status: "delegated" };
    } catch (error) {
      // Already-started child workflows may still need the references. The bucket lifecycle
      // policy remains the cleanup fallback if batch orchestration is interrupted.
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "try_on_batch_failed",
        workflowId: event.instanceId
      }));
      return { message: "后台任务暂时中断，请稍后重新提交", status: "failed" };
    }
  }
}

export class TryOnLookWorkflow extends WorkflowEntrypoint<Env, TryOnLookWorkflowParams> {
  async run(event: WorkflowEvent<TryOnLookWorkflowParams>, step: WorkflowStep): Promise<TryOnLookWorkflowOutput> {
    const { generation, jobId, resultIndex } = event.payload;
    try {
      // Do not retry submission: an ambiguous network failure must not create a duplicate paid task.
      const submission = await step.do("submit Mob AI generation", {
        retries: { limit: 0, delay: "1 second", backoff: "constant" },
        timeout: "1 minute"
      }, async (): Promise<MobSubmitResult> => {
        try {
          const response = await mobPost(this.env, {
            model: MOB_AI_IMAGE_MODEL,
            mode: "async",
            input: { aspectRatio: "2:3", prompt: generation.prompt, references: generation.references }
          });
          const taskId = response.task?.id ?? response.result?.taskId;
          if (!taskId || taskId.length > 300) throw new Error("Mob AI submit response omitted task id");
          return { kind: "submitted", taskId };
        } catch (error) {
          if (error instanceof MobRequestError) return { kind: "failed", upstreamMessage: error.detail, upstreamStatus: error.status };
          throw error;
        }
      });
      if (submission.kind === "failed") return lookFailure("gateway_error", event.instanceId, resultIndex, "submit", submission.upstreamStatus, submission.upstreamMessage);

      for (let pollIndex = 0; pollIndex < MAX_LOOK_POLLS; pollIndex += 1) {
        await step.sleep(`wait for Mob AI round ${pollIndex + 1}`, lookPollDelay(pollIndex));
        const check = await step.do(`check Mob AI generation ${pollIndex + 1}`, {
          retries: { limit: 0, delay: "1 second", backoff: "constant" },
          timeout: "1 minute"
        }, async (): Promise<MobPollResult> => {
          try {
            return { kind: "response", response: await mobPost(this.env, {
              model: MOB_AI_IMAGE_MODEL,
              mode: "async",
              input: { taskId: submission.taskId }
            }) };
          } catch (error) {
            const status = error instanceof MobRequestError ? error.status : 0;
            return {
              kind: "failed",
              reason: status === 401 || status === 403 ? "gateway_auth" : "gateway_error",
              upstreamMessage: error instanceof MobRequestError ? error.detail : "Mob AI status check failed",
              upstreamStatus: status || undefined
            };
          }
        });
        if (check.kind === "failed") return lookFailure(check.reason, event.instanceId, resultIndex, "poll", check.upstreamStatus, check.upstreamMessage);

        const response = check.response;
        const status = normalizedMobStatus(response);
        const outputUrl = mobOutputUrl(response);
        if (PROCESSING_STATUSES.has(status) || (!status && !outputUrl)) continue;
        if (FAILED_STATUSES.has(status)) return lookFailure("provider_failed", event.instanceId, resultIndex, "generation");
        if (!SUCCEEDED_STATUSES.has(status) && !outputUrl) continue;
        if (!outputUrl || !isSafeHttpsUrl(outputUrl)) return lookFailure("invalid_output", event.instanceId, resultIndex, "result");

        const result = await step.do("store completed image", {
          retries: { limit: 2, delay: "3 seconds", backoff: "exponential" },
          timeout: "2 minutes"
        }, async () => storeCompletedImage(this.env, jobId, resultIndex, outputUrl));
        console.log(JSON.stringify({ event: "try_on_look_completed", resultIndex, workflowId: event.instanceId }));
        return { result, status: "succeeded" };
      }
      return lookFailure("provider_timeout", event.instanceId, resultIndex, "poll");
    } catch (error) {
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "try_on_look_failed",
        resultIndex,
        workflowId: event.instanceId
      }));
      return lookFailure("internal_error", event.instanceId, resultIndex, "workflow");
    }
  }
}

async function createTryOn(request: Request, env: Env, cors: Headers): Promise<Response> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.startsWith("multipart/form-data")) return json({ error: "请上传真人照和服装图片" }, 415, cors);
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_TOTAL_BYTES) return json({ error: "图片总大小不能超过 40 MB" }, 413, cors);

  const requestedJobId = (request.headers.get("X-Job-Id") || "").trim();
  if (requestedJobId && !JOB_PATTERN.test(requestedJobId)) return json({ error: "任务编号无效，请刷新页面后再试" }, 400, cors);
  const jobId = requestedJobId || `job_${randomHex(16)}`;
  if (requestedJobId && await workflowExists(env.TRY_ON_BATCH_WORKFLOW, jobId)) {
    return json({ background: true, jobId, pollAfterMs: 1500, status: "processing" }, 202, cors);
  }

  const rateKey = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateLimit = await env.TRY_ON_RATE_LIMITER.limit({ key: rateKey });
  if (!rateLimit.success) return json({ error: "生成得有点频繁，请一分钟后再试" }, 429, cors);

  const input = await request.formData();
  const person = input.get("person");
  const garments = input.getAll("garments");
  const poseReference = input.get("poseReference");
  const consent = stringValue(input.get("consent"));
  const direction = stringValue(input.get("direction")).slice(0, 300);
  const modeInput = stringValue(input.get("mode"));
  const mode: TryOnMode = MODE_VALUES.has(modeInput) ? modeInput as TryOnMode : "separate";
  const poseInput = stringValue(input.get("poseMode"));
  const poseMode: PoseMode = POSE_VALUES.has(poseInput) ? poseInput as PoseMode : "original";
  const formJobId = stringValue(input.get("jobId"));

  if (consent !== "true") return json({ error: "请先确认已获得照片中人物的许可" }, 400, cors);
  if (!(person instanceof File)) return json({ error: "请先上传一张真人照片" }, 400, cors);
  if (!garments.length || garments.length > MAX_GARMENTS || garments.some((item) => !(item instanceof File))) {
    return json({ error: `请上传 1–${MAX_GARMENTS} 件衣服` }, 400, cors);
  }
  if (poseMode === "reference" && !(poseReference instanceof File)) return json({ error: "请上传姿势参考图" }, 400, cors);

  const garmentFiles = garments as File[];
  const poseFile = poseMode === "reference" ? poseReference as File : null;
  const imageFiles = [person, ...garmentFiles, ...(poseFile ? [poseFile] : [])];
  let totalBytes = 0;
  for (const file of imageFiles) {
    if (!ACCEPTED_TYPES.has(file.type)) return json({ error: "图片仅支持 JPG、PNG 或 WEBP" }, 415, cors);
    if (file.size < 1 || file.size > MAX_FILE_BYTES) return json({ error: "单张图片不能超过 8 MB" }, 413, cors);
    if (!await hasValidImageSignature(file)) return json({ error: "有图片内容损坏或格式不正确，请重新选择" }, 415, cors);
    totalBytes += file.size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) return json({ error: "图片总大小不能超过 40 MB" }, 413, cors);
  if (formJobId && formJobId !== jobId) return json({ error: "任务编号不一致，请刷新页面后再试" }, 400, cors);

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
    const poseReferenceItem = poseMode === "reference" ? references[garmentFiles.length + 1] : null;
    const generations: GenerationRequest[] = mode === "separate"
      ? garmentFiles.map((_, index) => ({
          prompt: buildSeparatePrompt(index + 1, garmentFiles.length, direction, poseMode),
          references: [references[0], references[index + 1], ...(poseReferenceItem ? [poseReferenceItem] : [])]
        }))
      : [{ prompt: buildLayeredPrompt(garmentFiles.length, direction, poseMode), references }];
    await putJobManifest(env, jobId, { childCount: generations.length, mode, version: 2 });
    await env.TRY_ON_BATCH_WORKFLOW.create({
      id: jobId,
      params: {
        extensions,
        jobId,
        generations,
        mode,
        storagePrefix
      },
      retention: { errorRetention: "3 days", successRetention: "3 days" }
    });
    return json({ background: true, jobId, pollAfterMs: 5000, status: "processing" }, 202, cors);
  } catch (error) {
    // A create response can be lost after Cloudflare accepted the workflow. Preserve
    // its inputs and return the same job instead of risking a duplicate paid submit.
    if (await workflowExists(env.TRY_ON_BATCH_WORKFLOW, jobId)) {
      return json({ background: true, jobId, pollAfterMs: 5000, status: "processing" }, 202, cors);
    }
    if (uploadedCount > 0) await deleteTemporaryImages(env, storagePrefix, extensions.slice(0, uploadedCount));
    await deleteJobManifest(env, jobId);
    throw error;
  }
}

async function getTryOnJob(jobId: string, env: Env, cors: Headers): Promise<Response> {
  if (!JOB_PATTERN.test(jobId)) return json({ error: "生成任务无效或已过期" }, 400, cors);
  const childJob = await getChildJobStatus(env, jobId);
  if (childJob.state === "processing") {
    return json({ background: true, errors: childJob.errors ?? [], jobId, pollAfterMs: 5000, status: "processing" }, 202, cors);
  }
  if (childJob.state === "failed") return json({ error: childJob.message, errors: childJob.errors ?? [] }, 502, cors);
  if (childJob.state === "succeeded") return jobSucceededResponse(jobId, childJob.output, cors);

  let workflowStatus: InstanceStatus;
  try {
    workflowStatus = await getJobWorkflowStatus(env, jobId);
  } catch {
    return json({ error: "生成任务无效或已过期" }, 404, cors);
  }
  if (workflowStatus.status === "unknown") return json({ error: "生成任务无效或已过期" }, 404, cors);
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

  return jobSucceededResponse(jobId, output, cors);
}

async function getTryOnResult(jobId: string, resultIndex: number, env: Env, cors: Headers): Promise<Response> {
  if (!JOB_PATTERN.test(jobId)) return json({ error: "生成任务无效或已过期" }, 400, cors);
  const childJob = await getChildJobStatus(env, jobId);
  if (childJob.state === "processing") return json({ error: "结果尚未生成" }, 409, cors);
  if (childJob.state === "failed") return json({ error: childJob.message, errors: childJob.errors ?? [] }, 502, cors);
  if (childJob.state === "succeeded") return storedResultResponse(childJob.output.results[resultIndex - 1], env, cors);

  let workflowStatus: InstanceStatus;
  try {
    workflowStatus = await getJobWorkflowStatus(env, jobId);
  } catch {
    return json({ error: "生成任务无效或已过期" }, 404, cors);
  }
  if (workflowStatus.status === "unknown") return json({ error: "生成任务无效或已过期" }, 404, cors);
  if (workflowStatus.status !== "complete") return json({ error: "结果尚未生成" }, 409, cors);
  const output = parseWorkflowOutput(workflowStatus.output);
  if (!output || output.status === "failed") return json({ error: output?.message || "后台任务未能完成，请重新提交" }, 502, cors);
  return storedResultResponse(output.results[resultIndex - 1], env, cors);
}

function jobSucceededResponse(jobId: string, output: SucceededTryOnOutput, cors: Headers): Response {
  return json({
    failedCount: output.failedCount,
    errors: output.errors ?? [],
    mode: output.mode,
    resultCount: output.results.length,
    results: output.results.map((_, index) => ({ url: `/api/try-on/jobs/${jobId}/results/${index + 1}` })),
    status: "succeeded"
  }, 200, cors);
}

async function storedResultResponse(result: StoredResult | undefined, env: Env, cors: Headers): Promise<Response> {
  if (!result) return json({ error: "试穿结果不存在" }, 404, cors);
  const stored = await getStoredImage(env, result.resultKey);
  if (!stored?.body) return json({ error: "结果已过期，请重新生成" }, 410, cors);
  const headers = new Headers(cors);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Disposition", 'inline; filename="lv-fitting.png"');
  headers.set("Content-Type", result.contentType);
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
    throw new MobRequestError(response.status, detail);
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

async function putJobManifest(env: Env, jobId: string, manifest: JobManifest): Promise<void> {
  if (!JOB_PATTERN.test(jobId)) throw new Error("Invalid workflow job id");
  const response = await storageClient(env).fetch(storageUrl(env, manifestKey(jobId)), {
    method: "PUT",
    headers: { "Cache-Control": "private, no-store", "Content-Type": "application/json" },
    body: JSON.stringify(manifest)
  });
  if (!response.ok) throw new Error(`Job manifest upload failed: ${response.status}`);
}

async function getJobManifest(env: Env, jobId: string): Promise<JobManifest | null> {
  const response = await storageClient(env).fetch(storageUrl(env, manifestKey(jobId)));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Job manifest read failed: ${response.status}`);
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_MANIFEST_BYTES) throw new Error("Job manifest exceeded the size limit");
  const value = await response.json<unknown>();
  if (!value || typeof value !== "object") throw new Error("Job manifest was malformed");
  const manifest = value as Partial<JobManifest>;
  if (manifest.version !== 2 || !Number.isInteger(manifest.childCount) || Number(manifest.childCount) < 1 || Number(manifest.childCount) > MAX_GARMENTS || !MODE_VALUES.has(String(manifest.mode))) {
    throw new Error("Job manifest was invalid");
  }
  return { childCount: Number(manifest.childCount), mode: manifest.mode as TryOnMode, version: 2 };
}

async function deleteJobManifest(env: Env, jobId: string): Promise<void> {
  try {
    const response = await storageClient(env).fetch(storageUrl(env, manifestKey(jobId)), { method: "DELETE" });
    if (!response.ok && response.status !== 404) console.error(JSON.stringify({ event: "job_manifest_delete_failed", status: response.status }));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), event: "job_manifest_delete_failed" }));
  }
}

function manifestKey(jobId: string): string {
  return `${RESULT_PREFIX}/${jobId}.json`;
}

async function storeCompletedImage(env: Env, jobId: string, resultIndex: number, outputUrl: string): Promise<StoredResult> {
  if (!JOB_PATTERN.test(jobId)) throw new Error("Invalid workflow job id");
  const output = await fetchTrustedImage(outputUrl);
  if (!output.ok) throw new Error(`Mob AI image download failed: ${output.status}`);
  const outputLength = Number(output.headers.get("Content-Length"));
  if (Number.isFinite(outputLength) && outputLength > MAX_RESULT_BYTES) throw new Error("Mob AI output exceeded the size limit");
  const contentType = (output.headers.get("Content-Type") || "image/png").split(";", 1)[0].trim().toLowerCase();
  if (!ACCEPTED_TYPES.has(contentType)) throw new Error("Mob AI output was not a supported image");
  const outputBytes = await readBodyWithLimit(output, MAX_RESULT_BYTES);
  const resultKey = `${RESULT_PREFIX}/${jobId}-${resultIndex}.${imageExtension(contentType)}`;
  const response = await storageClient(env).fetch(storageUrl(env, resultKey), {
    method: "PUT",
    headers: { "Cache-Control": "private, no-store", "Content-Type": contentType },
    body: outputBytes
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
  if (!STORAGE_PREFIX_PATTERN.test(prefix) || extensions.length < 1 || extensions.length > MAX_GARMENTS + 2 || extensions.some((extension) => !/^(?:jpg|png|webp)$/.test(extension))) return;
  for (const [index, extension] of extensions.entries()) {
    try {
      const response = await storageClient(env).fetch(storageUrl(env, `${prefix}/${index}.${extension}`), { method: "DELETE" });
      if (!response.ok && response.status !== 404) console.error(JSON.stringify({ event: "temporary_image_delete_failed", status: response.status }));
    } catch (error) {
      console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), event: "temporary_image_delete_failed" }));
    }
  }
}

function buildLayeredPrompt(garmentCount: number, direction: string, poseMode: PoseMode): string {
  const optionalDirection = direction ? `\nStyling direction from the user: ${direction}` : "";
  const poseReference = poseMode === "reference" ? ` Reference image ${garmentCount + 2} is a pose guide only.` : "";
  return `Create one photorealistic virtual try-on image. The FIRST reference image is the source person. The next ${garmentCount} reference image${garmentCount === 1 ? " is a garment" : "s are garments"} that must be worn together as one coherent outfit.${poseReference}

Preserve the source person's recognizable facial identity, hairstyle, skin tone, and body proportions. ${poseInstruction(poseMode, garmentCount + 2)} Change only the clothing needed for the outfit. Reproduce each referenced garment faithfully, including its silhouette, material, color, pattern, construction details, branding, and fit. Layer garments in a physically plausible order. Render maximum textile and construction detail with natural drape, folds, occlusion, lighting, shadows, and contact with the body. Keep original shoes and accessories unless a supplied garment clearly replaces them. Do not add unrelated garments, accessories, text, logos, watermarks, extra people, or extra limbs. The result must look like a real fashion photograph, not a collage or illustration.${optionalDirection}`;
}

function buildSeparatePrompt(pieceIndex: number, garmentCount: number, direction: string, poseMode: PoseMode): string {
  const optionalDirection = direction ? `\nStyling direction from the user: ${direction}` : "";
  const poseReference = poseMode === "reference" ? " The THIRD reference image is a pose guide only." : "";
  return `Create one photorealistic virtual try-on image for look ${pieceIndex} of ${garmentCount}. The FIRST reference image is the source person. The SECOND reference image is the only supplied garment to add to this look.${poseReference}

Preserve the source person's recognizable facial identity, hairstyle, skin tone, and body proportions. ${poseInstruction(poseMode, 3)} Change only the clothing area needed to wear the single supplied garment. Do not combine it with garments from any other look. Reproduce the supplied garment faithfully, including its silhouette, material, color, pattern, construction details, branding, and fit. Keep all compatible original clothing, shoes, and accessories unchanged. Render maximum textile and construction detail with natural drape, folds, occlusion, lighting, shadows, and contact with the body. Do not add unrelated garments, accessories, text, logos, watermarks, extra people, or extra limbs. The result must look like a real fashion photograph, not a collage or illustration.${optionalDirection}`;
}

function poseInstruction(mode: PoseMode, referenceNumber: number): string {
  if (mode === "studio") return "Re-pose the person into a neutral front-facing fashion studio stance: balanced weight, relaxed shoulders, arms slightly away from the torso, and visible natural hands. Keep the original camera perspective, framing, lighting, and background as close as possible.";
  if (mode === "reference") return `Match the body pose and limb placement from reference image ${referenceNumber}, but ignore that reference's identity, face, hair, body shape, clothing, background, and lighting. Apply only its pose to the source person while retaining the source person's identity and proportions.`;
  return "Preserve the source person's original pose, hand placement, camera angle, framing, and background as exactly as possible.";
}

type ImageReference = { type: "image"; url: string };
type GenerationRequest = { prompt: string; references: ImageReference[] };
type StoredResult = { contentType: string; resultKey: string };
type TryOnMode = "layered" | "separate";
type PoseMode = "original" | "studio" | "reference";
type TryOnWorkflowParams = { extensions: string[]; generations: GenerationRequest[]; jobId: string; mode: TryOnMode; storagePrefix: string };
type TryOnLookWorkflowParams = { generation: GenerationRequest; jobId: string; resultIndex: number };
type SucceededTryOnOutput = { errors?: TryOnFailure[]; failedCount: number; mode: TryOnMode; results: StoredResult[]; status: "succeeded" };
type TryOnWorkflowOutput =
  | SucceededTryOnOutput
  | { message: string; status: "failed" };
type TryOnBatchWorkflowOutput =
  | { childCount: number; status: "delegated" }
  | { message: string; status: "failed" };
type TryOnLookWorkflowOutput =
  | { result: StoredResult; status: "succeeded" }
  | { reason: LookFailureReason; stage: LookFailureStage; status: "failed"; upstreamMessage?: string; upstreamStatus?: number };
type JobManifest = { childCount: number; mode: TryOnMode; version: 2 };
type ChildJobStatus =
  | { state: "not_found" }
  | { errors?: TryOnFailure[]; state: "processing" }
  | { errors?: TryOnFailure[]; message: string; state: "failed" }
  | { output: SucceededTryOnOutput; state: "succeeded" };
type LookFailureReason = "gateway_auth" | "gateway_error" | "internal_error" | "invalid_output" | "provider_failed" | "provider_timeout";
type LookFailureStage = "generation" | "poll" | "result" | "submit" | "workflow";
type TryOnFailure = { look: number; message: string; reason: LookFailureReason; stage: LookFailureStage; upstreamMessage?: string; upstreamStatus?: number };
type MobSubmitResult =
  | { kind: "submitted"; taskId: string }
  | { kind: "failed"; upstreamMessage?: string; upstreamStatus: number };
type MobPollResult =
  | { kind: "response"; response: MobResponse }
  | { kind: "failed"; reason: "gateway_auth" | "gateway_error"; upstreamMessage?: string; upstreamStatus?: number };
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

class MobRequestError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`Mob AI request failed: ${status}${detail ? ` ${detail}` : ""}`);
    this.name = "MobRequestError";
  }
}

function mobOutputUrl(response: MobResponse): string {
  return response.output?.url ?? response.result?.imageUrl ?? response.result?.url ?? response.images?.[0]?.url ?? "";
}

function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && (url.hostname === "mob-ai.cn" || url.hostname.endsWith(".mob-ai.cn") || TRUSTED_OUTPUT_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

async function fetchTrustedImage(value: string): Promise<Response> {
  let current = value;
  for (let redirects = 0; redirects <= 2; redirects += 1) {
    if (!isSafeHttpsUrl(current)) throw new Error("Mob AI output used an untrusted URL");
    const response = await fetch(current, { redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("Location");
    if (!location || redirects === 2) throw new Error("Mob AI output redirected too many times");
    current = new URL(location, current).toString();
  }
  throw new Error("Mob AI output redirect failed");
}

async function readBodyWithLimit(response: Response, limit: number): Promise<ArrayBuffer> {
  if (!response.body) throw new Error("Mob AI output omitted the image body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel("output too large");
      throw new Error("Mob AI output exceeded the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function hasValidImageSignature(file: File): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (file.type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.type === "image/png") return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
}

function lookPollDelay(pollIndex: number): "5 seconds" | "10 seconds" | "25 seconds" {
  if (pollIndex < 6) return "5 seconds";
  if (pollIndex < 18) return "10 seconds";
  return "25 seconds";
}

function lookFailure(reason: LookFailureReason, workflowId: string, resultIndex: number, stage: LookFailureStage, upstreamStatus?: number, upstreamMessage?: string): TryOnLookWorkflowOutput {
  const safeMessage = typeof upstreamMessage === "string" ? upstreamMessage.trim().slice(0, 300) : "";
  console.error(JSON.stringify({ event: "try_on_look_failed", reason, resultIndex, stage, upstreamMessage: safeMessage || undefined, upstreamStatus, workflowId }));
  return { reason, stage, status: "failed", ...(safeMessage ? { upstreamMessage: safeMessage } : {}), ...(upstreamStatus ? { upstreamStatus } : {}) };
}

function parseLookWorkflowOutput(value: unknown): TryOnLookWorkflowOutput | null {
  if (!value || typeof value !== "object" || !("status" in value)) return null;
  const output = value as Partial<TryOnLookWorkflowOutput>;
  if (output.status === "failed" && typeof output.reason === "string" && LOOK_FAILURE_REASONS.has(output.reason)) {
    const stage = typeof output.stage === "string" && LOOK_FAILURE_STAGES.has(output.stage) ? output.stage as LookFailureStage : "workflow";
    const upstreamStatus = Number.isInteger(output.upstreamStatus) && Number(output.upstreamStatus) >= 400 && Number(output.upstreamStatus) <= 599 ? Number(output.upstreamStatus) : undefined;
    const upstreamMessage = typeof output.upstreamMessage === "string" ? output.upstreamMessage.trim().slice(0, 300) : "";
    return { reason: output.reason as LookFailureReason, stage, status: "failed", ...(upstreamMessage ? { upstreamMessage } : {}), ...(upstreamStatus ? { upstreamStatus } : {}) };
  }
  if (output.status === "succeeded" && output.result && typeof output.result.resultKey === "string" && RESULT_KEY_PATTERN.test(output.result.resultKey) && typeof output.result.contentType === "string" && ACCEPTED_TYPES.has(output.result.contentType)) {
    return { result: output.result, status: "succeeded" };
  }
  return null;
}

async function getChildJobStatus(env: Env, jobId: string): Promise<ChildJobStatus> {
  const manifest = await getJobManifest(env, jobId);
  const expectedCount = manifest?.childCount ?? MAX_GARMENTS;
  const observed: InstanceStatus[] = [];

  for (let index = 1; index <= expectedCount; index += 1) {
    try {
      const status = await (await env.TRY_ON_LOOK_WORKFLOW.get(`${jobId}-look-${index}`)).status();
      if (status.status === "unknown") {
        if (manifest) return getBatchFailureOrProcessing(env, jobId);
        break;
      }
      observed.push(status);
    } catch {
      if (manifest) return getBatchFailureOrProcessing(env, jobId);
      break;
    }
  }

  if (!observed.length) return { state: "not_found" };
  if (manifest && observed.length !== manifest.childCount) return { state: "processing" };

  const results: StoredResult[] = [];
  const errors: TryOnFailure[] = [];
  let failedCount = 0;
  let stillProcessing = false;
  for (const [index, status] of observed.entries()) {
    if (["queued", "running", "waiting", "waitingForPause", "paused"].includes(status.status)) {
      stillProcessing = true;
      continue;
    }
    if (status.status !== "complete") {
      failedCount += 1;
      errors.push(publicLookFailure(index + 1, { reason: "internal_error", stage: "workflow", status: "failed" }));
      continue;
    }
    const output = parseLookWorkflowOutput(status.output);
    if (!output || output.status === "failed") {
      failedCount += 1;
      errors.push(publicLookFailure(index + 1, output?.status === "failed" ? output : { reason: "internal_error", stage: "workflow", status: "failed" }));
      continue;
    }
    results.push(output.result);
  }

  if (stillProcessing) return { errors, state: "processing" };
  if (!results.length) return { errors, message: errors.map((error) => error.message).join(" ") || "The background task failed before producing a result.", state: "failed" };
  return {
    output: {
      errors,
      failedCount,
      mode: manifest?.mode ?? (observed.length > 1 ? "separate" : "layered"),
      results,
      status: "succeeded"
    },
    state: "succeeded"
  };
}

function publicLookFailure(look: number, output: Extract<TryOnLookWorkflowOutput, { status: "failed" }>): TryOnFailure {
  const status = output.upstreamStatus ? ` HTTP ${output.upstreamStatus}.` : "";
  const detail = output.upstreamMessage ? ` Mob AI: ${output.upstreamMessage}` : "";
  const messages: Record<LookFailureReason, string> = {
    gateway_auth: `Look ${look}: Mob AI authentication failed during ${output.stage}.${status}${detail}`,
    gateway_error: output.stage === "submit"
      ? `Look ${look}: Mob AI submission failed.${status}${detail} Generation did not start.`
      : `Look ${look}: Mob AI status check failed.${status}${detail}`,
    internal_error: `Look ${look}: The background workflow failed before a result was saved.`,
    invalid_output: `Look ${look}: Mob AI returned an invalid image result.`,
    provider_failed: `Look ${look}: Mob AI reported that generation failed.`,
    provider_timeout: `Look ${look}: Mob AI did not finish before the status window ended.${status}`
  };
  return { look, message: messages[output.reason], reason: output.reason, stage: output.stage, ...(output.upstreamMessage ? { upstreamMessage: output.upstreamMessage } : {}), ...(output.upstreamStatus ? { upstreamStatus: output.upstreamStatus } : {}) };
}

async function getBatchFailureOrProcessing(env: Env, jobId: string): Promise<ChildJobStatus> {
  try {
    const status = await (await env.TRY_ON_BATCH_WORKFLOW.get(jobId)).status();
    if (["queued", "running", "waiting", "waitingForPause", "paused", "unknown"].includes(status.status)) return { state: "processing" };
    if (status.status === "complete") {
      const output = status.output as Partial<TryOnBatchWorkflowOutput> | null;
      if (output?.status === "failed" && typeof output.message === "string") return { message: output.message, state: "failed" };
    }
  } catch {
    return { state: "processing" };
  }
  return { message: "后台任务未能启动，请重新提交", state: "failed" };
}

async function workflowExists(workflow: Workflow, jobId: string): Promise<boolean> {
  try {
    const status = await (await workflow.get(jobId)).status();
    return status.status !== "unknown";
  } catch {
    return false;
  }
}

async function getJobWorkflowStatus(env: Env, jobId: string): Promise<InstanceStatus> {
  try {
    const current = await (await env.TRY_ON_BATCH_WORKFLOW.get(jobId)).status();
    if (current.status !== "unknown") return current;
  } catch {}
  return (await env.TRY_ON_WORKFLOW.get(jobId)).status();
}

function parseWorkflowOutput(value: unknown): TryOnWorkflowOutput | null {
  if (!value || typeof value !== "object" || !("status" in value)) return null;
  const output = value as Partial<TryOnWorkflowOutput>;
  if (output.status === "failed" && typeof output.message === "string") return { message: output.message, status: "failed" };
  const legacy = value as { contentType?: unknown; resultKey?: unknown; status?: unknown };
  if (legacy.status === "succeeded" && typeof legacy.resultKey === "string" && RESULT_KEY_PATTERN.test(legacy.resultKey) && typeof legacy.contentType === "string" && ACCEPTED_TYPES.has(legacy.contentType)) {
    return { failedCount: 0, mode: "layered", results: [{ contentType: legacy.contentType, resultKey: legacy.resultKey }], status: "succeeded" };
  }
  if (output.status === "succeeded" && Array.isArray(output.results) && output.results.length >= 1 && output.results.length <= MAX_GARMENTS) {
    const results = output.results.filter((result): result is StoredResult => Boolean(result && typeof result.resultKey === "string" && RESULT_KEY_PATTERN.test(result.resultKey) && typeof result.contentType === "string" && ACCEPTED_TYPES.has(result.contentType)));
    if (results.length !== output.results.length) return null;
    return {
      failedCount: Number.isInteger(output.failedCount) && Number(output.failedCount) >= 0 && Number(output.failedCount) <= MAX_GARMENTS ? Number(output.failedCount) : 0,
      mode: output.mode === "separate" ? "separate" : "layered",
      results,
      status: "succeeded"
    };
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
  return Boolean(env.MOB_AI_API_KEY && env.TRY_ON_WORKFLOW && env.TRY_ON_BATCH_WORKFLOW && env.TRY_ON_LOOK_WORKFLOW && env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && env.R2_PUBLIC_BASE);
}

function corsFor(request: Request, env: Env): Headers | null {
  const origin = request.headers.get("Origin");
  const allowed = origin === env.ALLOWED_ORIGIN || (origin !== null && LOCAL_ORIGIN_PATTERN.test(origin));
  if (!origin || !allowed) return null;
  return new Headers({
    "Access-Control-Allow-Headers": "Content-Type, X-Job-Id",
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
