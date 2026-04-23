import * as dotenv from "dotenv";
dotenv.config();
import readlineSync from "readline-sync";
import { Document } from "@langchain/core/documents";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantClient } from "@qdrant/js-client-rest";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({});
const History = [];

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

const COLLECTION_WEIGHTS = {
  caseParagraphs: 1,
  caseHeadnotes: 0.94,
  bareActSections: 0.9,
};

function formatEvidence(metadata, text) {
  const citation = metadata?.citation || "Citation not available";
  const caseName = metadata?.case_name || "Case name not available";
  const court = metadata?.court || "Unknown court";
  const sectionNo = metadata?.section_no
    ? `Section ${metadata.section_no}`
    : "";
  const paraNo = metadata?.paragraph_no ? `Para ${metadata.paragraph_no}` : "";
  const source = [sectionNo, paraNo].filter(Boolean).join(" | ");

  return `Case: ${caseName}\nCitation: ${citation}\nCourt: ${court}\nRef: ${source || "N/A"}\nText: ${text}`;
}

async function queryCollection(
  qdrantConfig,
  embeddings,
  collectionName,
  query,
  k,
) {
  try {
    const queryEmbedding = await embeddings.embedQuery(query);
    const results = await qdrantConfig.client.search(collectionName, {
      vector: queryEmbedding,
      limit: k,
      with_payload: true,
      with_vector: false,
      timeout: 30,
    });

    return results.map((point) => [
      new Document({
        pageContent: point.payload?.content || "",
        metadata: point.payload?.metadata || {},
      }),
      point.score,
    ]);
  } catch (error) {
    console.error(
      `Qdrant search failed for ${collectionName}:`,
      error.message || error,
    );
    return [];
  }
}

async function transformQuery(question) {
  History.push({
    role: "user",
    parts: [{ text: question }],
  });

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: History,
    config: {
      systemInstruction: `You are a query rewriting expert. Based on the provided chat history, rephrase the "Follow Up user Question" into a complete, standalone question that can be understood without the chat history.
    Only output the rewritten question and nothing else.
      `,
    },
  });

  History.pop();

  return response.text;
}

async function chatting(question) {
  const queries = await transformQuery(question);

  const qdrantConfig = resolveQdrantConfig();

  const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: process.env.GEMINI_API_KEY,
    modelName: "gemini-embedding-001",
  });

  const baseCollection =
    process.env.QDRANT_COLLECTION_NAME ||
    (qdrantConfig.isLocal ? "test_collection" : "legal_collection");
  const collections = getQdrantCollections(baseCollection);

  const [paragraphHits, headnoteHits, actHits] = await Promise.all([
    queryCollection(
      qdrantConfig,
      embeddings,
      collections.caseParagraphs,
      queries,
      8,
    ),
    queryCollection(
      qdrantConfig,
      embeddings,
      collections.caseHeadnotes,
      queries,
      6,
    ),
    queryCollection(
      qdrantConfig,
      embeddings,
      collections.bareActSections,
      queries,
      6,
    ),
  ]);

  const merged = [
    ...paragraphHits.map(([doc, score]) => ({
      doc,
      score: Number(score || 0) * COLLECTION_WEIGHTS.caseParagraphs,
    })),
    ...headnoteHits.map(([doc, score]) => ({
      doc,
      score: Number(score || 0) * COLLECTION_WEIGHTS.caseHeadnotes,
    })),
    ...actHits.map(([doc, score]) => ({
      doc,
      score: Number(score || 0) * COLLECTION_WEIGHTS.bareActSections,
    })),
  ]
    .filter(({ doc }) => doc?.pageContent)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const context = merged
    .map(({ doc }) => formatEvidence(doc.metadata || {}, doc.pageContent))
    .join("\n\n---\n\n");

  if (!context.trim()) {
    console.log("No legal evidence found for this query.");
    return;
  }

  History.push({
    role: "user",
    parts: [{ text: queries }],
  });

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: History,
    config: {
      systemInstruction: `You are an Indian legal research assistant for advocates.
    Use ONLY the provided legal evidence.
    Do not invent case names or citations.
    If evidence is insufficient, say so clearly.
    Format answer as:
    1) Issue
    2) Rule (Act/Section)
    3) Application (2-5 cited authorities)
    4) Conclusion
    5) Citations Used
      
      Context: ${context}
      `,
    },
  });

  History.push({
    role: "model",
    parts: [{ text: response.text }],
  });

  console.log("\n");
  console.log(response.text);
}

async function main() {
  try {
    resolveQdrantConfig();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error("❌ Need to set GEMINI_API_KEY in the .env file");
    process.exit(1);
  }

  const userProblem = readlineSync.question("Ask me anything--> ");
  await chatting(userProblem);
  main();
}

main();
