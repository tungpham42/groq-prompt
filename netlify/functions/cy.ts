import { Handler } from "@netlify/functions";
import Groq from "groq-sdk";
import { EventEmitter } from "events";

// Initialize Groq Client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY_CY,
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
// 3. WEB SEARCH FUNCTION
// ==========================================
async function fetchWebContext(query: string): Promise<string> {
  try {
    const apiKey = process.env.TAVILY_API_KEY_CY;
    if (!apiKey) {
      console.warn("Missing TAVILY_API_KEY_CY. Skipping web search.");
      return "";
    }

    console.log(`[Search] Querying Tavily for: "${query}"`);

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: "advanced",
        include_answer: true,
        max_results: 5,
      }),
    });

    if (!response.ok) {
      throw new Error(`Tavily API Error: ${response.statusText}`);
    }

    const data = await response.json();

    // Format the results into a clean string for the LLM
    let context = "";
    if (data.answer) {
      context += `Summary Answer: ${data.answer}\n\n`;
    }

    if (data.results && data.results.length > 0) {
      context += "Detailed Sources:\n";
      context += data.results
        .map(
          (r: any) =>
            `- Title: ${r.title}\n  URL: ${r.url}\n  Content: ${r.content}`,
        )
        .join("\n\n");
    }

    return context || "No highly relevant information found on the internet.";
  } catch (error) {
    console.error("Failed to fetch web data:", error);
    return ""; // Return empty string so the chatbot still works using its base knowledge
  }
}

// ==========================================
// 4. PUBLISHER (LLM GENERATOR)
// ==========================================
async function generateWithFallback(
  prompt: string,
  index = 0,
): Promise<{ result: string; used_model: string }> {
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
      temperature: 1,
      max_tokens: 6144,
    });

    aiEventBus.emit("generation:success", { model: currentModel });

    return {
      result: chatCompletion.choices[0]?.message?.content || "",
      used_model: currentModel,
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
// 5. MAIN HTTP HANDLER
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

    // Step 1: Fetch web context based on the user's prompt
    const webContext = await fetchWebContext(prompt);

    // Step 2: Construct the final augmented prompt
    let finalPrompt = prompt;
    if (
      webContext &&
      webContext !== "No highly relevant information found on the internet."
    ) {
      finalPrompt = `You have been provided with the following live web context to help answer the user's query.\n\nWeb Context:\n${webContext}\n\nUser Query:\n${prompt}`;
    }

    // Step 3: Send to the LLM
    const result = await generateWithFallback(finalPrompt);

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
