import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import crypto from "node:crypto";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    redact: [
      "req.headers.authorization",
      "headers.authorization"
    ]
  },
  bodyLimit: 25 * 1024 * 1024,
  requestTimeout: 10 * 60 * 1000
});

await app.register(cors, {
  origin: true
});

await app.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX || 120),
  timeWindow: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000)
});

const CONFIG = {
  port: Number(process.env.PORT || 8000),
  host: process.env.HOST || "0.0.0.0",

  coreSecret: process.env.NEXTURA_CORE_SECRET || "",

  gonkaKey: process.env.GONKA_API_KEY || "",
  gonkaBaseUrl:
    process.env.GONKA_BASE_URL || "https://gate.joingonka.ai",
  gonkaModelPro:
    process.env.GONKA_MODEL_PRO || "MiniMaxAI/MiniMax-M2.7",
  gonkaModelCode:
    process.env.GONKA_MODEL_CODE || "MiniMaxAI/MiniMax-M2.7",

  cometKey: process.env.COMET_API_KEY || "",
  cometBaseUrl:
    process.env.COMET_BASE_URL || "https://api.cometapi.com/v1",
  cometVisionModel:
    process.env.COMET_VISION_MODEL || "gpt-5-nano-2025-08-07",
  cometFluxUrl:
    process.env.COMET_FLUX_URL ||
    "https://api.cometapi.com/flux/v1/flux-2-pro",
  cometFluxResultUrl:
    process.env.COMET_FLUX_RESULT_URL ||
    "https://api.cometapi.com/flux/v1/get_result",

  developer: process.env.NEXTURA_DEVELOPER || "Nextura",
  locationUrl:
    process.env.NEXTURA_LOCATION_URL ||
    "https://www.google.com/maps/search/?api=1&query=-6.84438919994596%2C108.76386257925714",

  agentSearch:
    (process.env.ENABLE_AGENT_SEARCH || "true") === "true",
  deepThinking:
    (process.env.ENABLE_DEEP_THINKING || "true") === "true",

  maxOutputTokens: Number(
    process.env.MAX_OUTPUT_TOKENS || 16384
  )
};

const PUBLIC_MODELS = {
  "Nextura/cortexa-pro": {
    name: "Nextura Cortexa Pro",
    vision: false,
    imageGeneration: false,
    code: true
  },

  "Nextura/cortexa-max": {
    name: "Nextura Cortexa Max",
    vision: true,
    imageGeneration: true,
    code: true
  },

  "Nextura/cortexa-code": {
    name: "Nextura Cortexa Code",
    vision: false,
    imageGeneration: false,
    code: true
  }
};

const IDENTITY_PROMPT = `
Kamu adalah Nextura AI.

Identitas resmi:
- Nama: Nextura AI
- Keluarga model: Nextura Cortexa
- Developer: ${CONFIG.developer}
- Bahasa default: Bahasa Indonesia

Aturan:
1. Jangan mengaku sebagai ChatGPT, OpenAI, Claude, Anthropic,
   Gemini, Google, MiniMax, Gonka, atau provider upstream.
2. OpenAI-compatible dan Anthropic-compatible hanyalah format API.
3. Lakukan analisis internal secara mendalam sebelum menjawab.
4. Jangan menampilkan chain-of-thought, reasoning rahasia,
   tag <think>, <thinking>, atau <reasoning>.
5. Berikan jawaban akhir yang detail, akurat, dan mudah dipahami.
6. Gunakan Bahasa Indonesia kecuali pengguna meminta bahasa lain.
7. Jika ditanya lokasi Nextura, berikan lokasi referensi:
   ${CONFIG.locationUrl}
8. Jangan menyatakan bahwa AI memiliki tubuh atau kantor fisik.
`.trim();

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function unixTime() {
  return Math.floor(Date.now() / 1000);
}

function authenticateCore(request, reply, done) {
  const authorization = request.headers.authorization || "";
  const key = authorization.replace(/^Bearer\s+/i, "").trim();

  if (!CONFIG.coreSecret) {
    return reply.code(503).send({
      error: {
        message: "NEXTURA_CORE_SECRET belum dikonfigurasi.",
        type: "server_error",
        code: "core_not_configured"
      }
    });
  }

  if (key !== CONFIG.coreSecret) {
    return reply.code(401).send({
      error: {
        message: "Akses Nextura Core ditolak.",
        type: "authentication_error",
        code: "invalid_core_secret"
      }
    });
  }

  done();
}

