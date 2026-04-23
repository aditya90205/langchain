const uploadForm = document.getElementById("uploadForm");
const docTypeSelect = document.getElementById("docType");
const statusBox = document.getElementById("statusBox");
const submitBtn = document.getElementById("submitBtn");
const reviewPanel = document.getElementById("reviewPanel");
const reviewForm = document.getElementById("reviewForm");
const reviewFields = document.getElementById("reviewFields");
const approveBtn = document.getElementById("approveBtn");
const rejectBtn = document.getElementById("rejectBtn");
const pagePreviewList = document.getElementById("pagePreviewList");
const pageReviewMeta = document.getElementById("pageReviewMeta");
const pagePrevBtn = document.getElementById("pagePrevBtn");
const pageNextBtn = document.getElementById("pageNextBtn");
const pageSelect = document.getElementById("pageSelect");
const pdfPreviewFrame = document.getElementById("pdfPreviewFrame");
const openPdfLink = document.getElementById("openPdfLink");

const API_BASE_URL =
  window.location.port === "5500" || window.location.port === "5501"
    ? "http://127.0.0.1:3000"
    : "";

let activeReviewToken = "";
let activeReviewDocType = "case_law";
let activePdfUrl = "";
let activeReviewPages = [];
let activeReviewPageIndex = 0;

const EDITABLE_FIELDS = [
  { key: "case_name", label: "Case Name" },
  { key: "act_name", label: "Act Name" },
  { key: "section_no", label: "Section Number" },
  { key: "citation", label: "Citation" },
  { key: "court", label: "Court" },
  { key: "bench", label: "Bench" },
  { key: "judgment_date", label: "Judgment Date" },
  { key: "jurisdiction", label: "Jurisdiction" },
];

function setStatus(message, type = "") {
  statusBox.textContent = message;
  statusBox.classList.remove("success", "error");
  if (type) {
    statusBox.classList.add(type);
  }
}

function buildFieldInput(field, value) {
  const wrapper = document.createElement("label");
  wrapper.className = "field";

  const title = document.createElement("span");
  title.textContent = field.label;

  const input = document.createElement("input");
  input.type = "text";
  input.name = field.key;
  input.value = String(value || "");

  wrapper.appendChild(title);
  wrapper.appendChild(input);
  return wrapper;
}

function setButtonLoading(button, loadingLabel, idleLabel, isLoading) {
  button.disabled = isLoading;
  button.classList.toggle("is-loading", isLoading);
  const label = button.querySelector(".btn-label");
  label.textContent = isLoading ? loadingLabel : idleLabel;
}

function resetReviewState() {
  activeReviewToken = "";
  activePdfUrl = "";
  activeReviewPages = [];
  activeReviewPageIndex = 0;
  reviewPanel.classList.add("hidden");
  reviewPanel.classList.remove("is-visible");
  reviewFields.innerHTML = "";
  pagePreviewList.innerHTML = "";
  pageReviewMeta.textContent = "";
  pageSelect.innerHTML = "";
  pagePrevBtn.disabled = true;
  pageNextBtn.disabled = true;
  pdfPreviewFrame.removeAttribute("src");
  openPdfLink.setAttribute("href", "#");
}

function getActivePage() {
  return activeReviewPages[activeReviewPageIndex] || null;
}

function syncPageNavigationState() {
  if (!activeReviewPages.length) {
    pageReviewMeta.textContent = "No extracted pages available.";
    pagePrevBtn.disabled = true;
    pageNextBtn.disabled = true;
    pageSelect.disabled = true;
    return;
  }

  const activePage = getActivePage();
  pageReviewMeta.textContent = `Page ${activePage.page} of ${activeReviewPages.length}`;
  pagePrevBtn.disabled = activeReviewPageIndex <= 0;
  pageNextBtn.disabled = activeReviewPageIndex >= activeReviewPages.length - 1;
  pageSelect.disabled = false;
  pageSelect.value = String(activeReviewPageIndex);
}

