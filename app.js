const API_BASE = "https://lv-virtual-try-on.s98081096.workers.dev";
const PUBLIC_APP_URL = "https://augustzad.github.io/lv-virtual-try-on/";
const MAX_GARMENTS = 6;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXTENSION_TYPES = new Map([["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"]]);
const PENDING_JOB_KEY = "lv-fitting-pending-job";
const JOB_ID_PATTERN = /^job_[a-f0-9]{32}$/;

const elements = {
  consent: document.querySelector("#consentInput"),
  copyTask: document.querySelector("#copyTaskButton"),
  direction: document.querySelector("#directionInput"),
  download: document.querySelector("#downloadButton"),
  error: document.querySelector("#errorState"),
  errorMessage: document.querySelector("#errorMessage"),
  garmentCount: document.querySelector("#garmentCount"),
  garmentDropZone: document.querySelector("#garmentDropZone"),
  garmentGrid: document.querySelector("#garmentGrid"),
  garmentInput: document.querySelector("#garmentInput"),
  generate: document.querySelector("#generateButton"),
  generating: document.querySelector("#generatingState"),
  generatingNote: document.querySelector("#generatingNote"),
  generatingTitle: document.querySelector("#generatingTitle"),
  personDropZone: document.querySelector("#personDropZone"),
  personEmpty: document.querySelector("#personEmpty"),
  personFeedback: document.querySelector("#personFeedback"),
  personFeedbackText: document.querySelector("#personFeedbackText"),
  personImage: document.querySelector("#personImage"),
  personInput: document.querySelector("#personInput"),
  personPreview: document.querySelector("#personPreview"),
  poseDropZone: document.querySelector("#poseDropZone"),
  poseEmpty: document.querySelector("#poseEmpty"),
  poseFeedback: document.querySelector("#poseFeedback"),
  poseFeedbackText: document.querySelector("#poseFeedbackText"),
  poseImage: document.querySelector("#poseImage"),
  poseInput: document.querySelector("#poseInput"),
  posePreview: document.querySelector("#posePreview"),
  poseReferencePanel: document.querySelector("#poseReferencePanel"),
  previousResult: document.querySelector("#previousResultButton"),
  progress: document.querySelector("#progressBar"),
  reset: document.querySelector("#resetButton"),
  resultEmpty: document.querySelector("#resultEmpty"),
  resultImage: document.querySelector("#resultImage"),
  resultMeta: document.querySelector("#resultMeta"),
  resultPager: document.querySelector("#resultPager"),
  resultPanel: document.querySelector("#resultPanel"),
  resultPosition: document.querySelector("#resultPosition"),
  resultReady: document.querySelector("#resultReady"),
  resultWarning: document.querySelector("#resultWarning"),
  releaseTask: document.querySelector("#releaseTaskButton"),
  taskReference: document.querySelector("#activeTaskReference"),
  nextResult: document.querySelector("#nextResultButton"),
  retry: document.querySelector("#retryButton")
};

let personFile = null;
let personUrl = "";
let poseFile = null;
let poseUrl = "";
let garmentFiles = [];
let garmentUrls = [];
let resultUrls = [];
let activeResultIndex = 0;
let progressTimer = 0;
let activeJobId = "";
let resultTouchStart = null;
const releasedJobIds = new Set();

class JobReleasedError extends Error {
  constructor() {
    super("This task was released from the screen.");
    this.name = "JobReleasedError";
  }
}

function prepareImage(file) {
  if (file.size < 1) return { error: "This image is empty." };
  if (file.size > MAX_FILE_BYTES) return { error: "Image exceeds the 8 MB limit." };
  if (ACCEPTED_TYPES.has(file.type)) return { file };
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  const inferredType = EXTENSION_TYPES.get(extension);
  if (!inferredType) return { error: "Use a JPG, PNG or WEBP image." };
  return { file: new File([file], file.name, { lastModified: file.lastModified, type: inferredType }) };
}