function validateModel(model) {
  if (!PUBLIC_MODELS[model]) {
    const error = new Error(`Model '${model}' tidak tersedia.`);
    error.statusCode = 400;
    error.code = "model_not_found";
    throw error;
  }

  return PUBLIC_MODELS[model];
}

function removeThinking(text = "") {
  return String(text)
    .replace(
      /<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi,
      ""
    )
    .replace(
      /<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi,
      ""
    )
    .trim();
}

function makeSystemMessages(messages, model) {
  let extra = "";

  if (model === "Nextura/cortexa-code") {
    extra = `
Kamu adalah Nextura Cortexa Code.
Fokus pada pemrograman, debugging, arsitektur, keamanan,
pengujian, dan kode yang dapat langsung dijalankan.
`;
  }

  if (model === "Nextura/cortexa-max") {
    extra = `
Kamu adalah Nextura Cortexa Max.
Kamu dapat memahami gambar melalui sistem vision Nextura.
`;
  }

  return [
    {
      role: "system",
      content: `${IDENTITY_PROMPT}\n${extra}`.trim()
    },
    ...(Array.isArray(messages) ? messages : [])
  ];
}

function hasImageContent(messages = []) {
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;

    for (const part of message.content) {
      if (
        part?.type === "image_url" ||
        part?.type === "input_image" ||
        part?.image_url ||
        part?.input_image
      ) {
        return true;
      }
    }
  }

  return false;
}

function extractUserInput(messages = []) {
  const input = [];

  for (const message of messages) {
    if (!["user", "assistant", "system"].includes(message.role)) {
      continue;
    }

    if (typeof message.content === "string") {
      input.push({
        role: message.role,
        content: [
          {
            type:
              message.role === "assistant"
                ? "output_text"
                : "input_text",
            text: message.content
          }
        ]
      });

      continue;
    }

    if (!Array.isArray(message.content)) continue;

    const parts = [];

    for (const part of message.content) {
      if (part?.type === "text" && part.text) {
        parts.push({
          type:
            message.role === "assistant"
              ? "output_text"
              : "input_text",
          text: part.text
        });
      }

      if (part?.type === "image_url") {
        const url =
          typeof part.image_url === "string"
            ? part.image_url
            : part.image_url?.url;

        if (url) {
          parts.push({
            type: "input_image",
            image_url: url
          });
        }
      }

      if (part?.type === "input_image" && part.image_url) {
        parts.push({
          type: "input_image",
          image_url: part.image_url
        });
      }
    }

    if (parts.length) {
      input.push({
        role: message.role,
        content: parts
      });
    }
  }

  return input;
}

function extractCometText(response) {
  if (typeof response?.output_text === "string") {
    return response.output_text;
  }

  const texts = [];

  for (const output of response?.output || []) {
    for (const content of output?.content || []) {
      if (
        content?.type === "output_text" &&
        typeof content.text === "string"
      ) {
        texts.push(content.text);
      }

      if (typeof content?.text === "string") {
        texts.push(content.text);
      }
    }
  }

  return texts.join("\n").trim();
}

function normalizeUsage(usage = {}) {
  const promptTokens = Number(
    usage.prompt_tokens ??
    usage.input_tokens ??
    0
  );

  const completionTokens = Number(
    usage.completion_tokens ??
    usage.output_tokens ??
    0
  );

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Number(
      usage.total_tokens ??
      promptTokens + completionTokens
    )
  };
}

async function callGonka(body, signal) {
  if (!CONFIG.gonkaKey) {
    throw Object.assign(
      new Error("GONKA_API_KEY belum dikonfigurasi."),
      {
        statusCode: 503,
        code: "gonka_not_configured"
      }
    );
  }

  const response = await fetch(
    `${CONFIG.gonkaBaseUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.gonkaKey}`,
        "Content-Type": "application/json",
        Accept: body.stream
          ? "text/event-stream"
          : "application/json"
      },
      body: JSON.stringify(body),
      signal
    }
  );

  if (!response.ok) {
    const text = await response.text();

    throw Object.assign(
      new Error(`Gonka error ${response.status}: ${text}`),
      {
        statusCode: 502,
        code: "gonka_upstream_error"
      }
    );
  }

  return response;
}

