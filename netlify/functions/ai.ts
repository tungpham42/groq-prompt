import { Handler } from "@netlify/functions";
import Groq from "groq-sdk";

// Initialize Groq Client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Priority Queue of Models (Updated to real Groq Model IDs)
const MODELS = [
  "openai/gpt-oss-120b", // 1. Primary High-Intelligence Model
  "openai/gpt-oss-20b", // 2. High-Quality Fallback
  "llama-3.3-70b-versatile", // 3. Fast/Efficient Fallback
  "llama-3.1-8b-instant", // 4. "Last Resort" Instant Model
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * Utility to pause execution for a set time (ms)
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Recursive function to attempt generation with a list of models.
 */
async function generateWithFallback(
  prompt: string,
  index = 0,
): Promise<{ result: string; used_model: string }> {
  // BASE CASE: All models failed
  if (index >= MODELS.length) {
    throw new Error(
      "All AI models failed due to rate limits, server errors, or invalid model names.",
    );
  }

  const currentModel = MODELS[index];
  console.log(
    `[Attempt ${index + 1}/${MODELS.length}] Using model: ${currentModel}`,
  );

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: currentModel,
      temperature: 0.9,
      max_tokens: 4096,
    });

    return {
      result: chatCompletion.choices[0]?.message?.content || "",
      used_model: currentModel,
    };
  } catch (error: any) {
    const status = error.status || error.statusCode || 500;

    // ERROR LOGGING
    console.warn(
      `[Fail] Model ${currentModel} failed. Status: ${status}. Message: ${error.message}`,
    );

    // RECURSIVE SWITCH LOGIC
    if (
      status === 429 ||
      status === 404 ||
      status === 400 ||
      (status >= 500 && status < 600)
    ) {
      // SPECIAL HANDLING FOR RATE LIMITS (429)
      if (status === 429) {
        // Parse 'retry-after' header (usually in seconds) or default to 1 second
        const retryHeader = error?.headers?.["retry-after"];
        const waitTime = retryHeader ? parseInt(retryHeader) * 1000 : 1000;

        console.log(
          `[Rate Limit] Waiting ${waitTime}ms before switching models...`,
        );
        await sleep(waitTime);
      } else {
        console.log(`>>> Switching to next model...`);
      }

      return await generateWithFallback(prompt, index + 1);
    }

    // Throw on critical auth errors (401) so we don't retry endlessly on bad keys
    throw error;
  }
}

export const handler: Handler = async (event) => {
  // 1. Handle CORS Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "OK" };
  }

  // 2. Validate Method
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Method Not Allowed. Use POST." }),
    };
  }

  try {
    // 3. SAFE PARSING (Fixes "undefined is not valid JSON")
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
        body: JSON.stringify({ error: "Missing 'prompt' in request body." }),
      };
    }

    // 4. Run Recursive Generation
    const result = await generateWithFallback(prompt);

    // 5. Return Success
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
