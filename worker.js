// this file is the worker script for siliconflow image2openai - made by glm-4.7

const SILICONFLOW_API_URL = "https://api.siliconflow.cn/v1/images/generations";

const SUPPORTED_MODELS = [
    "Qwen/Qwen-Image",
    "Kwai-Kolors/Kolors",
    "Qwen/Qwen-Image-Edit",
    "Qwen/Qwen-Image-Edit-2509",
];

const OPTIONAL_PARAMS = [
    "negative_prompt",
    "image_size",
    "batch_size",
    "seed",
    "num_inference_steps",
    "guidance_scale",
    "cfg",
];

function ensureValidImageCount(model, imageCount) {
    if (model === "Qwen/Qwen-Image" && imageCount > 0) {
        throw new HTTPException(400, "This model doesn't accept images");
    } else if (model === "Kwai-Kolors/Kolors" && imageCount > 0) {
        throw new HTTPException(400, "This model doesn't accept images");
    } else if (model === "Qwen/Qwen-Image-Edit" && imageCount !== 1) {
        throw new HTTPException(400, "This model requires exactly 1 image");
    } else if (model === "Qwen/Qwen-Image-Edit-2509" && (imageCount < 1 || imageCount > 3)) {
        throw new HTTPException(400, "This model requires 1-3 images");
    }
}

function extractUserContentAndImages(data) {
    const messages = data.messages || [];
    if (!messages || messages.length === 0) {
        throw new HTTPException(400, "Messages are required");
    }
    return getLastUserMessage(messages);
}

function buildSiliconflowPayload(model, prompt, images, data) {
    const payload = {
        model: model,
        prompt: prompt,
    };

    if (images && images.length > 0) {
        if (images.length >= 1) {
            payload.image = images[0];
        }
        if (images.length >= 2) {
            payload.image2 = images[1];
        }
        if (images.length >= 3) {
            payload.image3 = images[2];
        }
    }

    for (const param of OPTIONAL_PARAMS) {
        if (param in data) {
            payload[param] = data[param];
        }
    }

    return payload;
}

async function callSiliconflowAPI(apiKey, payload) {
    const headers = {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
    };

    let response;
    try {
        response = await fetch(SILICONFLOW_API_URL, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload),
        });
    } catch (e) {
        throw new HTTPException(502, `Network error: ${e.message}`);
    }

    if (response.status === 400) {
        const errorData = await response.json();
        const errorMsg = errorData.message || "Invalid request parameters";
        throw new HTTPException(400, `Bad Request: ${errorMsg}`);
    } else if (response.status === 401) {
        throw new HTTPException(401, "Invalid API key");
    } else if (response.status === 403) {
        throw new HTTPException(403, "Access forbidden");
    } else if (response.status === 404) {
        throw new HTTPException(404, "API endpoint not found");
    } else if (response.status === 429) {
        const errorData = await response.json();
        const errorMsg = errorData.message || "Rate limit exceeded";
        throw new HTTPException(429, `Rate Limited: ${errorMsg}`);
    } else if (response.status === 503) {
        const errorData = await response.json();
        const errorMsg = errorData.message || "Service overloaded";
        throw new HTTPException(503, `Service Unavailable: ${errorMsg}`);
    } else if (response.status === 504) {
        throw new HTTPException(504, "Request timeout");
    } else if (response.status !== 200) {
        const errorText = await response.text();
        throw new HTTPException(response.status, `SiliconFlow API error: ${errorText}`);
    }

    return await response.json();
}

function buildOpenAIResponse(model, userContent, apiResult) {
    const imageUrls = [];
    if (apiResult.images) {
        for (const imageData of apiResult.images) {
            if (imageData.url) {
                imageUrls.push(imageData.url);
            }
        }
    }

    const content = imageUrls.length > 0
        ? imageUrls.map(url => `![](${url})`).join("\n")
        : "图像生成完成，但未返回URL。";

    return {
        id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: content,
                },
                finish_reason: "stop",
            },
        ],
        usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
        },
    };
}

