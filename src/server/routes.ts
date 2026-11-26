/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli, openaiToCliDelta, extractModel, SUPPORTED_MODELS } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  cliUsageToOpenai,
  createDeltaChunk,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import { parseToolCalls, toolNamesOf, toolsActive } from "../adapter/tools.js";
import { getSession, setSession, clearSession } from "../subprocess/session-store.js";
import type { OpenAIChatChunkDelta, OpenAIChatRequest } from "../types/openai.js";
import type { ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";

interface SessionContext {
  sessionKey: string | undefined;
  resume: boolean;
  messageCount: number;
}

/**
 * Resolve CLI input for a request, resuming a persisted Claude CLI session
 * when we have one for this `request.user` key instead of replaying the
 * full message history on every turn.
 */
function resolveCliInput(body: OpenAIChatRequest): {
  cliInput: ReturnType<typeof openaiToCli>;
  sessionKey: string | undefined;
  resume: boolean;
} {
  // Session resume requires a stable per-client identifier. Without `user`
  // we have no way to distinguish callers, so skip resume entirely rather
  // than fall back to a shared key that would cross-contaminate unrelated
  // conversations.
  const sessionKey = body.user;
  const existing = sessionKey ? getSession(sessionKey) : undefined;

  if (existing) {
    const cliInput = openaiToCliDelta(body, existing.messageCount);
    cliInput.sessionId = existing.claudeSessionId;
    return { cliInput, sessionKey, resume: true };
  }

  const cliInput = openaiToCli(body);
  if (sessionKey) {
    cliInput.sessionId = uuidv4(); // pin a known ID so we can --resume it later
  }
  return { cliInput, sessionKey, resume: false };
}

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    if (!extractModel(body.model)) {
      res.status(404).json({
        error: {
          message: `The model ${JSON.stringify(body.model ?? null)} is not supported. Supported models: ${SUPPORTED_MODELS.join(", ")}`,
          type: "invalid_request_error",
          param: "model",
          code: "model_not_found",
        },
      });
      return;
    }

    // Convert to CLI input format, resuming a persisted session when we have one
    const { cliInput, sessionKey, resume } = resolveCliInput(body);
    const subprocess = new ClaudeSubprocess();
    const sessionCtx: SessionContext = { sessionKey, resume, messageCount: body.messages.length };
    // Reply text is only parsed for <tool_call> blocks when the request declares tools
    const toolNames = toolsActive(body) ? toolNamesOf(body) : null;

    if (stream) {
      await handleStreamingResponse(req, res, subprocess, cliInput, requestId, sessionCtx, toolNames);
    } else {
      await handleNonStreamingResponse(res, subprocess, cliInput, requestId, sessionCtx, toolNames);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 *
 * When toolNames is set (the request declares tools), text is held back until
 * the result arrives so that <tool_call> blocks can be turned into tool_calls.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  sessionCtx: SessionContext,
  toolNames: Set<string> | null
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    const responseModel = cliInput.model;
    let isComplete = false;
    let hasEmittedText = false;
    // Text of a tool-enabled reply, held back until the result arrives
    let bufferedText = "";

    // Handle actual client disconnect (response stream closed)
    res.on("close", () => {
      if (!isComplete) {
        // Client disconnected before response completed - kill subprocess
        subprocess.kill();
      }
      resolve();
    });

    // When a new text content block starts after we've already emitted text,
    // insert a separator so text from different blocks doesn't run together
    subprocess.on("text_block_start", () => {
      if (toolNames) {
        if (hasEmittedText) bufferedText += "\n\n";
      } else if (hasEmittedText && !res.writableEnded) {
        const sepChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: responseModel,
          choices: [{
            index: 0,
            delta: {
              content: "\n\n",
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(sepChunk)}\n\n`);
      }
    });

    // Handle streaming content deltas
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const delta = event.event.delta;
      const text = (delta?.type === "text_delta" && delta.text) || "";
      if (text && !res.writableEnded) {
        if (toolNames) {
          bufferedText += text;
          hasEmittedText = true;
          return;
        }
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: responseModel,
          choices: [{
            index: 0,
            delta: {
              role: isFirst ? "assistant" : undefined,
              content: text,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
        hasEmittedText = true;
      }
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      if (sessionCtx.sessionKey && cliInput.sessionId) {
        setSession(sessionCtx.sessionKey, cliInput.sessionId, sessionCtx.messageCount);
      }
      if (!res.writableEnded) {
        // Tool replies were buffered rather than streamed, so decide how to send them now
        const replyText = bufferedText || result.result || "";
        const toolReply = toolNames ? parseToolCalls(replyText, toolNames) : null;
        if (toolReply) {
          let roleSent = false;
          if (toolReply.content !== null) {
            const contentChunk = createDeltaChunk(requestId, responseModel, {
              role: "assistant",
              content: toolReply.content,
            });
            res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
            roleSent = true;
          }
          const toolDelta: OpenAIChatChunkDelta = {
            tool_calls: toolReply.toolCalls.map((call, index) => ({
              index,
              id: call.id,
              type: call.type,
              function: call.function,
            })),
          };
          if (!roleSent) {
            toolDelta.role = "assistant";
          }
          res.write(`data: ${JSON.stringify(createDeltaChunk(requestId, responseModel, toolDelta))}\n\n`);
        } else if (toolNames && replyText) {
          const textChunk = createDeltaChunk(requestId, responseModel, {
            role: "assistant",
            content: replyText,
          });
          res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
        }

        // Send final done chunk with finish_reason and usage data
        const doneChunk = createDoneChunk(requestId, responseModel, toolReply ? "tool_calls" : "stop");
        if (result.usage) {
          doneChunk.usage = cliUsageToOpenai(result.usage);
        }
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      // Resume may have failed (e.g. stale/missing session) — drop it so the
      // next turn self-heals with a fresh full-history session
      if (sessionCtx.resume && sessionCtx.sessionKey) {
        clearSession(sessionCtx.sessionKey);
      }
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      // Subprocess exited - ensure response is closed
      if (code !== 0 && !isComplete) {
        if (sessionCtx.resume && sessionCtx.sessionKey) {
          clearSession(sessionCtx.sessionKey);
        }
        if (!res.writableEnded) {
          // Abnormal exit without result - send error
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
      }
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    // Start the subprocess
    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
      resume: sessionCtx.resume,
      systemPrompt: cliInput.systemPrompt,
    }).catch((err) => {
      console.error("[Streaming] Subprocess start error:", err);
      reject(err);
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  sessionCtx: SessionContext,
  toolNames: Set<string> | null
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;
    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      if (sessionCtx.resume && sessionCtx.sessionKey) {
        clearSession(sessionCtx.sessionKey);
      }
      res.status(500).json({
        error: {
          message: error.message,
          type: "server_error",
          code: null,
        },
      });
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (finalResult) {
        if (sessionCtx.sessionKey && cliInput.sessionId) {
          setSession(sessionCtx.sessionKey, cliInput.sessionId, sessionCtx.messageCount);
        }
        const toolReply = toolNames
          ? parseToolCalls(finalResult.result, toolNames)
          : null;
        res.json(
          toolReply
            ? cliResultToOpenai(
                finalResult,
                requestId,
                cliInput.model,
                toolReply.toolCalls,
                toolReply.content
              )
            : cliResultToOpenai(finalResult, requestId, cliInput.model)
        );
      } else {
        if (sessionCtx.resume && sessionCtx.sessionKey) {
          clearSession(sessionCtx.sessionKey);
        }
        if (!res.headersSent) {
          res.status(500).json({
            error: {
              message: `Claude CLI exited with code ${code} without response`,
              type: "server_error",
              code: null,
            },
          });
        }
      }
      resolve();
    });

    // Start the subprocess
    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
        resume: sessionCtx.resume,
        systemPrompt: cliInput.systemPrompt,
      })
      .catch((error) => {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
        resolve();
      });
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  const now = Math.floor(Date.now() / 1000);
  const modelIds = SUPPORTED_MODELS;
  res.json({
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      owned_by: "anthropic",
      created: now,
    })),
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
