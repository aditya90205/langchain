import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

export const LEGAL_NAMESPACE_CONFIG = {
  caseParagraphs:
    process.env.PINECONE_NS_CASE_PARAGRAPHS || "legal_case_paragraphs",
  caseHeadnotes:
    process.env.PINECONE_NS_CASE_HEADNOTES || "legal_case_headnotes",
  bareActSections:
    process.env.PINECONE_NS_BARE_ACT_SECTIONS || "legal_bare_act_sections",
};

function sanitizeText(text) {
  return String(text || "")
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildBaseMetadata(sourcePath, metadataOverrides = {}) {
  return {
    source: sourcePath,
    legal_doc_type: String(
      metadataOverrides.legal_doc_type ||
        process.env.LEGAL_DOC_TYPE ||
        "case_law",
    ).toLowerCase(),
    act_name: metadataOverrides.act_name || process.env.LEGAL_ACT_NAME || "",
    section_no:
      metadataOverrides.section_no || process.env.LEGAL_SECTION_NO || "",
    case_name: metadataOverrides.case_name || process.env.LEGAL_CASE_NAME || "",
    citation: metadataOverrides.citation || process.env.LEGAL_CITATION || "",
    court: metadataOverrides.court || process.env.LEGAL_COURT || "",
    bench: metadataOverrides.bench || process.env.LEGAL_BENCH || "",
    judgment_date:
      metadataOverrides.judgment_date || process.env.LEGAL_DATE || "",
    jurisdiction:
      metadataOverrides.jurisdiction ||
      process.env.LEGAL_JURISDICTION ||
      "India",
  };
}

function splitCaseParagraphs(rawDocs, baseMetadata) {
  const chunks = [];
  for (const doc of rawDocs) {
    const pageText = sanitizeText(doc.pageContent);
    if (!pageText) continue;

    const blocks = pageText
      .split(/\n{2,}/)
      .map((value) => sanitizeText(value))
      .filter((value) => value.length >= 80);

    for (let idx = 0; idx < blocks.length; idx += 1) {
      chunks.push(
        new Document({
          pageContent: blocks[idx],
          metadata: {
            ...baseMetadata,
            ...(doc.metadata || {}),
            chunk_type: "case_paragraph",
            paragraph_no: idx + 1,
          },
        }),
      );
    }
  }
  return chunks;
}

function buildHeadnoteCandidates(caseParagraphDocs) {
  const selected = caseParagraphDocs
    .slice(0, 12)
    .filter((doc) => doc.pageContent.length >= 120)
    .slice(0, 6);

  return selected.map(
    (doc, idx) =>
      new Document({
        pageContent: doc.pageContent,
        metadata: {
          ...doc.metadata,
          chunk_type: "case_headnote",
          headnote_no: idx + 1,
        },
      }),
  );
}

function splitBareActSections(rawDocs, baseMetadata) {
  const fullText = sanitizeText(
    rawDocs.map((doc) => doc.pageContent).join("\n"),
  );
  const regex =
    /(section\s+\d+[a-zA-Z\-]*\.?[^\n]*)([\s\S]*?)(?=\n\s*section\s+\d+[a-zA-Z\-]*\.?|$)/gi;
  const sections = [];
  let match = regex.exec(fullText);

  while (match) {
    const heading = sanitizeText(match[1]);
    const body = sanitizeText(match[2]);
    const sectionNumberMatch = heading.match(/section\s+([\dA-Za-z\-]+)/i);

    if (body.length > 30) {
      sections.push(
        new Document({
          pageContent: `${heading}\n${body}`,
          metadata: {
            ...baseMetadata,
            chunk_type: "bare_act_section",
            section_no: sectionNumberMatch
              ? sectionNumberMatch[1]
              : baseMetadata.section_no,
          },
        }),
      );
    }

    match = regex.exec(fullText);
  }

  return sections;
}

async function fallbackSplit(rawDocs, baseMetadata, chunkType) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 900,
    chunkOverlap: 150,
  });
  const chunks = await splitter.splitDocuments(rawDocs);

  return chunks.map(
    (doc, idx) =>
      new Document({
        pageContent: sanitizeText(doc.pageContent),
        metadata: {
          ...baseMetadata,
          ...(doc.metadata || {}),
          chunk_type: chunkType,
          fallback_chunk_no: idx + 1,
        },
      }),
  );
}

export async function structureLegalDocuments(
  rawDocs,
  sourcePath,
  metadataOverrides = {},
) {
  const baseMetadata = buildBaseMetadata(sourcePath, metadataOverrides);
  const docType = baseMetadata.legal_doc_type;

  let caseParagraphs = [];
  let caseHeadnotes = [];
  let bareActSections = [];

  if (docType === "bare_act") {
    bareActSections = splitBareActSections(rawDocs, baseMetadata);
    if (!bareActSections.length) {
      bareActSections = await fallbackSplit(
        rawDocs,
        baseMetadata,
        "bare_act_section",
      );
    }
  } else {
    caseParagraphs = splitCaseParagraphs(rawDocs, baseMetadata);
    if (!caseParagraphs.length) {
      caseParagraphs = await fallbackSplit(
        rawDocs,
        baseMetadata,
        "case_paragraph",
      );
    }
    caseHeadnotes = buildHeadnoteCandidates(caseParagraphs);
  }

  return {
    docType,
    caseParagraphs,
    caseHeadnotes,
    bareActSections,
    totalStructured:
      caseParagraphs.length + caseHeadnotes.length + bareActSections.length,
  };
}
