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
}

async function getMcpTools(mcpUrl: string) {
  try {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    const client = new Client({ name: "support-chat", version: "1.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    return tools || [];
  } catch (error) {
    console.error("Failed to get MCP tools:", error);
    return [];
  }
}

interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
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
    console.error("Failed to call MCP tool:", error);
    return { content: [{ type: "text", text: `Error calling tool: ${error}` }] };
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

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  const mcpUrl = process.env.MCP_SERVER_URL;

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "API key not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!mcpUrl) {
    return new Response(JSON.stringify({ error: "MCP server URL not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { messages, model, tone }: ChatRequest = await request.json();

  const openai = new OpenAI({ apiKey });

  const mcpTools = await getMcpTools(mcpUrl);
  const openaiTools = convertMcpToolsToOpenAI(mcpTools);

  const systemPrompt = `You are a helpful customer support agent for TechGear, a company that sells computer products including monitors, printers, keyboards, mice, and other peripherals.

${getTonePrompt(tone)}

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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const response = await openai.chat.completions.create({
          model: model || "gpt-4o-mini",
          messages: allMessages,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          stream: true,
        });

        let fullContent = "";
        const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

        for await (const chunk of response) {
          const delta = chunk.choices[0]?.delta;

          if (delta?.content) {
            fullContent += delta.content;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "content", content: delta.content })}\n\n`));
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
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "status", content: "Using tools..." })}\n\n`));

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
              toolMessages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: `Error: ${e}`,
              });
            }
          }

          const followUp = await openai.chat.completions.create({
            model: model || "gpt-4o-mini",
            messages: toolMessages,
            stream: true,
          });

          for await (const chunk of followUp) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "content", content })}\n\n`));
            }
          }
        }

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        controller.close();
      } catch (error) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", content: String(error) })}\n\n`));
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