function setPersonFeedback(state, message) {
  elements.personFeedback.classList.toggle("is-success", state === "success");
  elements.personFeedback.classList.toggle("is-error", state === "error");
  elements.personFeedbackText.textContent = message;
}

function selectedPoseMode() {
  return document.querySelector('input[name="poseMode"]:checked')?.value || "original";
}

function setPoseFeedback(state, message) {
  elements.poseFeedback.classList.toggle("is-success", state === "success");
  elements.poseFeedback.classList.toggle("is-error", state === "error");
  elements.poseFeedbackText.textContent = message;
}

function setPoseReference(file) {
  const prepared = prepareImage(file);
  if (prepared.error || !prepared.file) {
    setPoseFeedback("error", prepared.error || "Pose image could not be added.");
    elements.poseDropZone.classList.toggle("has-file", Boolean(poseFile));
    return;
  }
  if (poseUrl) URL.revokeObjectURL(poseUrl);
  poseFile = prepared.file;
  poseUrl = URL.createObjectURL(prepared.file);
  elements.poseImage.src = poseUrl;
  elements.poseEmpty.hidden = true;
  elements.posePreview.hidden = false;
  elements.poseDropZone.classList.add("has-file");
  setPoseFeedback("success", `Pose added · ${prepared.file.name}`);
  updateButton();
}

function syncPoseMode() {
  elements.poseReferencePanel.hidden = selectedPoseMode() !== "reference";
  updateButton();
}

function formReady() {
  const poseReady = selectedPoseMode() !== "reference" || Boolean(poseFile);
  return Boolean(personFile && garmentFiles.length > 0 && poseReady && elements.consent.checked);
}

