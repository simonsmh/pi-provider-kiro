// Feature 5: Message Transformation

import { createHash } from "node:crypto";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

export interface KiroImage {
  format: string;
  source: { bytes: string };
}
export interface KiroToolUse {
  name: string;
  toolUseId: string;
  input: Record<string, unknown>;
}
export interface KiroToolResult {
  content: Array<{ text?: string; json?: unknown }>;
  status: "success" | "error";
  toolUseId: string;
}
export interface KiroToolSpec {
  toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, unknown> } };
}
export interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: "KIRO_CLI";
  images?: KiroImage[];
  userInputMessageContext?: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] };
}
export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: KiroToolUse[];
}
export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: KiroAssistantResponseMessage;
}

export const TOOL_RESULT_LIMIT = 250000;
export const MAX_KIRO_TOOL_DESCRIPTION = 1024;
export const MAX_KIRO_TOOL_USE_ID = 64;

export function sanitizeSurrogates(text: string): string {
  // Replace unpaired high surrogates (0xD800-0xDBFF not followed by low surrogate)
  // Replace unpaired low surrogates (0xDC00-0xDFFF not preceded by high surrogate)
  // Properly paired surrogates (e.g. emoji like 🙈) are preserved.
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.substring(0, half)}\n... [TRUNCATED] ...\n${text.substring(text.length - half)}`;
}

export function safeParseArgs(args: unknown): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function normalizeKiroToolUseId(id: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) return id;
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 16);
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "tool";
  return `${safe.slice(0, MAX_KIRO_TOOL_USE_ID - hash.length - 1)}_${hash}`;
}

export function formatToolResultContent(text: string): Array<{ text?: string; json?: unknown }> {
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed);
      return [{ json: parsed }];
    } catch {
      // ignore JSON parse error, fallback to text
    }
  }
  return [{ text }];
}

export function normalizeMessages(messages: Message[]): Message[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    const am = msg as AssistantMessage;
    return am.stopReason !== "error" && am.stopReason !== "aborted";
  });
}

export function extractImages(msg: Message): ImageContent[] {
  if (msg.role === "toolResult" || typeof msg.content === "string") return [];
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((c): c is ImageContent => c.type === "image");
}

export function getContentText(msg: Message): string {
  if (msg.role === "toolResult") return msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (c.type === "text") return (c as TextContent).text;
        if (c.type === "thinking") return (c as ThinkingContent).thinking;
        return "";
      })
      .join("");
  }
  return "";
}

const KIRO_REJECTED_SCHEMA_KEYS = new Set([
  "additionalProperties",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "contentEncoding",
  "contentMediaType",
  "$schema",
  "patternProperties",
  "propertyNames",
  "dependentSchemas",
  "dependentRequired",
  "if",
  "then",
  "else",
  "contains",
  "unevaluatedProperties",
  "unevaluatedItems",
  "oneOf",
  "anyOf",
  "allOf",
  "$ref",
]);

const SCHEMA_MAP_KEYS = new Set(["properties", "$defs", "definitions"]);

function sanitizeSchemaMap(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return sanitizeKiroSchema(value);
  const out: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    out[name] = sanitizeKiroSchema(child);
  }
  return out;
}

function sanitizeKiroSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeKiroSchema);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (KIRO_REJECTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "required" && Array.isArray(child) && child.length === 0) continue;
    out[key] = SCHEMA_MAP_KEYS.has(key) ? sanitizeSchemaMap(child) : sanitizeKiroSchema(child);
  }
  return out;
}

function ensureRootObjectType(schema: unknown): Record<string, unknown> {
  const obj = schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as Record<string, unknown>) : {};
  return obj.type === "object" ? obj : { ...obj, type: "object" };
}

export function convertToolsToKiro(tools: Tool[]): KiroToolSpec[] {
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description.slice(0, MAX_KIRO_TOOL_DESCRIPTION),
      inputSchema: { json: ensureRootObjectType(sanitizeKiroSchema(tool.parameters)) },
    },
  }));
}

export function convertImagesToKiro(images: Array<{ mimeType: string; data: string }>): KiroImage[] {
  return images.map((img) => ({ format: img.mimeType.split("/")[1] || "png", source: { bytes: img.data } }));
}

export function buildHistory(
  messages: Message[],
  modelId: string,
  systemPrompt?: string,
): { history: KiroHistoryEntry[]; systemPrepended: boolean; currentMsgStartIdx: number } {
  const history: KiroHistoryEntry[] = [];
  let systemPrepended = false;
  const toolResultLimit = TOOL_RESULT_LIMIT;

  let currentMsgStartIdx = messages.length - 1;
  while (currentMsgStartIdx > 0 && messages[currentMsgStartIdx].role === "toolResult") currentMsgStartIdx--;
  if (currentMsgStartIdx >= 0 && messages[currentMsgStartIdx].role === "assistant") {
    const am = messages[currentMsgStartIdx] as AssistantMessage;
    if (!Array.isArray(am.content) || !am.content.some((b) => b.type === "toolCall")) currentMsgStartIdx++;
  }

  const historyMessages = messages.slice(0, currentMsgStartIdx);

  for (let i = 0; i < historyMessages.length; i++) {
    const msg = historyMessages[i];
    if (msg.role === "user") {
      let content = typeof msg.content === "string" ? msg.content : getContentText(msg);
      if (systemPrompt && !systemPrepended) {
        content = `${systemPrompt}\n\n${content}`;
        systemPrepended = true;
      }
      const images = extractImages(msg);
      const uim: KiroUserInputMessage = {
        content: sanitizeSurrogates(content),
        modelId,
        origin: "KIRO_CLI",
        ...(images.length > 0 ? { images: convertImagesToKiro(images) } : {}),
      };
      const lastEntryForUim = history[history.length - 1];
      const prevUim = lastEntryForUim?.userInputMessage;
      if (prevUim) {
        // Merge into previous user message to maintain alternation without synthetic padding
        prevUim.content += `\n\n${uim.content}`;
        if (uim.images) prevUim.images = [...(prevUim.images || []), ...uim.images];
      } else {
        history.push({ userInputMessage: uim });
      }
    } else if (msg.role === "assistant") {
      let armContent = "";
      const armToolUses: KiroToolUse[] = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") armContent += (block as TextContent).text;
          else if (block.type === "toolCall") {
            const tc = block as ToolCall;
            armToolUses.push({
              name: tc.name,
              toolUseId: normalizeKiroToolUseId(tc.id),
              input: safeParseArgs(tc.arguments),
            });
          }
        }
      }
      if (!armContent && armToolUses.length === 0) continue;
      history.push({
        assistantResponseMessage: { content: armContent, ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}) },
      });
    } else if (msg.role === "toolResult") {
      const trMsg = msg as ToolResultMessage;
      const toolResults: KiroToolResult[] = [
        {
          content: formatToolResultContent(truncate(getContentText(msg), toolResultLimit)),
          status: trMsg.isError ? "error" : "success",
          toolUseId: normalizeKiroToolUseId(trMsg.toolCallId),
        },
      ];
      const trImages: ImageContent[] = [];
      if (Array.isArray(trMsg.content))
        for (const c of trMsg.content) if (c.type === "image") trImages.push(c as ImageContent);
      let j = i + 1;
      while (j < historyMessages.length && historyMessages[j].role === "toolResult") {
        const next = historyMessages[j] as ToolResultMessage;
        toolResults.push({
          content: formatToolResultContent(truncate(getContentText(next), toolResultLimit)),
          status: next.isError ? "error" : "success",
          toolUseId: normalizeKiroToolUseId(next.toolCallId),
        });
        if (Array.isArray(next.content))
          for (const c of next.content) if (c.type === "image") trImages.push(c as ImageContent);
        j++;
      }
      i = j - 1;
      const lastEntryForTr = history[history.length - 1];
      const prevTr = lastEntryForTr?.userInputMessage;
      if (prevTr) {
        if (trImages.length > 0) prevTr.images = [...(prevTr.images || []), ...convertImagesToKiro(trImages)];
        if (!prevTr.userInputMessageContext) prevTr.userInputMessageContext = {};
        prevTr.userInputMessageContext.toolResults = [
          ...(prevTr.userInputMessageContext.toolResults || []),
          ...toolResults,
        ];
      } else {
        history.push({
          userInputMessage: {
            content: "",
            modelId,
            origin: "KIRO_CLI",
            ...(trImages.length > 0 ? { images: convertImagesToKiro(trImages) } : {}),
            userInputMessageContext: { toolResults },
          },
        });
      }
    }
  }
  return { history, systemPrepended, currentMsgStartIdx };
}