function* buildStreamResponse(model, apiResult) {
    const chunkId = `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);

    const imageUrls = (apiResult.images || [])
        .filter(img => img.url)
        .map(img => img.url);

    const content = imageUrls.length > 0
        ? imageUrls.map(url => `![](${url})`).join("\n")
        : "图像生成完成，但未返回URL。";

    yield `data: ${JSON.stringify({
        id: chunkId,
        object: "chat.completion.chunk",
        created: created,
        model: model,
        choices: [{
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
        }],
    })}\n\n`;

    yield `data: ${JSON.stringify({
        id: chunkId,
        object: "chat.completion.chunk",
        created: created,
        model: model,
        choices: [{
            index: 0,
            delta: { content: content },
            finish_reason: null,
        }],
    })}\n\n`;

    yield `data: ${JSON.stringify({
        id: chunkId,
        object: "chat.completion.chunk",
        created: created,
        model: model,
        choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop",
            usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
            },
        }],
    })}\n\n`;

    yield "data: [DONE]\n\n";
}

function getLastUserMessage(messages) {
    let textContent = "";
    const images = [];

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role === "user") {
            const content = message.content;
            if (typeof content === "string") {
                textContent = content;
            } else if (Array.isArray(content)) {
                for (const item of content) {
                    if (typeof item === "object" && item !== null) {
                        if (item.type === "text") {
                            textContent = item.text || "";
                        } else if (item.type === "image_url") {
                            const imageUrlData = item.image_url;
                            if (typeof imageUrlData === "object" && imageUrlData !== null) {
                                const imageUrl = imageUrlData.url || "";
                                if (imageUrl) {
                                    images.push(imageUrl);
                                }
                            } else if (typeof imageUrlData === "string") {
                                images.push(imageUrlData);
                            }
                        }
                    }
                }
            }
            break;
        }
    }

    if (!textContent) {
        throw new HTTPException(400, "No text content found in the last user message");
    }

    return [textContent, images];
}

class HTTPException extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

async function handleChatCompletions(request) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        throw new HTTPException(401, "Invalid authorization format");
    }
    const apiKey = authHeader.substring(7);

    let data;
    try {
        data = await request.json();
    } catch (e) {
        throw new HTTPException(400, "Invalid JSON in request body");
    }

    const model = data.model;
    if (!model) {
        throw new HTTPException(400, "Model is required");
    }

    if (!SUPPORTED_MODELS.includes(model)) {
        throw new HTTPException(400, `Model ${model} is not supported`);
    }

    const [userContent, images] = extractUserContentAndImages(data);
    ensureValidImageCount(model, images.length);

    const payload = buildSiliconflowPayload(model, userContent, images, data);
    const result = await callSiliconflowAPI(apiKey, payload);

    if (data.stream === true) {
        const stream = new ReadableStream({
            start(controller) {
                for (const chunk of buildStreamResponse(model, result)) {
                    controller.enqueue(new TextEncoder().encode(chunk));
                }
                controller.close();
            },
        });
        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        });
    }

    return new Response(JSON.stringify(buildOpenAIResponse(model, userContent, result)), {
        headers: {
            "Content-Type": "application/json",
        },
    });
}

function handleListModels() {
    return new Response(
        JSON.stringify({
            object: "list",
            data: SUPPORTED_MODELS.map((model) => ({
                id: model,
                object: "model",
                owned_by: "siliconflow",
            })),
        }),
        {
            headers: {
                "Content-Type": "application/json",
            },
        }
    );
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        try {
            if (path === "/v1/chat/completions" && request.method === "POST") {
                return await handleChatCompletions(request);
            } else if (path === "/v1/models" || path === "/models") {
                return handleListModels();
            } else {
                return new Response("Not Found", { status: 404 });
            }
        } catch (error) {
            if (error instanceof HTTPException) {
                return new Response(
                    JSON.stringify({ error: error.message }),
                    {
                        status: error.statusCode,
                        headers: {
                            "Content-Type": "application/json",
                        },
                    }
                );
            }
            return new Response(
                JSON.stringify({ error: "Internal Server Error" }),
                {
                    status: 500,
                    headers: {
                        "Content-Type": "application/json",
                    },
                }
            );
        }
    },
};
