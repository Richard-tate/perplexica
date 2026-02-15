import Anthropic from '@anthropic-ai/sdk';
import BaseLLM from '../../base/llm';
import {
  GenerateObjectInput,
  GenerateOptions,
  GenerateTextInput,
  GenerateTextOutput,
  StreamTextOutput,
  ToolCall,
} from '../../types';
import { Message } from '@/lib/types';
import z from 'zod';

type MiniMaxConfig = {
  apiKey: string;
  model: string;
  baseURL?: string;
  options?: GenerateOptions;
};

class MiniMaxLLM extends BaseLLM<MiniMaxConfig> {
  anthropicClient: Anthropic;

  constructor(protected config: MiniMaxConfig) {
    super(config);

    this.anthropicClient = new Anthropic({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL || 'https://api.minimax.io/anthropic',
    });
  }

  /**
   * Strip markdown code blocks from JSON response
   */
  stripMarkdownCodeBlocks(text: string): string {
    // Remove ```json or ``` wrappers
    const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      return jsonBlockMatch[1].trim();
    }
    return text;
  }

  /**
   * Sanitize malformed JSON-like text into valid JSON.
   * Handles single-quoted keys/values, unquoted keys, trailing commas,
   * and JavaScript-style comments.
   */
  sanitizeJSON(text: string): string {
    let s = text.trim();

    // Remove single-line comments (// ...)
    s = s.replace(/\/\/[^\n]*/g, '');
    // Remove multi-line comments (/* ... */)
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');

    // Replace single-quoted strings with double-quoted strings
    // Handles keys and values like {'key': 'value'} → {"key": "value"}
    s = s.replace(
      /(?<=[\[{,:\s])\'((?:[^'\\]|\\.)*)\'(?=\s*[,:\]\}])/g,
      '"$1"',
    );

    // Quote unquoted keys: { key: "value" } → { "key": "value" }
    s = s.replace(
      /(?<=[\{,]\s*)([a-zA-Z_]\w*)\s*(?=:)/g,
      '"$1"',
    );

    // Remove trailing commas before } or ]
    s = s.replace(/,\s*([}\]])/g, '$1');

    return s;
  }

  convertToAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
    // Filter out system messages - they should be passed separately via the 'system' parameter
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    return nonSystemMessages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: msg.id,
              content: msg.content,
            },
          ],
        };
      }

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const content: Anthropic.ContentBlockParam[] = [];

        if (msg.content) {
          content.push({ type: 'text' as const, text: msg.content });
        }

        msg.tool_calls.forEach((tc) => {
          content.push({
            type: 'tool_use' as const,
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        });

        return {
          role: 'assistant' as const,
          content,
        };
      }

      return {
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      };
    });
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const anthropicTools: Anthropic.Tool[] = [];

    input.tools?.forEach((tool) => {
      anthropicTools.push({
        name: tool.name,
        description: tool.description,
        input_schema: z.toJSONSchema(tool.schema) as Anthropic.Tool['input_schema'],
      });
    });

    const systemMessage = input.messages.find((m) => m.role === 'system');
    const nonSystemMessages = input.messages.filter((m) => m.role !== 'system');

    const response = await this.anthropicClient.messages.create({
      model: this.config.model,
      system: systemMessage?.content || undefined,
      messages: this.convertToAnthropicMessages(nonSystemMessages),
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_tokens: input.options?.maxTokens ?? this.config.options?.maxTokens ?? 4096,
      stop_sequences: input.options?.stopSequences ?? this.config.options?.stopSequences,
    });

    let content = '';
    let toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        // Only add tool calls with valid names
        if (block.name && block.name.trim()) {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input as Record<string, any>,
          });
        }
      }
    }

    return {
      content,
      toolCalls,
      additionalInfo: {
        finishReason: response.stop_reason || undefined,
      },
    };
  }

  async *streamText(
    input: GenerateTextInput,
  ): AsyncGenerator<StreamTextOutput> {
    const anthropicTools: Anthropic.Tool[] = [];

    input.tools?.forEach((tool) => {
      anthropicTools.push({
        name: tool.name,
        description: tool.description,
        input_schema: z.toJSONSchema(tool.schema) as Anthropic.Tool['input_schema'],
      });
    });

    const systemMessage = input.messages.find((m) => m.role === 'system');
    const nonSystemMessages = input.messages.filter((m) => m.role !== 'system');

    const stream = await this.anthropicClient.messages.stream({
      model: this.config.model,
      system: systemMessage?.content || undefined,
      messages: this.convertToAnthropicMessages(nonSystemMessages),
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_tokens: input.options?.maxTokens ?? this.config.options?.maxTokens ?? 4096,
      stop_sequences: input.options?.stopSequences ?? this.config.options?.stopSequences,
    });

    let receivedToolCalls: { name: string; id: string; arguments: string }[] = [];

    for await (const chunk of stream) {
      if (chunk.type === 'message_start') {
        // Message started
      } else if (chunk.type === 'content_block_start') {
        // Content block started - capture tool info if it's a tool_use block
        if (chunk.content_block?.type === 'tool_use') {
          receivedToolCalls[chunk.index] = {
            name: chunk.content_block.name,
            id: chunk.content_block.id,
            arguments: '',
          };
        }
      } else if (chunk.type === 'content_block_delta') {
        if (chunk.delta.type === 'text_delta') {
          yield {
            contentChunk: chunk.delta.text || '',
            toolCallChunk: [],
            done: false,
            additionalInfo: {},
          };
        } else if (chunk.delta.type === 'input_json_delta') {
          const index = chunk.index;
          if (!receivedToolCalls[index]) {
            receivedToolCalls[index] = {
              name: '',
              id: '',
              arguments: '',
            };
          }
          receivedToolCalls[index].arguments += chunk.delta.partial_json || '';
        }
      } else if (chunk.type === 'content_block_stop') {
        // Content block stopped
      } else if (chunk.type === 'message_delta') {
        // Message delta - end of stream
        yield {
          contentChunk: '',
          toolCallChunk: receivedToolCalls
            .filter((tc) => tc.name && tc.name.trim()) // Filter out invalid tool calls
            .map((tc) => {
            try {
              return {
                name: tc.name,
                id: tc.id,
                arguments: JSON.parse(tc.arguments),
              };
            } catch {
              return {
                name: tc.name,
                id: tc.id,
                arguments: {},
              };
            }
          }),
          done: true,
          additionalInfo: {
            finishReason: chunk.delta.stop_reason || undefined,
          },
        };
      }
    }
  }

  async generateObject<T>(input: GenerateObjectInput): Promise<z.infer<T>> {
    const systemMessage = input.messages.find((m) => m.role === 'system');
    const nonSystemMessages = input.messages.filter((m) => m.role !== 'system');

    const response = await this.anthropicClient.messages.create({
      model: this.config.model,
      system: systemMessage?.content || undefined,
      messages: this.convertToAnthropicMessages(nonSystemMessages),
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_tokens: input.options?.maxTokens ?? this.config.options?.maxTokens ?? 4096,
      stop_sequences: input.options?.stopSequences ?? this.config.options?.stopSequences,
    });

    for (const block of response.content) {
      if (block.type === 'text') {
        const cleanedText = this.stripMarkdownCodeBlocks(block.text);

        // Try strict JSON first
        try {
          return JSON.parse(cleanedText) as z.infer<T>;
        } catch {
          // Fall back to sanitized JSON
        }

        try {
          const sanitized = this.sanitizeJSON(cleanedText);
          return JSON.parse(sanitized) as z.infer<T>;
        } catch (err) {
          throw new Error(`Error parsing response from MiniMax: ${err}`);
        }
      }
    }

    throw new Error('No response from MiniMax');
  }

  async *streamObject<T>(
    input: GenerateObjectInput,
  ): AsyncGenerator<Partial<z.infer<T>>> {
    const systemMessage = input.messages.find((m) => m.role === 'system');
    const nonSystemMessages = input.messages.filter((m) => m.role !== 'system');

    const stream = await this.anthropicClient.messages.stream({
      model: this.config.model,
      system: systemMessage?.content || undefined,
      messages: this.convertToAnthropicMessages(nonSystemMessages),
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_tokens: input.options?.maxTokens ?? this.config.options?.maxTokens ?? 4096,
      stop_sequences: input.options?.stopSequences ?? this.config.options?.stopSequences,
    });

    let receivedObj = '';

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        receivedObj += chunk.delta.text || '';

        try {
          const cleanedObj = this.stripMarkdownCodeBlocks(receivedObj);
          yield JSON.parse(cleanedObj) as Partial<z.infer<T>>;
        } catch {
          // Not valid JSON yet, continue
        }
      } else if (chunk.type === 'message_delta' && chunk.delta.stop_reason === 'end_turn') {
        try {
          const cleanedObj = this.stripMarkdownCodeBlocks(receivedObj);
          yield JSON.parse(cleanedObj) as Partial<z.infer<T>>;
        } catch (err) {
          throw new Error(`Error parsing response from MiniMax: ${err}`);
        }
      }
    }
  }
}

export default MiniMaxLLM;
