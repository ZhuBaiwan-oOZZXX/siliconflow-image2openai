import time
import uuid
import json
from typing import List, Dict, Any
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.responses import StreamingResponse
import aiohttp
import uvicorn

session = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global session
    session = aiohttp.ClientSession()
    yield
    await session.close()


app = FastAPI(lifespan=lifespan)

SILICONFLOW_API_URL = "https://api.siliconflow.cn/v1/images/generations"

# 全局超时时间设置（秒）
DEFAULT_TIMEOUT = 120

SUPPORTED_MODELS = [
    "Qwen/Qwen-Image",
    "Kwai-Kolors/Kolors",
    "Qwen/Qwen-Image-Edit",
    "Qwen/Qwen-Image-Edit-2509",
]

OPTIONAL_PARAMS = [
    "negative_prompt",
    "image_size",
    "batch_size",
    "seed",
    "num_inference_steps",
    "guidance_scale",
    "cfg",
]


def ensure_valid_image_count(model: str, image_count: int) -> None:
    """确保图片数量符合模型要求，不符合则抛出异常"""
    if model in ["Qwen/Qwen-Image", "Kwai-Kolors/Kolors"] and image_count > 0:
        raise HTTPException(400, "This model doesn't accept images")
    elif model == "Qwen/Qwen-Image-Edit" and image_count != 1:
        raise HTTPException(400, "This model requires exactly 1 image")
    elif model == "Qwen/Qwen-Image-Edit-2509" and (image_count < 1 or image_count > 3):
        raise HTTPException(400, "This model requires 1-3 images")


def extract_user_content_and_images(data: Dict[str, Any]) -> tuple[str, List[str]]:
    """提取用户消息内容和图片"""
    messages = data.get("messages", [])
    if not messages:
        raise HTTPException(status_code=400, detail="Messages are required")

    return get_last_user_message(messages)


def build_siliconflow_payload(
    model: str, prompt: str, images: List[str], data: Dict[str, Any]
) -> Dict[str, Any]:
    """构建SiliconFlow API请求payload"""
    payload = {"model": model, "prompt": prompt}

    if images:
        if len(images) >= 1:
            payload["image"] = images[0]
        if len(images) >= 2:
            payload["image2"] = images[1]
        if len(images) >= 3:
            payload["image3"] = images[2]

    for param in OPTIONAL_PARAMS:
        if param in data:
            payload[param] = data[param]

    return payload


async def call_siliconflow_api(api_key: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """调用SiliconFlow API"""
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    try:
        async with session.post(
            SILICONFLOW_API_URL,
            headers=headers,
            json=payload,
            timeout=aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT),
        ) as response:
            if response.status == 400:
                error_data = await response.json()
                error_msg = error_data.get("message", "Invalid request parameters")
                raise HTTPException(status_code=400, detail=f"Bad Request: {error_msg}")

            elif response.status == 401:
                raise HTTPException(status_code=401, detail="Invalid API key")

            elif response.status == 403:
                raise HTTPException(status_code=403, detail="Access forbidden")

            elif response.status == 404:
                raise HTTPException(status_code=404, detail="API endpoint not found")

            elif response.status == 429:
                error_data = await response.json()
                error_msg = error_data.get("message", "Rate limit exceeded")
                raise HTTPException(
                    status_code=429, detail=f"Rate Limited: {error_msg}"
                )

            elif response.status == 503:
                error_data = await response.json()
                error_msg = error_data.get("message", "Service overloaded")
                raise HTTPException(
                    status_code=503, detail=f"Service Unavailable: {error_msg}"
                )

            elif response.status == 504:
                raise HTTPException(status_code=504, detail="Request timeout")

            elif response.status != 200:
                error_text = await response.text()
                raise HTTPException(
                    status_code=response.status,
                    detail=f"SiliconFlow API error: {error_text}",
                )

            return await response.json()

    except HTTPException:
        raise
    except aiohttp.ClientError as e:
        raise HTTPException(status_code=502, detail=f"Network error: {str(e)}")


def build_openai_response(
    model: str, user_content: str, api_result: Dict[str, Any]
) -> Dict[str, Any]:
    """构建OpenAI格式的响应"""
    image_urls = []
    if "images" in api_result:
        for image_data in api_result["images"]:
            if "url" in image_data:
                image_urls.append(image_data["url"])

    content = (
        "\n".join([f"![]({url})" for url in image_urls])
        if image_urls
        else "图像生成完成，但未返回URL。"
    )

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 1,
            "completion_tokens": 1,
            "total_tokens": 2,
        },
    }


def build_stream_response(model: str, api_result: Dict[str, Any]):
    """构建SSE流式响应"""
    chunk_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(time.time())
    
    # 提取图片URL并构建内容
    image_urls = [img["url"] for img in api_result.get("images", []) if "url" in img]
    content = "\n".join([f"![]({url})" for url in image_urls]) if image_urls else "图像生成完成，但未返回URL。"
    
    # 第一个chunk: role
    yield f"data: {json.dumps({'id': chunk_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': ''}, 'finish_reason': None}]})}\n\n"
    
    # 第二个chunk: content
    yield f"data: {json.dumps({'id': chunk_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {'content': content}, 'finish_reason': None}]})}\n\n"
    
    # 最后一个chunk: finish
    yield f"data: {json.dumps({'id': chunk_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop', 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}]})}\n\n"
    
    yield "data: [DONE]\n\n"


def get_last_user_message(messages: List[Dict[str, Any]]) -> tuple[str, List[str]]:
    """提取最后一个用户消息的文本内容和图片"""
    text_content = ""
    images = []

    for message in reversed(messages):
        if message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, str):
                text_content = content
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, dict):
                        if item.get("type") == "text":
                            text_content = item.get("text", "")
                        elif item.get("type") == "image_url":
                            image_url_data = item.get("image_url", {})
                            if isinstance(image_url_data, dict):
                                image_url = image_url_data.get("url", "")
                                if image_url:
                                    images.append(image_url)
                            elif isinstance(image_url_data, str):
                                images.append(image_url_data)
            break

    if not text_content:
        raise HTTPException(400, "No text content found in the last user message")

    return text_content, images


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, authorization: str = Header(None)):
    """将OpenAI聊天完成请求转换为SiliconFlow图像生成请求"""

    if authorization and authorization.startswith("Bearer "):
        api_key = authorization[7:]
    else:
        raise HTTPException(status_code=401, detail="Invalid authorization format")

    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON in request body")

    model = data.get("model")
    if not model:
        raise HTTPException(status_code=400, detail="Model is required")

    if model not in SUPPORTED_MODELS:
        raise HTTPException(status_code=400, detail=f"Model {model} is not supported")

    user_content, images = extract_user_content_and_images(data)
    ensure_valid_image_count(model, len(images))

    payload = build_siliconflow_payload(model, user_content, images, data)
    result = await call_siliconflow_api(api_key, payload)

    # 判断是否流式输出
    if data.get("stream", False):
        return StreamingResponse(
            build_stream_response(model, result),
            media_type="text/event-stream"
        )

    return build_openai_response(model, user_content, result)


@app.get("/v1/models")
@app.get("/models")
async def list_models():
    """列出支持的模型"""
    return {
        "object": "list",
        "data": [
            {"id": model, "object": "model", "owned_by": "siliconflow"}
            for model in SUPPORTED_MODELS
        ],
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
