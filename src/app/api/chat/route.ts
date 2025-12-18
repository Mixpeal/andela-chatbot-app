import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const runtime = "nodejs";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatRequest {
  messages: Message[];
  model: string;
  tone: string;
  language: string;
}

interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
}

interface McpError {
  source: "mcp";
  operation: string;
  message: string;
  details?: string;
}

async function getMcpTools(mcpUrl: string): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>; error?: McpError }> {
  try {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    const client = new Client({ name: "support-chat", version: "1.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    return { tools: tools || [] };
  } catch (error) {
    const err = error as Error;
    console.error("[MCP] Failed to get tools:", err.message);
    return {
      tools: [],
      error: {
        source: "mcp",
        operation: "listTools",
        message: "Failed to connect to MCP server",
        details: err.message,
      },
    };
  }
}

async function callMcpTool(mcpUrl: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    const client = new Client({ name: "support-chat", version: "1.0.0" });
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: args });
    await client.close();
    return result as McpToolResult;
  } catch (error) {
    const err = error as Error;
    console.error(`[MCP] Failed to call tool ${toolName}:`, err.message);
    return { content: [{ type: "text", text: `MCP tool error (${toolName}): ${err.message}` }] };
  }
}

function convertMcpToolsToOpenAI(mcpTools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>) {
  return mcpTools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema || { type: "object", properties: {} },
    },
  }));
}

function getTonePrompt(tone: string): string {
  const tones: Record<string, string> = {
    professional: "Respond in a professional, formal manner. Be courteous and efficient.",
    friendly: "Be warm, friendly, and conversational. Use a casual but helpful tone.",
    concise: "Keep responses brief and to the point. Avoid unnecessary elaboration.",
  };
  return tones[tone] || tones.professional;
}

function getLanguageName(code: string): string {
  const languages: Record<string, string> = {
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    pt: "Portuguese",
    zh: "Chinese",
    ja: "Japanese",
    ko: "Korean",
    ar: "Arabic",
  };
  return languages[code] || "English";
}

function formatError(source: string, message: string, details?: string): string {
  let formatted = `[${source.toUpperCase()}] ${message}`;
  if (details) formatted += ` - ${details}`;
  return formatted;
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  const mcpUrl = process.env.MCP_SERVER_URL;

  const encoder = new TextEncoder();

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "OPENAI_API_KEY environment variable is not set" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!mcpUrl) {
    return new Response(
      JSON.stringify({ error: "MCP_SERVER_URL environment variable is not set" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let requestBody: ChatRequest;
  try {
    requestBody = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON in request body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { messages, model, tone, language } = requestBody;
  const openai = new OpenAI({ apiKey });

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        send({ type: "status", content: "Connecting to MCP server..." });
        const { tools: mcpTools, error: mcpError } = await getMcpTools(mcpUrl);

        if (mcpError) {
          send({ type: "warning", content: `MCP: ${mcpError.message} (${mcpError.details}). Proceeding without tools.` });
        } else if (mcpTools.length === 0) {
          send({ type: "warning", content: "MCP: No tools available from server." });
        } else {
          send({ type: "status", content: `MCP: Connected (${mcpTools.length} tools available)` });
        }

        const openaiTools = convertMcpToolsToOpenAI(mcpTools);

        const languageName = getLanguageName(language);
        const systemPrompt = `You are a helpful customer support agent for TechGear, a company that sells computer products including monitors, printers, keyboards, mice, and other peripherals.

${getTonePrompt(tone)}

IMPORTANT: Always respond in ${languageName}. The customer prefers ${languageName}.

Your job is to help customers with:
- Product information and recommendations
- Order status and tracking
- Returns and refunds
- Technical support
- General inquiries

Use the available tools to look up information when needed. Always be helpful and provide accurate information.`;

        const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
          { role: "system", content: systemPrompt },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ];

        send({ type: "status", content: "Connecting to OpenAI..." });

        let response;
        try {
          response = await openai.chat.completions.create({
            model: model || "gpt-4o-mini",
            messages: allMessages,
            tools: openaiTools.length > 0 ? openaiTools : undefined,
            stream: true,
          });
        } catch (openaiError) {
          const err = openaiError as Error & { status?: number; code?: string };
          let errorMsg = "OpenAI API error";

          if (err.status === 401 || err.message?.includes("401") || err.message?.includes("Unauthorized")) {
            errorMsg = "OpenAI: Invalid API key. Please check OPENAI_API_KEY.";
          } else if (err.status === 429 || err.message?.includes("429")) {
            errorMsg = "OpenAI: Rate limit exceeded. Please try again later.";
          } else if (err.status === 500 || err.message?.includes("500")) {
            errorMsg = "OpenAI: Server error. Please try again.";
          } else if (err.code === "ENOTFOUND" || err.message?.includes("ENOTFOUND")) {
            errorMsg = "OpenAI: Network error - cannot reach api.openai.com";
          } else {
            errorMsg = `OpenAI: ${err.message || "Unknown error"}`;
          }

          send({ type: "error", content: errorMsg });
          controller.close();
          return;
        }

        let fullContent = "";
        const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

        for await (const chunk of response) {
          const delta = chunk.choices[0]?.delta;

          if (delta?.content) {
            fullContent += delta.content;
            send({ type: "content", content: delta.content });
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index !== undefined) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = { id: tc.id || "", name: tc.function?.name || "", arguments: "" };
                }
                if (tc.id) toolCalls[tc.index].id = tc.id;
                if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
                if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
              }
            }
          }
        }

        if (toolCalls.length > 0) {
          const toolNames = toolCalls.map((tc) => tc.name).join(", ");
          send({ type: "status", content: `Using tools: ${toolNames}` });

          const toolMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            ...allMessages,
            {
              role: "assistant",
              content: fullContent || null,
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            },
          ];

          for (const tc of toolCalls) {
            try {
              const args = JSON.parse(tc.arguments || "{}");
              const result = await callMcpTool(mcpUrl, tc.name, args);
              const resultText = result.content?.map((c) => c.text).join("\n") || JSON.stringify(result);
              toolMessages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: resultText,
              });
            } catch (e) {
              const err = e as Error;
              toolMessages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: formatError("mcp", `Tool ${tc.name} failed`, err.message),
              });
            }
          }

          try {
            const followUp = await openai.chat.completions.create({
              model: model || "gpt-4o-mini",
              messages: toolMessages,
              stream: true,
            });

            for await (const chunk of followUp) {
              const content = chunk.choices[0]?.delta?.content;
              if (content) {
                send({ type: "content", content });
              }
            }
          } catch (followUpError) {
            const err = followUpError as Error;
            send({ type: "error", content: formatError("openai", "Follow-up request failed", err.message) });
          }
        }

        send({ type: "done" });
        controller.close();
      } catch (error) {
        const err = error as Error;
        let errorType = "unknown";
        let errorMsg = err.message || "Unknown error";

        if (errorMsg.includes("fetch") || errorMsg.includes("network") || errorMsg.includes("ENOTFOUND")) {
          errorType = "network";
          errorMsg = `Network error: Unable to reach external services. ${errorMsg}`;
        } else if (errorMsg.includes("JSON")) {
          errorType = "parse";
          errorMsg = `Data parsing error: ${errorMsg}`;
        }

        console.error(`[${errorType.toUpperCase()}] ${errorMsg}`);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", content: errorMsg, errorType })}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
