const OPENAI_IMAGE_EDIT_URL = "https://api.openai.com/v1/images/edits";
const MAX_GARMENTS = 6;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const LOCAL_ORIGIN_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const QUALITY_VALUES = new Set(["low", "medium", "high"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return handleOptions(request, env);
    if (request.method === "GET" && url.pathname === "/") {
      return json({ model: "gpt-image-2", service: "lv-virtual-try-on", status: "ok" }, 200);
    }
    if (request.method !== "POST" || url.pathname !== "/api/try-on") {
      return json({ error: "Not found" }, 404);
    }

    const cors = corsFor(request, env);
    if (!cors) return json({ error: "Origin not allowed" }, 403);
    if (!env.OPENAI_API_KEY) return json({ error: "图像生成服务尚未配置" }, 503, cors);

    try {
      return await createTryOn(request, env, cors);
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

async function createTryOn(request: Request, env: Env, cors: Headers): Promise<Response> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.startsWith("multipart/form-data")) {
    return json({ error: "请上传真人照和服装图片" }, 415, cors);
  }

  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_TOTAL_BYTES) {
    return json({ error: "图片总大小不能超过 40 MB" }, 413, cors);
  }

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

  const openaiBody = new FormData();
  openaiBody.append("model", "gpt-image-2");
  openaiBody.append("prompt", buildPrompt(garments.length, direction));
  openaiBody.append("quality", quality);
  openaiBody.append("size", "1024x1536");
  openaiBody.append("output_format", "jpeg");
  openaiBody.append("output_compression", "90");
  imageFiles.forEach((file, index) => {
    openaiBody.append("image[]", file, index === 0 ? "person.jpg" : `garment-${index}.jpg`);
  });

  const response = await fetch(OPENAI_IMAGE_EDIT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: openaiBody
  });

  if (!response.ok) {
    const requestId = response.headers.get("x-request-id") || "unknown";
    const detail = await readBoundedJson(response);
    console.error(JSON.stringify({
      event: "openai_image_edit_failed",
      openaiRequestId: requestId,
      status: response.status,
      type: detail?.error?.type || "unknown"
    }));
    const message = response.status === 429
      ? "当前生成任务较多，请稍后再试"
      : response.status === 400
        ? "图片暂时无法处理，请换一组更清晰的照片"
        : "图像生成服务暂时不可用，请稍后再试";
    return json({ error: message }, response.status === 429 ? 429 : 502, cors);
  }

  const result = await response.json<OpenAIImageResponse>();
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) return json({ error: "图像生成服务没有返回图片" }, 502, cors);
  const imageBytes = decodeBase64(encoded);
  const headers = new Headers(cors);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Disposition", 'inline; filename="lv-fitting.jpg"');
  headers.set("Content-Type", "image/jpeg");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(imageBytes, { status: 200, headers });
}

function buildPrompt(garmentCount: number, direction: string): string {
  const optionalDirection = direction
    ? `\nStyling direction from the user: ${direction}`
    : "";
  return `Create one photorealistic virtual try-on image. The FIRST input image is the source person. The remaining ${garmentCount} image${garmentCount === 1 ? " is a garment reference" : "s are garment references"} that must be worn together as one coherent outfit.

Preserve the source person's recognizable facial identity, hairstyle, skin tone, body proportions, pose, hands, camera angle, framing, and background. Change only the clothing needed for the outfit. Reproduce each referenced garment faithfully, including its silhouette, material, color, pattern, construction details, branding, and fit. Layer the garments in a physically plausible order. Render natural drape, folds, occlusion, lighting, shadows, and contact with the body. Keep any original shoes or accessories unless a supplied garment clearly replaces them. Do not add unrelated garments, accessories, text, logos, watermarks, extra people, or extra limbs. The result should look like a real fashion photograph, not a collage or illustration.${optionalDirection}`;
}

function stringValue(value: string | File | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const output = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return buffer;
}

type OpenAIErrorResponse = { error?: { type?: string } };
type OpenAIImageResponse = { data?: Array<{ b64_json?: string }> };

async function readBoundedJson(response: Response): Promise<OpenAIErrorResponse | null> {
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > 64 * 1024) return null;
  try {
    return await response.json<OpenAIErrorResponse>();
  } catch {
    return null;
  }
}

function corsFor(request: Request, env: Env): Headers | null {
  const origin = request.headers.get("Origin");
  const allowed = origin === env.ALLOWED_ORIGIN || (origin !== null && LOCAL_ORIGIN_PATTERN.test(origin));
  if (!origin || !allowed) return null;
  return new Headers({
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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
