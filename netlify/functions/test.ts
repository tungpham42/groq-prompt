import { Handler } from "@netlify/functions";
import Groq from "groq-sdk";
import { EventEmitter } from "events";

// Initialize Groq Client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY_TEST,
});

const MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ==========================================
// 1. EVENT BUS (PUB/SUB BROKER)
// ==========================================
const aiEventBus = new EventEmitter();

// ==========================================
// 2. SUBSCRIBERS
// ==========================================
aiEventBus.on("model:attempt", ({ index, model }) => {
  console.log(`[Attempt ${index + 1}/${MODELS.length}] Using model: ${model}`);
});

aiEventBus.on("model:failed", ({ model, status, message }) => {
  console.warn(
    `[Fail] Model ${model} failed. Status: ${status}. Message: ${message}`,
  );
});

aiEventBus.on("model:rate_limit", ({ waitTime }) => {
  console.log(`[Rate Limit] Waiting ${waitTime}ms before switching models...`);
});

aiEventBus.on("model:switching", () => {
  console.log(`>>> Switching to next model...`);
});

aiEventBus.on("generation:success", ({ model }) => {
  console.log(`[Success] Content successfully generated using ${model}.`);
});

// ==========================================
// 3. PUBLISHER (LLM GENERATOR)
// ==========================================
async function generateWithFallback(
  prompt: string,
  index = 0,
): Promise<{ result: string }> {
  if (index >= MODELS.length) {
    throw new Error(
      "All AI models failed due to rate limits, server errors, or invalid model names.",
    );
  }

  const currentModel = MODELS[index];

  aiEventBus.emit("model:attempt", { index, model: currentModel });

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: currentModel,
      temperature: 0.5,
      max_tokens: 5000,
    });

    aiEventBus.emit("generation:success", { model: currentModel });

    return {
      result: chatCompletion.choices[0]?.message?.content || "",
    };
  } catch (error: any) {
    const status = error.status || error.statusCode || 500;

    aiEventBus.emit("model:failed", {
      model: currentModel,
      status,
      message: error.message,
    });

    if (
      status === 429 ||
      status === 404 ||
      status === 400 ||
      (status >= 500 && status < 600)
    ) {
      if (status === 429) {
        const retryHeader = error?.headers?.["retry-after"];
        const waitTime = retryHeader ? parseInt(retryHeader) * 1000 : 1000;

        aiEventBus.emit("model:rate_limit", { waitTime });
        await sleep(waitTime);
      } else {
        aiEventBus.emit("model:switching");
      }

      return await generateWithFallback(prompt, index + 1);
    }

    throw error;
  }
}

// ==========================================
// 4. MAIN HTTP HANDLER
// ==========================================
export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "OK" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Method Not Allowed. Use POST." }),
    };
  }

  try {
    if (!event.body) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Request body is empty." }),
      };
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Invalid JSON in request body." }),
      };
    }

    const prompt = body.prompt;
    if (!prompt) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Missing 'prompt'." }),
      };
    }

    // Step 1: Send to the LLM directly
    const result = await generateWithFallback(prompt);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result),
    };
  } catch (error: any) {
    console.error("Critical Failure:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: error.message || "Internal Server Error",
        details: "Global failure across all available models.",
      }),
    };
  }
};
