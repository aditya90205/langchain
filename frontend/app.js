const uploadForm = document.getElementById("uploadForm");
const docTypeSelect = document.getElementById("docType");
const caseFields = document.getElementById("caseFields");
const bareActFields = document.getElementById("bareActFields");
const statusBox = document.getElementById("statusBox");
const submitBtn = document.getElementById("submitBtn");

function setStatus(message, type = "") {
  statusBox.textContent = message;
  statusBox.classList.remove("success", "error");
  if (type) {
    statusBox.classList.add(type);
  }
}

function toggleTypeFields() {
  const selectedType = docTypeSelect.value;
  const isBareAct = selectedType === "bare_act";

  caseFields.classList.toggle("hidden", isBareAct);
  bareActFields.classList.toggle("hidden", !isBareAct);
}

function setLoadingState(isLoading) {
  submitBtn.disabled = isLoading;
  submitBtn.classList.toggle("is-loading", isLoading);
  const label = submitBtn.querySelector(".btn-label");
  label.textContent = isLoading ? "Uploading and indexing..." : "Upload & Start Indexing";
}

async function submitUpload(event) {
  event.preventDefault();
  setStatus("");

  const formData = new FormData(uploadForm);
  const selectedType = docTypeSelect.value;

  if (selectedType === "bare_act" && !String(formData.get("actName") || "").trim()) {
    setStatus("Act name is required for bare act documents.", "error");
    return;
  }

  if (selectedType === "case_law" && !String(formData.get("caseName") || "").trim()) {
    setStatus("Case name is required for case law documents.", "error");
    return;
  }

  if (!formData.get("citation")) {
    setStatus("Citation is required.", "error");
    return;
  }

  try {
    setLoadingState(true);

    const response = await fetch("/api/upload-document", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || "Upload failed.");
    }

    const chunks = payload.result?.chunks?.total ?? 0;
    setStatus(
      `Upload complete. Indexed ${chunks} chunks in Qdrant (${payload.result?.docType || selectedType}).`,
      "success",
    );
    uploadForm.reset();
    docTypeSelect.value = selectedType;
    toggleTypeFields();
  } catch (error) {
    setStatus(error.message || "Upload failed.", "error");
  } finally {
    setLoadingState(false);
  }
}

docTypeSelect.addEventListener("change", toggleTypeFields);
uploadForm.addEventListener("submit", submitUpload);
toggleTypeFields();
