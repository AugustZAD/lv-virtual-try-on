const ORIGIN = "https://api.pruna.ai";
export type PrunaResponse = { id?: string; status?: string; generation_url?: string; error?: string; message?: string };
export type PrunaInput = { person_image: string; garment_images: string[]; prompt: string; reference_pose?: string; turbo: false; preserve_input_size: true; output_format: "jpg"; output_quality: 95 };
export class PrunaError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) { super(`Pruna HTTP ${status}: ${detail}`); this.name = "PrunaError"; this.status = status; this.detail = detail; }
}
// Never send the credential to an arbitrary returned URL or follow redirects with it.
export function trustedPrunaUrl(value: string): boolean {
  try { const url = new URL(value); return url.origin === ORIGIN && !url.username && !url.password && url.pathname.startsWith("/v1/predictions/delivery/"); }
  catch { return false; }
}
export function prunaInput(references: Array<{ url: string }>, prompt: string, hasPose: boolean): PrunaInput {
  return { person_image: references[0].url, garment_images: references.slice(1, hasPose ? -1 : undefined).map(image => image.url), ...(hasPose ? { reference_pose: references[references.length - 1].url } : {}), prompt, turbo: false, preserve_input_size: true, output_format: "jpg", output_quality: 95 };
}
export function prunaDetail(value: PrunaResponse, key: string): string {
  const message = value.error || value.message || "Pruna request failed";
  return message.replaceAll(key, "[redacted]").slice(0, 300);
}
async function boundedJson(response: Response): Promise<PrunaResponse> {
  if (!response.body) throw new Error("Pruna omitted its response body");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > 65536) {await reader.cancel(); throw new Error("Pruna response exceeded its JSON limit");} chunks.push(value); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object") throw new Error("Pruna returned invalid JSON");
  const record = value as Record<string, unknown>;
  const result: PrunaResponse = {};
  for (const field of ["id", "status", "generation_url", "message"] as const) {
    if (typeof record[field] === "string") result[field] = record[field];
  }
  if (typeof record.error === "string") result.error = record.error;
  else if (record.error && typeof record.error === "object" && "message" in record.error && typeof record.error.message === "string") result.error = record.error.message;
  return result;
}
export async function prunaRequest(key: string, input: PrunaInput | string): Promise<PrunaResponse> {
  const poll = typeof input === "string";
  const url = poll ? `${ORIGIN}/v1/predictions/status/${encodeURIComponent(input)}` : `${ORIGIN}/v1/predictions`;
  const response = await fetch(url, {redirect: "manual", method: poll ? "GET" : "POST", headers: {apikey: key, ...(!poll ? {Model: "p-image-try-on", "Content-Type": "application/json"} : {})}, ...(!poll ? {body: JSON.stringify({input})} : {})});
  let value: PrunaResponse;
  try { value = await boundedJson(response); } catch { throw new PrunaError(response.status, "Pruna returned an unreadable response"); }
  if (!response.ok) throw new PrunaError(response.status, prunaDetail(value, key));
  return value;
}
export async function prunaImage(key: string, url: string): Promise<Response> {
  if (!trustedPrunaUrl(url)) throw new Error("Pruna returned an untrusted delivery URL");
  const response = await fetch(url, {headers: {apikey: key}, redirect: "manual"});
  if (!response.ok) throw new PrunaError(response.status, "Pruna result download failed");
  return response;
}