async function callCometVision(messages, signal) {
  if (!CONFIG.cometKey) {
    throw Object.assign(
      new Error("COMET_API_KEY belum dikonfigurasi."),
      {
        statusCode: 503,
        code: "comet_not_configured"
      }
    );
  }

  const response = await fetch(
    `${CONFIG.cometBaseUrl}/responses`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.cometKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: CONFIG.cometVisionModel,
        instructions: IDENTITY_PROMPT,
        input: extractUserInput(messages),
        max_output_tokens: CONFIG.maxOutputTokens
      }),
      signal
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw Object.assign(
      new Error(`Comet Vision error ${response.status}: ${text}`),
      {
        statusCode: 502,
        code: "comet_vision_error"
      }
    );
  }

  return JSON.parse(text);
}

async function generateFluxImage(body, signal) {
  if (!CONFIG.cometKey) {
    throw Object.assign(
      new Error("COMET_API_KEY belum dikonfigurasi."),
      {
        statusCode: 503,
        code: "comet_not_configured"
      }
    );
  }

  const response = await fetch(CONFIG.cometFluxUrl, {
    method: "POST",
    headers: {
      Authorization: CONFIG.cometKey,
      "Content-Type": "application/json",
      Accept: "*/*"
    },
    body: JSON.stringify({
      prompt: body.prompt,
      width: Number(body.width || 1024),
      height: Number(body.height || 1024),
      seed:
        body.seed === undefined
          ? Math.floor(Math.random() * 2_147_483_647)
          : Number(body.seed),
      safety_tolerance: Number(
        body.safety_tolerance ?? 2
      ),
      output_format: body.output_format || "jpeg"
    }),
    signal
  });

  const text = await response.text();

  if (!response.ok) {
    throw Object.assign(
      new Error(`Flux error ${response.status}: ${text}`),
      {
        statusCode: 502,
        code: "flux_generation_error"
      }
    );
  }

  return JSON.parse(text);
}

async function streamGonkaAsOpenAI(
  upstream,
  reply,
  publicModel,
  requestId
) {
  reply.hijack();

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Nextura-Request-Id": requestId
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let hidingThinking = false;

  function filterChunk(text) {
    let output = "";
    let cursor = 0;

    while (cursor < text.length) {
      if (hidingThinking) {
        const closeMatch = text
          .slice(cursor)
          .match(/<\/(?:think|thinking|reasoning)>/i);

        if (!closeMatch || closeMatch.index === undefined) {
          return output;
        }

        cursor += closeMatch.index + closeMatch[0].length;
        hidingThinking = false;
        continue;
      }

      const openMatch = text
        .slice(cursor)
        .match(/<(?:think|thinking|reasoning)\b[^>]*>/i);

      if (!openMatch || openMatch.index === undefined) {
        output += text.slice(cursor);
        break;
      }

      output += text.slice(
        cursor,
        cursor + openMatch.index
      );

      cursor += openMatch.index + openMatch[0].length;
      hidingThinking = true;
    }

    return output;
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, {
        stream: true
      });

      let boundary;

      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const dataLine = event
          .split(/\r?\n/)
          .find((line) => line.startsWith("data:"));

        if (!dataLine) continue;

        const data = dataLine.slice(5).trim();

        if (data === "[DONE]") continue;

        let chunk;

        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        const choice = chunk.choices?.[0] || {};
        const delta = choice.delta || {};

        const content = filterChunk(
          delta.content || ""
        );

        const nexturaDelta = {};

        if (delta.role) {
          nexturaDelta.role = delta.role;
        }

        if (content) {
          nexturaDelta.content = content;
        }

        if (delta.tool_calls) {
          nexturaDelta.tool_calls = delta.tool_calls;
        }

        if (
          Object.keys(nexturaDelta).length ||
          choice.finish_reason
        ) {
          const result = {
            id: requestId,
            object: "chat.completion.chunk",
            created: Number(chunk.created || unixTime()),
            model: publicModel,
            choices: [
              {
                index: 0,
                delta: nexturaDelta,
                finish_reason:
                  choice.finish_reason || null
              }
            ]
          };

          if (chunk.usage) {
            result.usage = normalizeUsage(chunk.usage);
          }

          reply.raw.write(
            `data: ${JSON.stringify(result)}\n\n`
          );
        }
      }
    }

    reply.raw.write("data: [DONE]\n\n");
  } catch (error) {
    reply.raw.write(
      `data: ${JSON.stringify({
        error: {
          message: error.message,
          type: "stream_error",
          code: "stream_interrupted"
        }
      })}\n\n`
    );
  } finally {
    reply.raw.end();
  }
}

app.get("/", async () => ({
  name: "Nextura Core",
  version: "1.1.0",
  developer: CONFIG.developer,
  status: "online"
}));