function renderActivePageEditor() {
  pagePreviewList.innerHTML = "";

  if (!activeReviewPages.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "No page text was extracted for review.";
    pagePreviewList.appendChild(emptyState);
    syncPageNavigationState();
    return;
  }

  const activePage = getActivePage();
  const article = document.createElement("article");
  article.className = "preview-card preview-card--active";
  article.dataset.pageNumber = String(activePage.page);

  const heading = document.createElement("div");
  heading.className = "preview-card__header";

  const title = document.createElement("h4");
  title.textContent = `Page ${activePage.page}`;

  const badge = document.createElement("span");
  badge.className = "page-badge";
  badge.textContent = `${activeReviewPageIndex + 1}/${activeReviewPages.length}`;

  heading.appendChild(title);
  heading.appendChild(badge);

  const meta = document.createElement("p");
  meta.className = "preview-card__meta";
  meta.textContent = "Edit the extracted page text before approving.";

  const text = document.createElement("textarea");
  text.className = "preview-editor preview-editor--active";
  text.name = `page_${activePage.page}`;
  text.rows = 18;
  text.value = activePage.text || "No extracted text for this page.";
  text.addEventListener("input", () => {
    activePage.text = text.value;
  });

  article.appendChild(heading);
  article.appendChild(meta);
  article.appendChild(text);
  pagePreviewList.appendChild(article);

  syncPageNavigationState();
}

function buildPageSelectOptions() {
  pageSelect.innerHTML = "";

  activeReviewPages.forEach((page, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `Page ${page.page}`;
    pageSelect.appendChild(option);
  });
}

function goToReviewPage(nextIndex) {
  if (!activeReviewPages.length) {
    return;
  }

  const boundedIndex = Math.max(
    0,
    Math.min(nextIndex, activeReviewPages.length - 1),
  );

  activeReviewPageIndex = boundedIndex;
  renderActivePageEditor();
}

