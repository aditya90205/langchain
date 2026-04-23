import * as dotenv from "dotenv";
dotenv.config();
import { ingestLegalDocument } from "./ingest_qdrant_service.js";

async function indexDocument() {
  const PDF_PATH = process.env.PDF_PATH || "./dsa.pdf";
  const metadata = {
    legal_doc_type: process.env.LEGAL_DOC_TYPE || "case_law",
    act_name: process.env.LEGAL_ACT_NAME || "",
    section_no: process.env.LEGAL_SECTION_NO || "",
    case_name: process.env.LEGAL_CASE_NAME || "",
    citation: process.env.LEGAL_CITATION || "",
    court: process.env.LEGAL_COURT || "",
    bench: process.env.LEGAL_BENCH || "",
    judgment_date: process.env.LEGAL_DATE || "",
    jurisdiction: process.env.LEGAL_JURISDICTION || "India",
  };

  try {
    await ingestLegalDocument({
      pdfPath: PDF_PATH,
      metadata,
      logger: console,
    });
  } catch (error) {
    console.error(`❌ ${error.message || error}`);
    process.exit(1);
  }
}

indexDocument();
