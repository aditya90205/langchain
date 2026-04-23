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

async function extractWithAzureOcr(pdfPath) {
  const endpoint = getRequiredEnv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT");
  const key = getRequiredEnv("AZURE_DOCUMENT_INTELLIGENCE_KEY");
  const renderDpi = Number(
    process.env.AZURE_OCR_RENDER_DPI || DEFAULT_OCR_RENDER_DPI,
  );

  const client = new DocumentAnalysisClient(
    endpoint,
    new AzureKeyCredential(key),
  );
  const pageCount = await getPdfPageCount(pdfPath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-ocr-"));
  const docs = [];

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const renderedPagePath = await renderSinglePdfPage(
        pdfPath,
        tempDir,
        pageNumber,
        renderDpi,
      );
      const imageBuffer = await fs.readFile(renderedPagePath);
      const poller = await client.beginAnalyzeDocument(
        "prebuilt-read",
        imageBuffer,
      );
      const result = await poller.pollUntilDone();
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
  const pdfLoader = new PDFLoader(pdfPath);
  const rawDocs = await pdfLoader.load();

  if (!shouldRunOcr(rawDocs)) {
    return {
      docs: rawDocs,
      usedOcr: false,
      strategy: "native-pdf-text",
    };
  }

  const ocrDocs = await extractWithAzureOcr(pdfPath);
  return {
    docs: ocrDocs,
    usedOcr: true,
    strategy: "azure-document-intelligence-ocr",
  };
}