function renderReview(data, docType) {
  reviewFields.innerHTML = "";
  activePdfUrl = data.pdfUrl ? buildApiUrl(data.pdfUrl) : "";
  if (activePdfUrl) {
    pdfPreviewFrame.src = activePdfUrl;
    openPdfLink.href = activePdfUrl;
  }

  for (const field of EDITABLE_FIELDS) {
    if (docType === "case_law" && field.key === "act_name") {
      continue;
    }

    if (docType === "bare_act" && field.key === "case_name") {
      continue;
    }

    reviewFields.appendChild(
      buildFieldInput(field, data.metadata?.[field.key]),
    );
  }

  activeReviewPages = Array.isArray(data.pages)
    ? data.pages.map((page) => ({
        page: Number(page.page),
        text: String(page.text || page.preview || "").trim(),
      }))
    : [];
  activeReviewPageIndex = 0;
  buildPageSelectOptions();
  if (activeReviewPages.length) {
    pageSelect.value = "0";
  }
  renderActivePageEditor();

  reviewPanel.classList.remove("hidden");
  reviewPanel.classList.add("is-visible");

  window.requestAnimationFrame(() => {
    reviewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function collectReviewedMetadata() {
  const formData = new FormData(reviewForm);
  return {
    legal_doc_type: activeReviewDocType,
    case_name: String(formData.get("case_name") || "").trim(),
    act_name: String(formData.get("act_name") || "").trim(),
    section_no: String(formData.get("section_no") || "").trim(),
    citation: String(formData.get("citation") || "").trim(),
    court: String(formData.get("court") || "").trim(),
    bench: String(formData.get("bench") || "").trim(),
    judgment_date: String(formData.get("judgment_date") || "").trim(),
    jurisdiction: String(formData.get("jurisdiction") || "India").trim(),
  };
}

function collectEditedPages() {
  return activeReviewPages
    .filter((page) => Number(page.page) > 0)
    .map((page) => ({
      page: Number(page.page),
      text: String(page.text || "").trim(),
    }));
}

function validateReviewMetadata(metadata) {
  if (metadata.legal_doc_type === "case_law" && !metadata.case_name) {
    throw new Error("Case name is required before approval.");
  }

  if (metadata.legal_doc_type === "bare_act" && !metadata.act_name) {
    throw new Error("Act name is required before approval.");
  }
}

function buildApiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function submitUpload(event) {
  event.preventDefault();
  setStatus("");

  const formData = new FormData(uploadForm);
  const selectedType = docTypeSelect.value;

  if (!formData.get("document")) {
    setStatus("Please choose a PDF file.", "error");
    return;
  }

  formData.set("docType", selectedType);

  try {
    setButtonLoading(
      submitBtn,
      "Extracting metadata from PDF...",
      "Extract Document Data",
      true,
    );

    const response = await fetchWithTimeout(
      buildApiUrl("/api/upload-document/preview"),
      {
        method: "POST",
        body: formData,
      },
      120000,
    );

    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || "Preview extraction failed.");
    }

    activeReviewToken = payload.reviewToken;
    activeReviewDocType = selectedType;
    renderReview(payload.extracted || {}, selectedType);
    setStatus(
      `Extraction complete (${payload.extracted?.strategy || "OCR"}). Review and approve to save.`,
      "success",
    );
  } catch (error) {
    resetReviewState();
    if (error.name === "AbortError") {
      setStatus(
        "Extraction is taking too long. Try a smaller PDF or retry in a moment.",
        "error",
      );
    } else {
      setStatus(error.message || "Upload failed.", "error");
    }
  } finally {
    setButtonLoading(
      submitBtn,
      "Extracting metadata from PDF...",
      "Extract Document Data",
      false,
    );
  }
}

async function approveReviewedUpload(event) {
  event.preventDefault();
  setStatus("");

  try {
    if (!activeReviewToken) {
      throw new Error("No active review session. Upload a document first.");
    }

    const metadata = collectReviewedMetadata();
    validateReviewMetadata(metadata);
    const editedPages = collectEditedPages();

    setButtonLoading(
      approveBtn,
      "Saving approved document...",
      "Approve & Save To DB",
      true,
    );

    const response = await fetch(buildApiUrl("/api/upload-document/approve"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reviewToken: activeReviewToken,
        metadata,
        editedPages,
      }),
    });

    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || "Approval failed.");
    }

    const chunks = payload.result?.chunks?.total ?? 0;
    setStatus(
      `Approved and saved. Indexed ${chunks} chunks in Qdrant (${payload.result?.docType || activeReviewDocType}).`,
      "success",
    );

    const selectedType = docTypeSelect.value;
    uploadForm.reset();
    docTypeSelect.value = selectedType;
    resetReviewState();
  } catch (error) {
    setStatus(error.message || "Approval failed.", "error");
  } finally {
    setButtonLoading(
      approveBtn,
      "Saving approved document...",
      "Approve & Save To DB",
      false,
    );
  }
}

async function rejectReviewedUpload() {
  setStatus("");

  try {
    if (!activeReviewToken) {
      throw new Error("No active review session to discard.");
    }

    rejectBtn.disabled = true;
    const response = await fetch(buildApiUrl("/api/upload-document/reject"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reviewToken: activeReviewToken,
      }),
    });

    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || "Could not discard draft upload.");
    }

    resetReviewState();
    setStatus("Draft upload discarded.", "success");
  } catch (error) {
    setStatus(error.message || "Could not discard draft upload.", "error");
  } finally {
    rejectBtn.disabled = false;
  }
}

uploadForm.addEventListener("submit", submitUpload);
reviewForm.addEventListener("submit", approveReviewedUpload);
rejectBtn.addEventListener("click", rejectReviewedUpload);
pagePrevBtn.addEventListener("click", () => {
  goToReviewPage(activeReviewPageIndex - 1);
});
pageNextBtn.addEventListener("click", () => {
  goToReviewPage(activeReviewPageIndex + 1);
});
pageSelect.addEventListener("change", (event) => {
  goToReviewPage(Number(event.target.value || 0));
});