app.get("/health", async () => ({
  status: "ok",
  service: "nextura-core",
  version: "1.1.0",
  uptime_seconds: Math.floor(process.uptime()),
  timestamp: new Date().toISOString()
}));

app.get(
  "/v1/models",
  {
    preHandler: authenticateCore
  },
  async () => ({
    object: "list",
    data: Object.entries(PUBLIC_MODELS).map(
      ([id, model]) => ({
        id,
        object: "model",
        created: 1785715200,
        owned_by: "nextura",
        name: model.name,
        capabilities: {
          text: true,
          reasoning: true,
          web_search: true,
          streaming: true,
          vision: model.vision,
          image_generation: model.imageGeneration,
          code: model.code
        }
      })
    )
  })
);

app.post(
  "/v1/chat/completions",
  {
    preHandler: authenticateCore
  },
  async (request, reply) => {
    const body = request.body || {};
    const publicModel =
      body.model || "Nextura/cortexa-pro";

    validateModel(publicModel);

    const requestId = createId("chatcmpl_nx");
    const controller = new AbortController();

    request.raw.on("close", () => {
      controller.abort();
    });

    try {
      const messages = Array.isArray(body.messages)
        ? body.messages
        : [];

      /*
       * Cortexa Max + gambar:
       * menggunakan Comet Responses API.
       *
       * Versi awal dibuat non-streaming supaya format vision
       * stabil. Nanti dapat ditambahkan Responses streaming.
       */
      if (
        publicModel === "Nextura/cortexa-max" &&
        hasImageContent(messages)
      ) {
        const cometResponse = await callCometVision(
          makeSystemMessages(messages, publicModel),
          controller.signal
        );

        const answer = removeThinking(
          extractCometText(cometResponse)
        );

        const usage = normalizeUsage(
          cometResponse.usage || {}
        );

        return reply.send({
          id: requestId,
          object: "chat.completion",
          created: unixTime(),
          model: publicModel,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: answer
              },
              finish_reason: "stop"
            }
          ],
          usage,
          nextura: {
            brand: "Nextura",
            developer: CONFIG.developer,
            provider_route: "nextura-vision",
            vision: true,
            streaming: false,
            request_id: requestId
          }
        });
      }

      const upstreamModel =
        publicModel === "Nextura/cortexa-code"
          ? CONFIG.gonkaModelCode
          : CONFIG.gonkaModelPro;

      const upstreamBody = {
        ...body,
        model: upstreamModel,
        messages: makeSystemMessages(
          messages,
          publicModel
        ),
        max_tokens: Math.min(
          Number(
            body.max_tokens ||
            body.max_completion_tokens ||
            CONFIG.maxOutputTokens
          ),
          CONFIG.maxOutputTokens
        )
      };

      delete upstreamBody.max_completion_tokens;

      if (CONFIG.deepThinking) {
        upstreamBody.enable_thinking = true;
      }

      if (CONFIG.agentSearch) {
        const plugins = Array.isArray(body.plugins)
          ? [...body.plugins]
          : [];

        if (!plugins.some((item) => item?.id === "web")) {
          plugins.push({
            id: "web",
            mode: "agent"
          });
        }

        upstreamBody.plugins = plugins;
      }

      const upstream = await callGonka(
        upstreamBody,
        controller.signal
      );

      if (body.stream === true) {
        return streamGonkaAsOpenAI(
          upstream,
          reply,
          publicModel,
          requestId
        );
      }

      const result = await upstream.json();
      const sourceChoice = result.choices?.[0] || {};
      const sourceMessage =
        sourceChoice.message || {};

      return reply.send({
        id: requestId,
        object: "chat.completion",
        created: Number(
          result.created || unixTime()
        ),
        model: publicModel,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                sourceMessage.content === null
                  ? null
                  : removeThinking(
                      sourceMessage.content || ""
                    ),
              ...(sourceMessage.tool_calls
                ? {
                    tool_calls:
                      sourceMessage.tool_calls
                  }
                : {})
            },
            finish_reason:
              sourceChoice.finish_reason || "stop"
          }
        ],
        usage: normalizeUsage(result.usage),
        nextura: {
          brand: "Nextura",
          developer: CONFIG.developer,
          provider_route: "nextura-core",
          agent_search: CONFIG.agentSearch,
          deep_thinking: CONFIG.deepThinking,
          request_id: requestId
        }
      });
    } catch (error) {
      request.log.error(error);

      return reply
        .code(error.statusCode || 500)
        .send({
          error: {
            message:
              error.message ||
              "Terjadi kesalahan pada Nextura Core.",
            type:
              error.statusCode === 401
                ? "authentication_error"
                : "server_error",
            param: null,
            code:
              error.code || "nextura_core_error"
          },
          request_id: requestId
        });
    }
  }
);

