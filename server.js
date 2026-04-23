import * as dotenv from "dotenv";
import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { Document } from "@langchain/core/documents";
import { ingestLegalDocument } from "./ingest_qdrant_service.js";
import { loadPdfDocumentsForPreview } from "./pdf_loader_with_ocr.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use((req, res, next) => {
  const allowedOrigin = process.env.CORS_ORIGIN || "*";
  res.header("Access-Control-Allow-Origin", allowedOrigin);
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});

const uploadsDir = path.join(__dirname, "uploads");
await fs.mkdir(uploadsDir, { recursive: true });

app.use("/uploads", express.static(uploadsDir));

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

const reviewSessions = new Map();
const REVIEW_TTL_MS = Number(process.env.REVIEW_TTL_MS || 30 * 60 * 1000);

function normalizeDocType(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function buildMetadata(payload = {}) {
  return {
    legal_doc_type: normalizeDocType(payload.docType || payload.legal_doc_type),
    act_name: String(payload.actName || payload.act_name || "").trim(),
    section_no: String(payload.sectionNo || payload.section_no || "").trim(),
    case_name: String(payload.caseName || payload.case_name || "").trim(),
    citation: String(payload.citation || "").trim(),
    court: String(payload.court || "").trim(),
    bench: String(payload.bench || "").trim(),
    judgment_date: String(
      payload.judgmentDate || payload.judgment_date || "",
    ).trim(),
    jurisdiction: String(payload.jurisdiction || "India").trim(),
  };
}

function validateDocType(docType) {
  if (!["bare_act", "case_law"].includes(docType)) {
    throw new Error("Document type must be either 'bare_act' or 'case_law'.");
  }
}

function validateUploadedFile(file) {
  if (!file) {
    throw new Error("Please upload a PDF file.");
  }

  if (path.extname(file.originalname).toLowerCase() !== ".pdf") {
    throw new Error("Only PDF files are supported.");
  }
}

function validateMetadataForIngest(metadata) {
  validateDocType(metadata.legal_doc_type);

  if (metadata.legal_doc_type === "bare_act" && !metadata.act_name) {
    throw new Error("Act name is required for bare act uploads.");
  }

  if (metadata.legal_doc_type === "case_law" && !metadata.case_name) {
    throw new Error("Case name is required for case law uploads.");
  }
}

function readPattern(text, pattern) {
  const match = text.match(pattern);
  return match ? String(match[1]).trim() : "";
}

function extractAutoMetadata(text, docType) {
  const compactText = String(text || "").replace(/\s+/g, " ");

  const common = {
    citation:
      readPattern(compactText, /(citation|cit)\s*[:\-]\s*([^\n]{3,120})/i) ||
      readPattern(compactText, /\b((?:\d{4}\s+)?\d+\s*[A-Z]{2,}\s*\d+)\b/),
    judgment_date:
      readPattern(
        compactText,
        /(judgment\s*date|date\s*of\s*judgment)\s*[:\-]\s*([^\n]{3,60})/i,
      ) || readPattern(compactText, /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/),
    court: readPattern(compactText, /(court)\s*[:\-]\s*([^\n]{3,100})/i),
    bench: readPattern(compactText, /(bench|coram)\s*[:\-]\s*([^\n]{3,100})/i),
    jurisdiction:
      readPattern(compactText, /(jurisdiction)\s*[:\-]\s*([^\n]{3,80})/i) ||
      "India",
  };

  if (docType === "bare_act") {
    return {
      legal_doc_type: "bare_act",
      act_name:
        readPattern(compactText, /(an\s+act\s+to\s+[^\n\.]{6,180})/i) ||
        readPattern(compactText, /(the\s+[^\n\.]{4,120}\s+act[,\s]+\d{4})/i) ||
        readPattern(compactText, /(act\s*name)\s*[:\-]\s*([^\n]{3,120})/i),
      section_no: readPattern(compactText, /\bsection\s+([\dA-Za-z\-]+)\b/i),
      case_name: "",
      ...common,
    };
  }

  return {
    legal_doc_type: "case_law",
    case_name:
      readPattern(compactText, /(case\s*name)\s*[:\-]\s*([^\n]{3,140})/i) ||
      readPattern(
        compactText,
        /\b([A-Z][A-Za-z0-9 .,&'-]{3,80}\s+v\.?\s+[A-Z][A-Za-z0-9 .,&'-]{3,80})\b/,
      ),
    act_name: "",
    section_no: readPattern(compactText, /\bsection\s+([\dA-Za-z\-]+)\b/i),
    ...common,
  };
}

function buildReviewPages(docs) {
  return docs.map((doc, idx) => {
    const pageText = String(doc.pageContent || "").trim();
    return {
      page: Number(doc.metadata?.page || idx + 1),
      text: pageText,
    };
  });
}

function buildEditedDocs(reviewDocs, editedPages = []) {
  const editedMap = new Map(
    (Array.isArray(editedPages) ? editedPages : []).map((page) => [
      Number(page.page),
      String(page.text || "").trim(),
    ]),
  );

  return reviewDocs.map((doc, idx) => {
    const pageNumber = Number(doc.metadata?.page || idx + 1);
    const overrideText = editedMap.get(pageNumber);
    if (!overrideText) {
      return doc;
    }

    return new Document({
      pageContent: overrideText,
      metadata: {
        ...(doc.metadata || {}),
        reviewed: true,
        edited: true,
      },
    });
  });
}

async function clearReviewSession(token) {
  const session = reviewSessions.get(token);
  if (!session) {
    return;
  }

  reviewSessions.delete(token);
  await fs.rm(session.filePath, { force: true });
}

async function pruneExpiredReviewSessions() {
  const now = Date.now();
  const expiredTokens = [];

  for (const [token, session] of reviewSessions.entries()) {
    if (session.expiresAt <= now) {
      expiredTokens.push(token);
    }
  }

  for (const token of expiredTokens) {
    await clearReviewSession(token);
  }
}

app.use(express.static(path.join(__dirname, "frontend")));
app.use(express.json());

app.post(
  "/api/upload-document/preview",
  upload.single("document"),
  async (req, res) => {
    const filePath = req.file?.path;

    try {
      await pruneExpiredReviewSessions();

      const docType = normalizeDocType(req.body.docType);
      validateUploadedFile(req.file);
      validateDocType(docType);

      console.log(
        `[preview] started | file=${req.file.originalname} | type=${docType}`,
      );

      const { docs, usedOcr, strategy } =
        await loadPdfDocumentsForPreview(filePath);
      const fullText = docs.map((doc) => doc.pageContent || "").join("\n\n");
      const extractedMetadata = extractAutoMetadata(fullText, docType);
      const reviewToken = randomUUID();

      reviewSessions.set(reviewToken, {
        filePath,
        fileName: req.file.filename,
        originalName: req.file.originalname,
        docType,
        reviewDocs: docs,
        createdAt: Date.now(),
        expiresAt: Date.now() + REVIEW_TTL_MS,
      });

      console.log(
        `[preview] completed | file=${req.file.originalname} | strategy=${strategy} | docs=${docs.length}`,
      );

      return res.status(200).json({
        ok: true,
        message:
          "Document uploaded and extracted. Please review before approval.",
        reviewToken,
        extracted: {
          metadata: extractedMetadata,
          pages: buildReviewPages(docs),
          pdfUrl: `/uploads/${encodeURIComponent(req.file.filename)}`,
          strategy,
          usedOcr,
        },
      });
    } catch (error) {
      console.error(
        `[preview] failed | file=${req.file?.originalname || "unknown"} | message=${error.message || error}`,
      );

      if (filePath) {
        await fs.rm(filePath, { force: true });
      }

      return res.status(400).json({
        ok: false,
        message: error.message || "Preview extraction failed.",
      });
    }
  },
);

app.post("/api/upload-document/approve", async (req, res) => {
  try {
    await pruneExpiredReviewSessions();

    const reviewToken = String(req.body.reviewToken || "").trim();
    if (!reviewToken) {
      throw new Error("reviewToken is required.");
    }

    const reviewSession = reviewSessions.get(reviewToken);
    if (!reviewSession) {
      throw new Error(
        "Review session not found or expired. Please upload and preview again.",
      );
    }

    const metadata = buildMetadata({
      ...(req.body.metadata || {}),
      docType: reviewSession.docType,
    });
    const editedPages = Array.isArray(req.body.editedPages)
      ? req.body.editedPages
      : [];

    const reviewDocs = reviewSession.reviewDocs || [];
    const rawDocsOverride = reviewDocs.length
      ? buildEditedDocs(reviewDocs, editedPages)
      : null;

    validateMetadataForIngest(metadata);

    const result = await ingestLegalDocument({
      pdfPath: reviewSession.filePath,
      metadata,
      rawDocsOverride,
      logger: console,
    });

    await clearReviewSession(reviewToken);

    return res.status(200).json({
      ok: true,
      message: "Document approved and indexed successfully.",
      result,
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      message: error.message || "Approval failed.",
    });
  }
});

app.post("/api/upload-document/reject", async (req, res) => {
  try {
    const reviewToken = String(req.body.reviewToken || "").trim();
    if (!reviewToken) {
      throw new Error("reviewToken is required.");
    }

    if (!reviewSessions.has(reviewToken)) {
      throw new Error("Review session not found or already cleared.");
    }

    await clearReviewSession(reviewToken);
    return res.status(200).json({
      ok: true,
      message: "Draft upload discarded.",
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      message: error.message || "Could not discard draft upload.",
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