function createJobId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `job_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function recoveryJobFromUrl() {
  if (window.location.protocol === "file:") return "";
  const url = new URL(window.location.href);
  const jobId = (url.searchParams.get("job") || "").trim();
  if (!JOB_ID_PATTERN.test(jobId)) return "";
  window.localStorage.setItem(PENDING_JOB_KEY, jobId);
  url.searchParams.delete("job");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return jobId;
}

function openLiveApp() {
  const url = new URL(PUBLIC_APP_URL);
  const pendingJobId = window.localStorage.getItem(PENDING_JOB_KEY) || "";
  if (JOB_ID_PATTERN.test(pendingJobId)) url.searchParams.set("job", pendingJobId);
  window.location.assign(url.toString());
}

function releaseResultUrls() {
  resultUrls.forEach((url) => {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  });
}

function showTemporaryError(message) {
  window.clearTimeout(showTemporaryError.timer);
  elements.resultMeta.textContent = message;
  showTemporaryError.timer = window.setTimeout(updateButton, 3200);
}

function setPerson(file) {
  const prepared = prepareImage(file);
  if (prepared.error || !prepared.file) {
    setPersonFeedback("error", prepared.error || "Photo could not be added.");
    elements.personDropZone.classList.toggle("has-file", Boolean(personFile));
    return;
  }
  if (personUrl) URL.revokeObjectURL(personUrl);
  personFile = prepared.file;
  personUrl = URL.createObjectURL(prepared.file);
  elements.personImage.src = personUrl;
  elements.personEmpty.hidden = true;
  elements.personPreview.hidden = false;
  elements.personDropZone.classList.add("has-file");
  setPersonFeedback("success", `Photo added · ${prepared.file.name}`);
  updateButton();
}

function addGarments(files) {
  const incoming = [...files];
  const valid = incoming.flatMap((file) => {
    const prepared = prepareImage(file);
    if (prepared.error || !prepared.file) {
      showTemporaryError(prepared.error || "Clothing image could not be added.");
      return [];
    }
    return [prepared.file];
  });
  const available = MAX_GARMENTS - garmentFiles.length;
  if (valid.length > available) showTemporaryError(`一次最多添加 ${MAX_GARMENTS} 件衣服`);
  garmentFiles.push(...valid.slice(0, available));
  renderGarments();
}

function renderGarments() {
  garmentUrls.forEach((url) => URL.revokeObjectURL(url));
  garmentUrls = garmentFiles.map((file) => URL.createObjectURL(file));
  elements.garmentGrid.querySelectorAll(".garment-card").forEach((card) => card.remove());
  garmentFiles.forEach((file, index) => {
    const card = document.createElement("div");
    card.className = "garment-card";
    card.innerHTML = `
      <img src="${garmentUrls[index]}" alt="服装参考 ${index + 1}">
      <span class="garment-index">${String(index + 1).padStart(2, "0")}</span>
      <button type="button" aria-label="移除第 ${index + 1} 件衣服">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg>
      </button>`;
    card.querySelector("button").addEventListener("click", () => {
      garmentFiles.splice(index, 1);
      renderGarments();
    });
    elements.garmentGrid.insertBefore(card, elements.garmentDropZone);
  });
  elements.garmentDropZone.hidden = garmentFiles.length >= MAX_GARMENTS;
  elements.garmentCount.textContent = `${garmentFiles.length} / ${MAX_GARMENTS}`;
  updateButton();
}

function updateButton() {
  if (activeJobId) {
    elements.generate.disabled = true;
    elements.resultMeta.textContent = "Background task";
    return;
  }
  const ready = formReady();
  elements.generate.disabled = !ready;
  if (!personFile) elements.resultMeta.textContent = "Add a photo";
  else if (!garmentFiles.length) elements.resultMeta.textContent = "Add clothing";
  else if (selectedPoseMode() === "reference" && !poseFile) elements.resultMeta.textContent = "Add pose reference";
  else if (!elements.consent.checked) elements.resultMeta.textContent = "Confirm consent";
  else elements.resultMeta.textContent = `${garmentFiles.length} piece${garmentFiles.length > 1 ? "s" : ""} ready`;
}

function bindDropZone(zone, onFiles) {
  ["dragenter", "dragover"].forEach((name) => zone.addEventListener(name, (event) => {
    event.preventDefault();
    zone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((name) => zone.addEventListener(name, (event) => {
    event.preventDefault();
    zone.classList.remove("is-dragging");
  }));
  zone.addEventListener("drop", (event) => onFiles(event.dataTransfer.files));
}

function setView(view) {
  elements.resultEmpty.hidden = view !== "empty";
  elements.generating.hidden = view !== "generating";
  elements.resultReady.hidden = view !== "ready";
  elements.error.hidden = view !== "error";
}

function normalizedJobErrors(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || !Number.isInteger(item.look) || item.look < 1 || item.look > MAX_GARMENTS || typeof item.message !== "string") return [];
    return [{ look: item.look, message: item.message.slice(0, 240) }];
  });
}

function showResultErrors(errors) {
  elements.resultWarning.hidden = !errors.length;
  elements.resultWarning.textContent = errors.map((error) => error.message).join(" · ");
}

function startProgress(restored = false) {
  const messages = [
    restored ? "Restoring your background task…" : "Reading your references…",
    "Rebuilding fabric and form…",
    "Refining folds and light…",
    "Working in the background…"
  ];
  let progress = 10;
  let message = 0;
  elements.generatingTitle.textContent = messages[0];
  elements.generatingNote.textContent = "You can close this page. We’ll restore it when you return.";
  elements.progress.style.width = `${progress}%`;
  progressTimer = window.setInterval(() => {
    progress = Math.min(92, progress + Math.max(1, Math.round((94 - progress) * 0.09)));
    elements.progress.style.width = `${progress}%`;
    message = Math.min(messages.length - 1, message + 1);
    elements.generatingTitle.textContent = messages[message];
  }, 4200);
}

function showActiveTask(jobId) {
  elements.taskReference.dataset.jobId = jobId;
  elements.taskReference.textContent = `Task · ${jobId.slice(-8).toUpperCase()}`;
  elements.copyTask.textContent = "Copy ID";
}

function stopProgress(complete = false) {
  window.clearInterval(progressTimer);
  if (complete) elements.progress.style.width = "100%";
}

async function generateTryOn() {
  if (activeJobId || !formReady()) return;
  if (window.location.protocol === "file:") {
    elements.errorMessage.textContent = "本地文件可以预览照片，请打开线上版本开始生成。";
    elements.retry.textContent = "打开线上版本";
    elements.resultMeta.textContent = "Open live app";
    setView("error");
    elements.resultPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const totalBytes = personFile.size + garmentFiles.reduce((sum, file) => sum + file.size, 0) + (selectedPoseMode() === "reference" && poseFile ? poseFile.size : 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    showTemporaryError("图片总大小不能超过 40 MB");
    return;
  }
  elements.retry.textContent = "再试一次";
  const jobId = createJobId();
  activeJobId = jobId;
  window.localStorage.setItem(PENDING_JOB_KEY, jobId);
  showActiveTask(jobId);
  setView("generating");
  elements.generate.disabled = true;
  elements.generate.querySelector("span").textContent = "正在生成";
  elements.resultMeta.textContent = "Generating";
  showResultErrors([]);
  startProgress();
  elements.resultPanel.scrollIntoView({ behavior: "smooth", block: "center" });

  const body = new FormData();
  body.append("person", personFile, personFile.name);
  garmentFiles.forEach((file) => body.append("garments", file, file.name));
  body.append("consent", "true");
  body.append("direction", elements.direction.value.trim());
  body.append("mode", document.querySelector('input[name="tryOnMode"]:checked')?.value || "separate");
  body.append("poseMode", selectedPoseMode());
  body.append("jobId", jobId);
  if (selectedPoseMode() === "reference" && poseFile) body.append("poseReference", poseFile, poseFile.name);

  let accepted = false;
  try {
    const submitted = await fetch(`${API_BASE}/api/try-on`, { method: "POST", headers: { "X-Job-Id": jobId }, body });
    if (!submitted.ok) {
      clearPendingJob(jobId);
      throw new Error(await responseError(submitted));
    }
    const task = await submitted.json();
    if (task.jobId !== jobId || task.status !== "processing") throw new Error("服务没有返回有效任务");
    accepted = true;
    await finishBackgroundJob(jobId, Number(task.pollAfterMs) || 5000);
  } catch (error) {
    const wasReleased = releasedJobIds.delete(jobId);
    if (error instanceof JobReleasedError || wasReleased) return;
    let failure = error;
    if (!accepted && activeJobId === jobId) {
      elements.generatingTitle.textContent = "Confirming your background task…";
      try {
        await finishBackgroundJob(jobId, 1500);
        return;
      } catch (recoveryError) {
        failure = recoveryError;
      }
    }
    stopProgress();
    const message = failure instanceof Error ? failure.message : "Generation failed.";
    elements.errorMessage.textContent = `${message}\nTask ID: ${jobId}`;
    setView("error");
    elements.resultMeta.textContent = "Not completed";
  } finally {
    elements.generate.querySelector("span").textContent = "生成试穿效果";
    elements.generate.disabled = Boolean(activeJobId) || !formReady();
  }
}

async function finishBackgroundJob(jobId, initialPollAfterMs = 5000) {
  const response = await waitForBackgroundJob(jobId, initialPollAfterMs);
  if (activeJobId !== jobId) throw new JobReleasedError();
  if (!response.ok) {
    clearPendingJob(jobId);
    throw new Error(await responseError(response));
  }
  const completed = await response.json();
  if (completed.status !== "succeeded" || !Array.isArray(completed.results) || !completed.results.length) {
    clearPendingJob(jobId);
    throw new Error("服务没有返回有效结果");
  }
  const expectedPath = new RegExp(`^/api/try-on/jobs/${jobId}/results/[1-6]$`);
  if (completed.results.some((result) => typeof result.url !== "string" || !expectedPath.test(result.url))) {
    clearPendingJob(jobId);
    throw new Error("服务没有返回有效结果地址");
  }
  releaseResultUrls();
  resultUrls = completed.results.map((result) => `${API_BASE}${result.url}`);
  const jobErrors = normalizedJobErrors(completed.errors);
  activeResultIndex = 0;
  renderActiveResult();
  clearPendingJob(jobId);
  stopProgress(true);
  window.setTimeout(() => setView("ready"), 260);
  showResultErrors(jobErrors);
  elements.resultMeta.textContent = completed.failedCount
    ? `${resultUrls.length} ready · ${completed.failedCount} failed`
    : resultUrls.length > 1 ? `${resultUrls.length} looks` : "Ready";
}

function renderActiveResult() {
  if (!resultUrls.length) return;
  activeResultIndex = Math.max(0, Math.min(resultUrls.length - 1, activeResultIndex));
  elements.resultImage.src = resultUrls[activeResultIndex];
  elements.resultImage.alt = resultUrls.length > 1
    ? `AI 生成的试穿效果，第 ${activeResultIndex + 1} 张，共 ${resultUrls.length} 张`
    : "AI 生成的真人试穿效果";
  elements.resultPosition.textContent = `${activeResultIndex + 1} / ${resultUrls.length}`;
  elements.previousResult.disabled = activeResultIndex === 0;
  elements.nextResult.disabled = activeResultIndex === resultUrls.length - 1;
  elements.resultPager.hidden = resultUrls.length < 2;
}

async function waitForBackgroundJob(jobId, initialPollAfterMs) {
  let pollAfterMs = initialPollAfterMs;
  while (activeJobId === jobId) {
    const foregroundDelay = Math.max(2000, Math.min(10000, pollAfterMs));
    await delay(document.hidden ? Math.max(15000, foregroundDelay) : foregroundDelay);
    let response;
    try {
      response = await fetch(`${API_BASE}/api/try-on/jobs/${encodeURIComponent(jobId)}`);
    } catch {
      elements.generatingNote.textContent = navigator.onLine
        ? "Connection interrupted. Your task is still running."
        : "You’re offline. Your task is still running in the background.";
      pollAfterMs = 10000;
      continue;
    }
    elements.generatingNote.textContent = "You can close this page. We’ll restore it when you return.";
    if (response.status !== 202) return response;
    const progress = await response.json();
    const progressErrors = normalizedJobErrors(progress.errors);
    if (progressErrors.length) {
      elements.generatingNote.textContent = `${progressErrors.map((error) => error.message).join(" ")} Other looks are still running.`;
      elements.resultMeta.textContent = `${progressErrors.length} failed · others running`;
    }
    pollAfterMs = Number(progress.pollAfterMs) || pollAfterMs;
  }
  throw new JobReleasedError();
}

function clearPendingJob(jobId) {
  if (activeJobId === jobId) activeJobId = "";
  if (window.localStorage.getItem(PENDING_JOB_KEY) === jobId) window.localStorage.removeItem(PENDING_JOB_KEY);
}

async function restorePendingJob() {
  const jobId = recoveryJobFromUrl() || window.localStorage.getItem(PENDING_JOB_KEY) || "";
  if (!JOB_ID_PATTERN.test(jobId)) {
    window.localStorage.removeItem(PENDING_JOB_KEY);
    return;
  }
  activeJobId = jobId;
  showActiveTask(jobId);
  setView("generating");
  elements.resultMeta.textContent = "Background task";
  startProgress(true);
  try {
    await finishBackgroundJob(jobId, 1000);
  } catch (error) {
    const wasReleased = releasedJobIds.delete(jobId);
    if (error instanceof JobReleasedError || wasReleased) return;
    stopProgress();
    const message = error instanceof Error ? error.message : "Generation failed.";
    elements.errorMessage.textContent = `${message}\nTask ID: ${jobId}`;
    setView("error");
    elements.resultMeta.textContent = "Not completed";
  } finally {
    elements.generate.disabled = Boolean(activeJobId) || !formReady();
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function responseError(response) {
  let message = "生成失败，请稍后再试";
  try {
    const detail = await response.json();
    const jobErrors = normalizedJobErrors(detail.errors);
    if (jobErrors.length) message = jobErrors.map((error) => error.message).join(" ");
    else if (detail.error) message = detail.error;
  } catch {}
  return message;
}

elements.personInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) setPerson(file);
  event.target.value = "";
});
elements.garmentInput.addEventListener("change", (event) => {
  addGarments(event.target.files);
  event.target.value = "";
});
elements.poseInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) setPoseReference(file);
  event.target.value = "";
});
document.querySelectorAll('input[name="poseMode"]').forEach((input) => input.addEventListener("change", syncPoseMode));
elements.consent.addEventListener("change", updateButton);
elements.generate.addEventListener("click", generateTryOn);
elements.copyTask.addEventListener("click", async () => {
  const jobId = elements.taskReference.dataset.jobId || "";
  if (!JOB_ID_PATTERN.test(jobId)) return;
  try {
    await navigator.clipboard.writeText(jobId);
    elements.copyTask.textContent = "Copied";
    window.setTimeout(() => { elements.copyTask.textContent = "Copy ID"; }, 1800);
  } catch {
    elements.taskReference.textContent = jobId;
  }
});
elements.releaseTask.addEventListener("click", () => {
  const jobId = activeJobId;
  if (!jobId) return;
  releasedJobIds.add(jobId);
  clearPendingJob(jobId);
  stopProgress();
  setView("empty");
  elements.resultMeta.textContent = "Ready for a new fitting";
  updateButton();
  elements.generate.scrollIntoView({ behavior: "smooth", block: "center" });
});
elements.retry.addEventListener("click", () => {
  if (window.location.protocol === "file:") openLiveApp();
  else generateTryOn();
});
elements.reset.addEventListener("click", () => {
  setView("empty");
  showResultErrors([]);
  elements.resultMeta.textContent = "Ready to revise";
  elements.direction.focus();
  window.scrollTo({ top: elements.direction.getBoundingClientRect().top + window.scrollY - 80, behavior: "smooth" });
});
elements.previousResult.addEventListener("click", () => {
  activeResultIndex -= 1;
  renderActiveResult();
});
elements.nextResult.addEventListener("click", () => {
  activeResultIndex += 1;
  renderActiveResult();
});
elements.resultImage.addEventListener("touchstart", (event) => {
  const touch = event.changedTouches[0];
  resultTouchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
}, { passive: true });
elements.resultImage.addEventListener("touchend", (event) => {
  if (!resultTouchStart || resultUrls.length < 2) return;
  const touch = event.changedTouches[0];
  if (!touch) return;
  const deltaX = touch.clientX - resultTouchStart.x;
  const deltaY = touch.clientY - resultTouchStart.y;
  resultTouchStart = null;
  if (Math.abs(deltaX) < 48 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return;
  activeResultIndex += deltaX < 0 ? 1 : -1;
  renderActiveResult();
}, { passive: true });
elements.download.addEventListener("click", async () => {
  if (!resultUrls[activeResultIndex]) return;
  elements.download.disabled = true;
  try {
    const response = await fetch(resultUrls[activeResultIndex]);
    if (!response.ok) throw new Error(await responseError(response));
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("服务没有返回有效图片");
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `lv-fitting-${new Date().toISOString().slice(0, 10)}-look-${activeResultIndex + 1}.png`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    showTemporaryError(error instanceof Error ? error.message : "下载失败，请稍后再试");
  } finally {
    elements.download.disabled = false;
  }
});

bindDropZone(elements.personDropZone, (files) => { if (files[0]) setPerson(files[0]); });
bindDropZone(elements.garmentDropZone, addGarments);
bindDropZone(elements.poseDropZone, (files) => { if (files[0]) setPoseReference(files[0]); });
syncPoseMode();
updateButton();
restorePendingJob().catch(() => {});