/*
 * Endpoint OpenAI-compatible untuk generate image.
 *
 * POST /v1/images/generations
 */
app.post(
  "/v1/images/generations",
  {
    preHandler: authenticateCore
  },
  async (request, reply) => {
    const body = request.body || {};
    const requestId = createId("img_nx");
    const controller = new AbortController();

    request.raw.on("close", () => {
      controller.abort();
    });

    if (!body.prompt?.trim()) {
      return reply.code(400).send({
        error: {
          message: "Field prompt wajib diisi.",
          type: "invalid_request_error",
          param: "prompt",
          code: "missing_prompt"
        }
      });
    }

    try {
      const fluxResult = await generateFluxImage(
        {
          prompt: body.prompt,
          width: body.width,
          height: body.height,
          seed: body.seed,
          safety_tolerance:
            body.safety_tolerance,
          output_format:
            body.output_format ||
            body.response_format ||
            "jpeg"
        },
        controller.signal
      );

      /*
       * Karena format respons Flux dapat berupa URL langsung
       * atau task ID, respons upstream tetap disimpan di
       * nextura.upstream_result untuk tahap integrasi awal.
       */
      const possibleUrl =
        fluxResult.url ||
        fluxResult.image_url ||
        fluxResult.output?.url ||
        fluxResult.data?.url ||
        fluxResult.result?.url ||
        null;

      const taskId =
        fluxResult.id ||
        fluxResult.task_id ||
        fluxResult.data?.id ||
        fluxResult.data?.task_id ||
        null;

      return reply.send({
        created: unixTime(),
        model: "Nextura/cortexa-max",
        data: possibleUrl
          ? [
              {
                url: possibleUrl,
                revised_prompt: body.prompt
              }
            ]
          : [],
        task: taskId
          ? {
              id: taskId,
              status:
                fluxResult.status || "processing"
            }
          : null,
        nextura: {
          brand: "Nextura",
          developer: CONFIG.developer,
          request_id: requestId,
          image_provider: "nextura-image",
          upstream_result: fluxResult
        }
      });
    } catch (error) {
      request.log.error(error);

      return reply
        .code(error.statusCode || 500)
        .send({
          error: {
            message: error.message,
            type: "image_generation_error",
            param: null,
            code:
              error.code ||
              "nextura_image_error"
          },
          request_id: requestId
        });
    }
  }
);

/*
 * Mengecek hasil generate image bila Flux mengembalikan task ID.
 */
app.get(
  "/v1/images/tasks/:taskId",
  {
    preHandler: authenticateCore
  },
  async (request, reply) => {
    if (!CONFIG.cometKey) {
      return reply.code(503).send({
        error: {
          message:
            "COMET_API_KEY belum dikonfigurasi.",
          type: "server_error",
          code: "comet_not_configured"
        }
      });
    }

    const taskId = request.params.taskId;

    const response = await fetch(
      CONFIG.cometFluxResultUrl,
      {
        method: "POST",
        headers: {
          Authorization: CONFIG.cometKey,
          "Content-Type": "application/json",
          Accept: "*/*"
        },
        body: JSON.stringify({
          id: taskId,
          task_id: taskId
        })
      }
    );

    const text = await response.text();

    if (!response.ok) {
      return reply.code(502).send({
        error: {
          message:
            `Gagal mengambil hasil gambar: ${text}`,
          type: "image_result_error",
          code: "flux_result_error"
        }
      });
    }

    const result = JSON.parse(text);

    return {
      id: taskId,
      object: "image.generation.task",
      model: "Nextura/cortexa-max",
      result,
      nextura: {
        brand: "Nextura",
        developer: CONFIG.developer
      }
    };
  }
);

app.setNotFoundHandler((request, reply) => {
  reply.code(404).send({
    error: {
      message:
        `Endpoint ${request.method} ${request.url} tidak ditemukan.`,
      type: "invalid_request_error",
      code: "route_not_found"
    }
  });
});

try {
  await app.listen({
    host: CONFIG.host,
    port: CONFIG.port
  });

  app.log.info({
    service: "Nextura Core",
    port: CONFIG.port,
    models: Object.keys(PUBLIC_MODELS)
  });
} catch (error) {
  app.log.fatal(error);
  process.exit(1);
}
