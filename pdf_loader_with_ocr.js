import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { Document } from "@langchain/core/documents";
import { DocumentAnalysisClient } from "@azure/ai-form-recognizer";
import { AzureKeyCredential } from "@azure/core-auth";

const execFileAsync = promisify(execFile);

const MIN_MEAN_TEXT_LENGTH = 40;
const MIN_NON_EMPTY_PAGE_RATIO = 0.7;
const DEFAULT_OCR_RENDER_DPI = 120;
const DEFAULT_OCR_PAGE_TIMEOUT_MS = 20000;

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env variable: ${name}`);
  }
  return value;
}

function shouldRunOcr(rawDocs) {
  if ((process.env.FORCE_OCR || "").toLowerCase() === "true") {
    return true;
  }

  if (!rawDocs.length) {
    return true;
  }

  const lengths = rawDocs.map((doc) => (doc.pageContent || "").trim().length);
  const nonEmptyPages = lengths.filter((len) => len > 0).length;
  const meanLength =
    lengths.reduce((sum, len) => sum + len, 0) / lengths.length;
  const nonEmptyRatio = nonEmptyPages / lengths.length;

  return (
    meanLength < MIN_MEAN_TEXT_LENGTH ||
    nonEmptyRatio < MIN_NON_EMPTY_PAGE_RATIO
  );
}

function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]);
}

async function extractWithAzureOcr(pdfPath, options = {}) {
  const endpoint = getRequiredEnv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT");
  const key = getRequiredEnv("AZURE_DOCUMENT_INTELLIGENCE_KEY");
  const renderDpi = Number(
    process.env.AZURE_OCR_RENDER_DPI || DEFAULT_OCR_RENDER_DPI,
  );
  const maxPages = Number(options.maxPages || 0);
  const perPageTimeoutMs = Number(
    options.perPageTimeoutMs ||
      process.env.AZURE_OCR_PER_PAGE_TIMEOUT_MS ||
      DEFAULT_OCR_PAGE_TIMEOUT_MS,
  );

  const client = new DocumentAnalysisClient(
    endpoint,
    new AzureKeyCredential(key),
  );
  const pageCount = await getPdfPageCount(pdfPath);
  const targetPageCount =
    Number.isFinite(maxPages) && maxPages > 0
      ? Math.min(pageCount, maxPages)
      : pageCount;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-ocr-"));
  const docs = [];

  try {
    for (let pageNumber = 1; pageNumber <= targetPageCount; pageNumber += 1) {
      const renderedPagePath = await renderSinglePdfPage(
        pdfPath,
        tempDir,
        pageNumber,
        renderDpi,
      );
      const imageBuffer = await fs.readFile(renderedPagePath);
      const poller = await withTimeout(
        client.beginAnalyzeDocument("prebuilt-read", imageBuffer),
        perPageTimeoutMs,
        `OCR submit page ${pageNumber}`,
      );
      const result = await withTimeout(
        poller.pollUntilDone(),
        perPageTimeoutMs,
        `OCR process page ${pageNumber}`,
      );
      const pageText = (result?.pages || [])
        .flatMap((page) => page.lines || [])
        .map((line) => line.content)
        .join("\n")
        .trim();

      if (!pageText) {
        console.warn(
          `⚠️ Azure OCR returned no text for page ${pageNumber}. Skipping empty page.`,
        );
        continue;
      }

      docs.push(
        new Document({
          pageContent: pageText,
          metadata: {
            source: pdfPath,
            page: pageNumber,
            extractedBy: "azure-document-intelligence",
            renderedDpi: renderDpi,
          },
        }),
      );
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  if (!docs.length) {
    throw new Error(
      "Azure OCR completed but extracted text was empty on all pages",
    );
  }

  return docs;
}

async function getPdfPageCount(pdfPath) {
  const pdfInfo = await execFileAsync("pdfinfo", [pdfPath]);
  const match = String(pdfInfo.stdout).match(/^Pages:\s+(\d+)/m);

  if (!match) {
    throw new Error(`Could not determine page count for ${pdfPath}`);
  }

  return Number(match[1]);
}

async function renderSinglePdfPage(pdfPath, tempDir, pageNumber, renderDpi) {
  const outputPrefix = path.join(tempDir, `page-${pageNumber}`);

  await execFileAsync("pdftoppm", [
    "-singlefile",
    "-f",
    String(pageNumber),
    "-l",
    String(pageNumber),
    "-r",
    String(renderDpi),
    "-png",
    pdfPath,
    outputPrefix,
  ]);

  return `${outputPrefix}.png`;
}

export async function loadPdfDocumentsForIndexing(pdfPath) {
  return loadPdfDocuments(pdfPath, {});
}

export async function loadPdfDocumentsForPreview(pdfPath, options = {}) {
  const maxPages =
    options.maxPages === undefined
      ? Number(process.env.PREVIEW_MAX_PAGES || 0)
      : Number(options.maxPages || 0);
  return loadPdfDocuments(pdfPath, {
    maxPages,
    ocrMaxPages: maxPages,
    perPageTimeoutMs: Number(options.perPageTimeoutMs || 12000),
  });
}

async function loadPdfDocuments(pdfPath, options = {}) {
  const pdfLoader = new PDFLoader(pdfPath);
  const rawDocs = await pdfLoader.load();
  const maxPages = Number(options.maxPages || 0);
  const limitedRawDocs =
    Number.isFinite(maxPages) && maxPages > 0
      ? rawDocs.slice(0, maxPages)
      : rawDocs;

  if (!shouldRunOcr(limitedRawDocs)) {
    return {
      docs: limitedRawDocs,
      usedOcr: false,
      strategy: "native-pdf-text",
    };
  }

  try {
    const ocrDocs = await extractWithAzureOcr(pdfPath, {
      maxPages: Number(options.ocrMaxPages || maxPages || 0),
      perPageTimeoutMs: options.perPageTimeoutMs,
    });
    return {
      docs: ocrDocs,
      usedOcr: true,
      strategy: "azure-document-intelligence-ocr",
    };
  } catch (error) {
    console.warn(
      `OCR fallback activated for ${path.basename(pdfPath)}: ${error.message || error}`,
    );
    return {
      docs: limitedRawDocs,
      usedOcr: false,
      strategy: "native-pdf-text-fallback",
    };
  }
}
