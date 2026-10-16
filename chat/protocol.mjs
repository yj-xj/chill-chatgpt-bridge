/** Text-only Chat Completions to official SIWC Responses protocol adapter. */
import { randomUUID } from 'node:crypto';

function protocolError(message, code, status = 502) {
  const error = new Error(message);
  error.name = 'BridgeProtocolError';
  error.code = code;
  error.status = status;
  return error;
}

function invalid(message) {
  return protocolError(message, 'invalid_request_error', 400);
}

function readTextContent(content, description) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || part.type !== 'text' || typeof part.text !== 'string') {
        throw invalid(`${description} supports text content only.`);
      }
      return part.text;
    }).join('');
  }
  throw invalid(`${description} must contain text.`);
}

/**
 * The selected account model takes precedence over the caller's model alias.
 * Only this allowlist is sent upstream: model, input, instructions, store, stream.
 */
export function toResponsesRequest(body, modelSlug) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('The request body must be a JSON object.');
  }
  if (typeof modelSlug !== 'string' || !modelSlug.trim()) {
    throw invalid('Select a model available to the signed-in ChatGPT account.');
  }
  if (body.stream === true) {
    throw invalid('This bridge supports non-streaming Chat Completions requests only.');
  }
  for (const field of ['tools', 'tool_choice', 'parallel_tool_calls', 'functions', 'function_call', 'audio', 'modalities', 'response_format', 'prediction']) {
    if (body[field] !== undefined && body[field] !== null) {
      throw invalid(`The text-only bridge does not support ${field}.`);
    }
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalid('messages must be a non-empty array.');
  }
  if (body.n !== undefined && body.n !== 1) {
    throw invalid('The bridge supports exactly one completion per request (n = 1).');
  }

  const input = [];
  const instructions = [];
  for (const [index, message] of body.messages.entries()) {
    const description = `messages[${index}]`;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw invalid(`${description} must be an object.`);
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(message.role)) {
      throw invalid(`${description} has an unsupported role.`);
    }
    for (const field of ['tool_calls', 'tool_call_id', 'function_call', 'audio', 'refusal']) {
      if (message[field] !== undefined && message[field] !== null) {
        throw invalid(`${description}.${field} is not supported by the text-only bridge.`);
      }
    }
    const content = readTextContent(message.content, description);
    if (message.role === 'system' || message.role === 'developer') {
      instructions.push(content);
    } else {
      input.push({ role: message.role, content });
    }
  }
  const request = { model: modelSlug, input, store: false, stream: true };
  if (instructions.length) request.instructions = instructions.join('\n\n');
  return request;
}

/** Convert one completed Responses result into the format AIChat expects. */
export function buildChatCompletion(result) {
  const completion = {
    id: result.id || `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: result.text },
      finish_reason: 'stop',
    }],
  };
  if (result.usage) {
    const usage = result.usage;
    completion.usage = {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
    };
    if (usage.input_tokens_details) completion.usage.prompt_tokens_details = usage.input_tokens_details;
    if (usage.output_tokens_details) completion.usage.completion_tokens_details = usage.output_tokens_details;
  }
  return completion;
}

/**
 * AIChat 1.10.0's fallback regex stops at any quote, including JSON's \".
 * Unicode escapes represent the same quote without confusing that parser.
 */
export function serializeChatCompletion(completion) {
  const json = JSON.stringify(completion);
  if (typeof json !== 'string') throw new TypeError('A JSON-serializable completion is required.');
  const parts = [];
  let start = 0;
  for (let index = 0; index < json.length; index++) {
    if (json[index] !== '\\') continue;
    if (json[index + 1] === '"') {
      parts.push(json.slice(start, index), '\\u0022');
      start = index + 2;
    }
    // Consume the escaped character as well. In particular, a JSON \\
    // pair cannot make the following string delimiter into an escaped quote.
    index++;
  }
  parts.push(json.slice(start));
  return parts.join('');
}
