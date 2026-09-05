const API_BASE = "https://lv-virtual-try-on.s98081096.workers.dev";
const MAX_GARMENTS = 6;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const elements = {
  consent: document.querySelector("#consentInput"),
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
  generatingTitle: document.querySelector("#generatingTitle"),
  personDropZone: document.querySelector("#personDropZone"),
  personEmpty: document.querySelector("#personEmpty"),
  personImage: document.querySelector("#personImage"),
  personInput: document.querySelector("#personInput"),
  personPreview: document.querySelector("#personPreview"),
  progress: document.querySelector("#progressBar"),
  quality: document.querySelector("#qualityInput"),
  reset: document.querySelector("#resetButton"),
  resultEmpty: document.querySelector("#resultEmpty"),
  resultImage: document.querySelector("#resultImage"),
  resultMeta: document.querySelector("#resultMeta"),
  resultPanel: document.querySelector("#resultPanel"),
  resultReady: document.querySelector("#resultReady"),
  retry: document.querySelector("#retryButton")
};

let personFile = null;
let personUrl = "";
let garmentFiles = [];
let garmentUrls = [];
let resultUrl = "";
let progressTimer = 0;

function validateImage(file) {
  if (!ACCEPTED_TYPES.has(file.type)) return "请使用 JPG、PNG 或 WEBP 图片";
  if (file.size > MAX_FILE_BYTES) return "单张图片不能超过 8 MB";
  return "";
}

function showTemporaryError(message) {
  window.clearTimeout(showTemporaryError.timer);
  elements.resultMeta.textContent = message;
  showTemporaryError.timer = window.setTimeout(updateButton, 3200);
}

function setPerson(file) {
  const error = validateImage(file);
  if (error) return showTemporaryError(error);
  if (personUrl) URL.revokeObjectURL(personUrl);
  personFile = file;
  personUrl = URL.createObjectURL(file);
  elements.personImage.src = personUrl;
  elements.personEmpty.hidden = true;
  elements.personPreview.hidden = false;
  updateButton();
}

function addGarments(files) {
  const incoming = [...files];
  const valid = incoming.filter((file) => {
    const error = validateImage(file);
    if (error) showTemporaryError(error);
    return !error;
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
  const ready = personFile && garmentFiles.length > 0 && elements.consent.checked;
  elements.generate.disabled = !ready;
  if (!personFile) elements.resultMeta.textContent = "Add a photo";
  else if (!garmentFiles.length) elements.resultMeta.textContent = "Add clothing";
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

function startProgress() {
  const messages = [
    "Reading your references…",
    "Rebuilding fabric and form…",
    "Refining folds and light…",
    "Finishing your look…"
  ];
  let progress = 10;
  let message = 0;
  elements.progress.style.width = `${progress}%`;
  progressTimer = window.setInterval(() => {
    progress = Math.min(92, progress + Math.max(1, Math.round((94 - progress) * 0.09)));
    elements.progress.style.width = `${progress}%`;
    message = Math.min(messages.length - 1, message + 1);
    elements.generatingTitle.textContent = messages[message];
  }, 4200);
}

function stopProgress(complete = false) {
  window.clearInterval(progressTimer);
  if (complete) elements.progress.style.width = "100%";
}

async function generateTryOn() {
  if (!personFile || !garmentFiles.length || !elements.consent.checked) return;
  setView("generating");
  elements.generate.disabled = true;
  elements.generate.querySelector("span").textContent = "正在生成";
  elements.resultMeta.textContent = "Generating";
  startProgress();
  elements.resultPanel.scrollIntoView({ behavior: "smooth", block: "center" });

  const body = new FormData();
  body.append("person", personFile, personFile.name);
  garmentFiles.forEach((file) => body.append("garments", file, file.name));
  body.append("consent", "true");
  body.append("direction", elements.direction.value.trim());
  body.append("quality", elements.quality.value);

  try {
    const submitted = await fetch(`${API_BASE}/api/try-on`, { method: "POST", body });
    if (!submitted.ok) throw new Error(await responseError(submitted));
    const task = await submitted.json();
    if (!task.jobId || task.status !== "processing") throw new Error("服务没有返回有效任务");

    let response;
    let pollAfterMs = Number(task.pollAfterMs) || 3500;
    while (true) {
      await delay(Math.max(1500, Math.min(10000, pollAfterMs)));
      response = await fetch(`${API_BASE}/api/try-on/jobs/${encodeURIComponent(task.jobId)}`);
      if (response.status !== 202) break;
      const progress = await response.json();
      pollAfterMs = Number(progress.pollAfterMs) || pollAfterMs;
    }
    if (!response.ok) throw new Error(await responseError(response));
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("服务没有返回有效图片");
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(blob);
    elements.resultImage.src = resultUrl;
    stopProgress(true);
    window.setTimeout(() => setView("ready"), 260);
    elements.resultMeta.textContent = "Ready";
  } catch (error) {
    stopProgress();
    elements.errorMessage.textContent = error instanceof Error ? error.message : "生成失败，请稍后再试";
    setView("error");
    elements.resultMeta.textContent = "Not completed";
  } finally {
    elements.generate.querySelector("span").textContent = "生成试穿效果";
    updateButton();
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function responseError(response) {
  let message = "生成失败，请稍后再试";
  try {
    const detail = await response.json();
    if (detail.error) message = detail.error;
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
elements.consent.addEventListener("change", updateButton);
elements.generate.addEventListener("click", generateTryOn);
elements.retry.addEventListener("click", generateTryOn);
elements.reset.addEventListener("click", () => {
  setView("empty");
  elements.resultMeta.textContent = "Ready to revise";
  elements.direction.focus();
  window.scrollTo({ top: elements.direction.getBoundingClientRect().top + window.scrollY - 80, behavior: "smooth" });
});
elements.download.addEventListener("click", () => {
  if (!resultUrl) return;
  const link = document.createElement("a");
  link.href = resultUrl;
  link.download = `lv-fitting-${new Date().toISOString().slice(0, 10)}.png`;
  link.click();
});

bindDropZone(elements.personDropZone, (files) => { if (files[0]) setPerson(files[0]); });
bindDropZone(elements.garmentDropZone, addGarments);
updateButton();
