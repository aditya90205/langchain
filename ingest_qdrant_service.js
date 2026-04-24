import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { QdrantClient } from "@qdrant/js-client-rest";
import { Document } from "@langchain/core/documents";
import { loadPdfDocumentsForIndexing } from "./pdf_loader_with_ocr.js";
import { structureLegalDocuments } from "./legal_document_structurer.js";

const BATCH_SIZE = Number(process.env.INGEST_BATCH_SIZE || 15);
const BATCH_DELAY_MS = Number(process.env.INGEST_BATCH_DELAY_MS || 6000);

function getQdrantCollections(baseCollection) {
  return {
    caseParagraphs:
      process.env.QDRANT_CASE_PARAGRAPHS_COLLECTION ||
      `${baseCollection}_case_paragraphs`,
    caseHeadnotes:
      process.env.QDRANT_CASE_HEADNOTES_COLLECTION ||
      `${baseCollection}_case_headnotes`,
    bareActSections:
      process.env.QDRANT_BARE_ACT_SECTIONS_COLLECTION ||
      `${baseCollection}_bare_act_sections`,
  };
}

function resolveQdrantConfig() {
  const localFlag = (process.env.QDRANT_USE_LOCAL || "").toLowerCase();
  const isLocal = localFlag === "true" || localFlag === "1";
  const url =
    process.env.QDRANT_URL || (isLocal ? "http://127.0.0.1:6333" : "");

  if (!url) {
    throw new Error(
      "Missing Qdrant URL. Set QDRANT_URL or enable QDRANT_USE_LOCAL=true.",
    );
  }

  if (isLocal) {
    return {
      url,
      apiKey: undefined,
      isLocal,
      client: new QdrantClient({
        url,
        checkCompatibility: false,
      }),
    };
  }

  if (!process.env.QDRANT_API_KEY) {
    throw new Error(
      "Missing Qdrant API key for cloud mode. Set QDRANT_API_KEY or enable QDRANT_USE_LOCAL=true for local testing.",
    );
  }

  return {
    url,
    apiKey: process.env.QDRANT_API_KEY,
    isLocal,
    client: new QdrantClient({
      url,
      apiKey: process.env.QDRANT_API_KEY,
      checkCompatibility: false,
    }),
  };
}

async function upsertCollectionBatches(
  embeddings,
  qdrantConfig,
  collectionName,
  docs,
  logger,
) {
  if (!docs.length) {
    return 0;
  }

  logger.log(
    `\nIngesting ${docs.length} chunks into Qdrant collection: ${collectionName}`,
  );

  let insertedCount = 0;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const chunkBatch = docs.slice(i, i + BATCH_SIZE);
    const batchNo = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(docs.length / BATCH_SIZE);

    let success = false;
    let attempts = 0;

    while (!success && attempts < 3) {
      try {
        logger.log(
          `Collection ${collectionName} | batch ${batchNo}/${totalBatches} (${chunkBatch.length} docs)`,
        );

        await QdrantVectorStore.fromDocuments(chunkBatch, embeddings, {
          client: qdrantConfig.client,
          collectionName,
          clientOptions: {
            timeout: 30000,
            checkCompatibility: false,
          },
        });

        insertedCount += chunkBatch.length;
        success = true;
      } catch (error) {
        attempts += 1;
        if (attempts >= 3) {
          logger.error(
            `Failed collection ${collectionName} batch ${batchNo} after 3 attempts:`,
            error.message || error,
          );
        } else {
          logger.warn(
            `Retry ${attempts}/3 for collection ${collectionName} batch ${batchNo}...`,
          );
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }

    if (i + BATCH_SIZE < docs.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return insertedCount;
}

function applyReviewedPageEdits(rawDocs, editedPages = []) {
  const editedMap = new Map(
    (Array.isArray(editedPages) ? editedPages : [])
      .map((page) => ({
        pageNo: Number(page.page),
        text: String(page.text || "").trim(),
      }))
      .filter((entry) => entry.pageNo > 0 && entry.text.length > 0)
      .map((entry) => [entry.pageNo, entry.text]),
  );

  if (!editedMap.size) {
    return rawDocs;
  }

  return rawDocs.map((doc, idx) => {
    const pageNo = Number(doc.metadata?.page || idx + 1);
    const editedText = editedMap.get(pageNo);
    if (!editedText) {
      return doc;
    }

    return new Document({
      pageContent: editedText,
      metadata: {
        ...(doc.metadata || {}),
        reviewed: true,
        edited: true,
      },
    });
  });
}

export async function ingestLegalDocument({
  pdfPath,
  metadata,
  editedPages,
  logger = console,
}) {
  if (!pdfPath) {
    throw new Error("pdfPath is required for ingestion.");
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "Missing GEMINI_API_KEY. Please add GEMINI_API_KEY to your .env file.",
    );
  }

  const qdrantConfig = resolveQdrantConfig();
  logger.log("Starting structured legal data ingestion for Qdrant...");

  const loaded = await loadPdfDocumentsForIndexing(pdfPath);
  let rawDocs = loaded.docs;
  const usedOcr = loaded.usedOcr;
  let strategy = loaded.strategy;

  rawDocs = applyReviewedPageEdits(rawDocs, editedPages);
  if (Array.isArray(editedPages) && editedPages.length > 0) {
    strategy = `${strategy}+manual-page-edits`;
  }

  logger.log(
    `PDF processed with strategy: ${strategy}. Total pages/sections: ${rawDocs.length}`,
  );

  if (usedOcr) {
    logger.log("OCR path enabled (Azure Document Intelligence).");
  }

  const structured = await structureLegalDocuments(rawDocs, pdfPath, metadata);

  logger.log(
    `Structuring completed. DocType=${structured.docType} | total structured chunks=${structured.totalStructured}`,
  );

  if (!structured.totalStructured) {
    throw new Error("No legal chunks generated. Nothing to index.");
  }

  const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: process.env.GEMINI_API_KEY,
    modelName: "gemini-embedding-001",
    maxBatchSize: 15,
  });

  const baseCollection =
    process.env.QDRANT_COLLECTION_NAME ||
    (qdrantConfig.isLocal ? "test_collection" : "legal_collection");
  const collectionNames = getQdrantCollections(baseCollection);

  logger.log(
    `Connecting to Qdrant ${qdrantConfig.isLocal ? "Local" : "Cloud"} at ${qdrantConfig.url}`,
  );

  let insertedCount = 0;
  insertedCount += await upsertCollectionBatches(
    embeddings,
    qdrantConfig,
    collectionNames.caseParagraphs,
    structured.caseParagraphs,
    logger,
  );
  insertedCount += await upsertCollectionBatches(
    embeddings,
    qdrantConfig,
    collectionNames.caseHeadnotes,
    structured.caseHeadnotes,
    logger,
  );
  insertedCount += await upsertCollectionBatches(
    embeddings,
    qdrantConfig,
    collectionNames.bareActSections,
    structured.bareActSections,
    logger,
  );

  return {
    insertedCount,
    strategy,
    usedOcr,
    docType: structured.docType,
    chunks: {
      caseParagraphs: structured.caseParagraphs.length,
      caseHeadnotes: structured.caseHeadnotes.length,
      bareActSections: structured.bareActSections.length,
      total: structured.totalStructured,
    },
    collections: collectionNames,
  };
}
