import * as dotenv from "dotenv";
import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { ingestLegalDocument } from "./ingest_qdrant_service.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const uploadsDir = path.join(__dirname, "uploads");
await fs.mkdir(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "-");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 30 * 1024 * 1024,
  },
});

function normalizeDocType(value) {
  return String(value || "").trim().toLowerCase();
}

function buildMetadataFromBody(body) {
  return {
    legal_doc_type: normalizeDocType(body.docType),
    act_name: String(body.actName || "").trim(),
    section_no: String(body.sectionNo || "").trim(),
    case_name: String(body.caseName || "").trim(),
    citation: String(body.citation || "").trim(),
    court: String(body.court || "").trim(),
    bench: String(body.bench || "").trim(),
    judgment_date: String(body.judgmentDate || "").trim(),
    jurisdiction: String(body.jurisdiction || "India").trim(),
  };
}

function validatePayload(file, metadata) {
  if (!file) {
    throw new Error("Please upload a PDF file.");
  }

  if (path.extname(file.originalname).toLowerCase() !== ".pdf") {
    throw new Error("Only PDF files are supported.");
  }

  if (!["bare_act", "case_law"].includes(metadata.legal_doc_type)) {
    throw new Error("Document type must be either 'bare_act' or 'case_law'.");
  }

  if (!metadata.citation) {
    throw new Error("Citation is required.");
  }

  if (metadata.legal_doc_type === "bare_act" && !metadata.act_name) {
    throw new Error("Act name is required for bare act uploads.");
  }

  if (metadata.legal_doc_type === "case_law" && !metadata.case_name) {
    throw new Error("Case name is required for case law uploads.");
  }
}

app.use(express.static(path.join(__dirname, "frontend")));

app.post("/api/upload-document", upload.single("document"), async (req, res) => {
  const metadata = buildMetadataFromBody(req.body);
  const filePath = req.file?.path;

  try {
    validatePayload(req.file, metadata);

    const result = await ingestLegalDocument({
      pdfPath: filePath,
      metadata,
      logger: console,
    });

    return res.status(200).json({
      ok: true,
      message: "Document uploaded and indexed successfully.",
      result,
    });
  } catch (error) {
    if (filePath) {
      await fs.rm(filePath, { force: true });
    }

    return res.status(400).json({
      ok: false,
      message: error.message || "Upload failed.",
    });
  }
});

app.get("/health", (_, res) => {
  res.json({ ok: true, service: "legal-upload-api" });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Upload server is running on http://localhost:${PORT}`);
});
