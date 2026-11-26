/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli, openaiToCliDelta, extractModel, SUPPORTED_MODELS } from "../adapter/openai-to-cli.js";
import {
  cliResultErrorMessage,
  cliResultToOpenai,
  cliUsageToOpenai,
  createDeltaChunk,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import { parseToolCalls, toolNamesOf, toolsActive } from "../adapter/tools.js";
import { getSession, setSession, clearSession } from "../subprocess/session-store.js";
import { formatRequestLog, type RequestFinish } from "./request-log.js";
import type { OpenAIChatChunkDelta, OpenAIChatRequest, OpenAIUsage } from "../types/openai.js";
import type { ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";

interface SessionContext {
  sessionKey: string | undefined;
  resume: boolean;
  messageCount: number;
}

/** What a request ended with, as far as its summary line is concerned. */
interface RequestOutcome {
  finish: RequestFinish;
  toolCalls?: number;
  usage?: OpenAIUsage;
  error?: string;
}

/** Records the summary line for one request; later calls are ignored. */
type RequestSummary = (outcome: RequestOutcome) => void;

/**
 * Build the once-only summary logger for one request. The first call prints
 * the summary line; any later call (an error followed by a close, say) does nothing.
 */
function createRequestSummary(
  requestId: string,
  body: OpenAIChatRequest,
  startedAt: number
): RequestSummary {
  let logged = false;
  return (outcome) => {
    if (logged) return;
    logged = true;
    console.log(
      formatRequestLog({
        requestId,
        model: typeof body.model === "string" ? body.model : "-",
        stream: body.stream === true,
        messages: Array.isArray(body.messages) ? body.messages.length : 0,
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
        finish: outcome.finish,
        toolCalls: outcome.toolCalls ?? 0,
        usage: outcome.usage,
        error: outcome.error,
        durationMs: Date.now() - startedAt,
      })
    );
  };
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
  const startedAt = Date.now();
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;
  const summarize = createRequestSummary(requestId, body, startedAt);

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      const message = "messages is required and must be a non-empty array";
      summarize({ finish: "error", error: message });
      res.status(400).json({
        error: {
          message,
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    if (!extractModel(body.model)) {
      const message = `The model ${JSON.stringify(body.model ?? null)} is not supported. Supported models: ${SUPPORTED_MODELS.join(", ")}`;
      summarize({ finish: "error", error: message });
      res.status(404).json({
        error: {
          message,
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
      await handleStreamingResponse(req, res, subprocess, cliInput, requestId, sessionCtx, toolNames, summarize);
    } else {
      await handleNonStreamingResponse(res, subprocess, cliInput, requestId, sessionCtx, toolNames, summarize);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);
    summarize({ finish: "error", error: message });

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
  toolNames: Set<string> | null,
  summarize: RequestSummary
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

  return new Promise<void>((resolve) => {
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
        summarize({ finish: "aborted" });
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
      // An error result (is_error) goes out as an error event, not as a normal reply
      const errorMessage = cliResultErrorMessage(result);
      if (errorMessage !== null) {
        if (!res.writableEnded) {
          res.write(
            `data: ${JSON.stringify({
              error: { message: errorMessage, type: "server_error", code: null },
            })}\n\n`
          );
          res.write("data: [DONE]\n\n");
          res.end();
        }
        summarize({ finish: "error", error: errorMessage });
        resolve();
        return;
      }
      if (!res.writableEnded) {
        // Tool replies were buffered rather than streamed, so decide how to send them now
        const replyText = bufferedText || result.result || "";
        const toolReply = toolNames ? parseToolCalls(replyText, toolNames, requestId) : null;
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
        summarize({
          finish: toolReply ? "tool_calls" : "stop",
          toolCalls: toolReply?.toolCalls.length ?? 0,
          usage: result.usage ? cliUsageToOpenai(result.usage) : undefined,
        });
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      summarize({ finish: "error", error: error.message });
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
      if (!isComplete) {
        summarize({
          finish: "error",
          error: `Process exited with code ${code} without result`,
        });
      }
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
    }).catch((err: unknown) => {
      // Start failed before any event could reach the handlers above. Headers
      // are already sent, so end the stream the same way the error handler does.
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[Streaming] Subprocess start error:", err);
      summarize({ finish: "error", error: message });
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      resolve();
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
  toolNames: Set<string> | null,
  summarize: RequestSummary
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;
    // Set once a response has been written, so a later close is the normal end of the reply
    let replied = false;
    // Set when the client left before the reply; the socket is gone, so nothing is sent
    let clientGone = false;
    // Set once the request has been summarized, so each request is summarized at most once
    let summarized = false;
    // Only one response may be written, and never to a client that has left or already got headers
    const canReply = () => !replied && !clientGone && !res.headersSent;
    const summarizeOnce = (outcome: Parameters<RequestSummary>[0]) => {
      if (!summarized) {
        summarized = true;
        summarize(outcome);
      }
    };
    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    // Handle actual client disconnect before the reply was sent - kill subprocess,
    // since its result would have nowhere to go. A close after the reply is ignored.
    res.on("close", () => {
      if (!replied) {
        clientGone = true;
        summarizeOnce({ finish: "aborted" });
        subprocess.kill();
      }
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      summarizeOnce({ finish: "error", error: error.message });
      if (sessionCtx.resume && sessionCtx.sessionKey) {
        clearSession(sessionCtx.sessionKey);
      }
      if (canReply()) {
        replied = true;
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      // A result that arrives after the client left is dropped: not saved, not sent
      if (finalResult && !clientGone) {
        // An error reply may already have gone out; if so, this result is not sent
        if (canReply()) {
          if (sessionCtx.sessionKey && cliInput.sessionId) {
            setSession(sessionCtx.sessionKey, cliInput.sessionId, sessionCtx.messageCount);
          }
          // An error result (is_error) goes out as an error response, not as a normal reply
          const errorMessage = cliResultErrorMessage(finalResult);
          if (errorMessage !== null) {
            replied = true;
            res.status(500).json({
              error: { message: errorMessage, type: "server_error", code: null },
            });
            summarizeOnce({ finish: "error", error: errorMessage });
          } else {
            const toolReply = toolNames
              ? parseToolCalls(finalResult.result ?? "", toolNames, requestId)
              : null;
            replied = true;
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
            summarizeOnce({
              finish: toolReply ? "tool_calls" : "stop",
              toolCalls: toolReply?.toolCalls.length ?? 0,
              usage: finalResult.usage ? cliUsageToOpenai(finalResult.usage) : undefined,
            });
          }
        }
      } else if (finalResult) {
        // The client left but the CLI finished anyway. A resumed session now
        // holds a reply the client never got, so drop it instead of resuming it.
        if (sessionCtx.resume && sessionCtx.sessionKey) {
          clearSession(sessionCtx.sessionKey);
        }
      } else {
        const message = `Claude CLI exited with code ${code} without response`;
        summarizeOnce({ finish: "error", error: message });
        if (sessionCtx.resume && sessionCtx.sessionKey) {
          clearSession(sessionCtx.sessionKey);
        }
        if (canReply()) {
          replied = true;
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
        summarizeOnce({ finish: "error", error: error.message });
        if (canReply()) {
          replied = true;
          res.status(500).json({
            error: {
              message: error.message,
              type: "server_error",
              code: null,
            },
          });
        }
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
