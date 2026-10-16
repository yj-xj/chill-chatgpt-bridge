import test from 'node:test';
import assert from 'node:assert/strict';
import { toResponsesRequest, buildChatCompletion, serializeChatCompletion } from '../chat/protocol.mjs';

test('maps all text history and system/developer instructions without forbidden upstream parameters', () => {
  const actual = toResponsesRequest({
    model: 'caller-alias', temperature: 0.8, top_p: 0.9, max_tokens: 100,
    max_output_tokens: 100, metadata: { example: true }, previous_response_id: 'old',
    store: true, stream: false, user: 'not-forwarded', n: 1,
    messages: [
      { role: 'system', content: 'Act as the character.' },
      { role: 'developer', content: [{ type: 'text', text: 'Be brief.' }] },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，朋友。' },
      { role: 'user', content: [{ type: 'text', text: 'Play ' }, { type: 'text', text: 'music.' }] },
    ],
  }, 'account-model');
  assert.deepEqual(actual, {
    model: 'account-model',
    input: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，朋友。' },
      { role: 'user', content: 'Play music.' },
    ],
    store: false,
    stream: true,
    instructions: 'Act as the character.\n\nBe brief.',
  });
});

test('omits instructions when absent and rejects invalid/non-text requests', () => {
  assert.deepEqual(toResponsesRequest({ messages: [{ role: 'user', content: '' }] }, 'm'), {
    model: 'm', input: [{ role: 'user', content: '' }], store: false, stream: true,
  });
  for (const bad of [
    null, {}, { messages: [] },
    { messages: [{ role: 'tool', content: 'output' }] },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } }] }] },
    { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] },
    { messages: [{ role: 'assistant', content: '', tool_calls: [] }] },
    { messages: [{ role: 'assistant', content: null }] },
    ...['tools', 'tool_choice', 'functions', 'function_call', 'audio', 'modalities', 'response_format', 'prediction'].map((field) => ({ messages: [{ role: 'user', content: 'x' }], [field]: [] })),
    { messages: [{ role: 'user', content: 'x' }], stream: true },
    { messages: [{ role: 'user', content: 'x' }], n: 2 },
  ]) {
    assert.throws(() => toResponsesRequest(bad, 'm'), { name: 'BridgeProtocolError', code: 'invalid_request_error', status: 400 });
  }
  assert.throws(() => toResponsesRequest({ messages: [{ role: 'user', content: 'x' }] }, ''), /Select a model/);
});

test('builds the non-streaming response shape AIChat reads and maps token usage', () => {
  const completion = buildChatCompletion({
    id: 'resp_test', model: 'account-model', text: '你好，世界。',
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, output_tokens_details: { reasoning_tokens: 1 } },
  });
  assert.equal(completion.id, 'resp_test');
  assert.equal(completion.object, 'chat.completion');
  assert.equal(completion.model, 'account-model');
  assert.ok(Number.isInteger(completion.created));
  assert.deepEqual(completion.choices, [{
    index: 0, message: { role: 'assistant', content: '你好，世界。' }, finish_reason: 'stop',
  }]);
  assert.deepEqual(completion.usage, {
    prompt_tokens: 5, completion_tokens: 3, total_tokens: 8,
    completion_tokens_details: { reasoning_tokens: 1 },
  });
});

test('completion without SDK metadata gets a unique ID and no invented usage', () => {
  const first = buildChatCompletion({ model: 'm', text: 'Hello' });
  const second = buildChatCompletion({ model: 'm', text: 'Hello' });
  assert.match(first.id, /^chatcmpl-[a-f0-9-]+$/);
  assert.notEqual(first.id, second.id);
  assert.equal('usage' in first, false);
  assert.deepEqual(buildChatCompletion({ model: 'm', text: '', usage: { input_tokens: 2, output_tokens: 3 } }).usage, {
    prompt_tokens: 2, completion_tokens: 3, total_tokens: 5,
  });
});

// AIChat/Core/ResponseParser.cs ExtractContentRegex uses (.*?) here. Unlike
// JavaScript's dot, the .NET dot excludes only LF, so spell that out explicitly.
// For JSON.stringify's escape subset, parsing the captured JSON string models
// Regex.Unescape without requiring .NET in the portable offline test suite.
function extractAIChatContent(json) {
  const match = /"content"\s*:\s*"([^\n]*?)"/.exec(json);
  return match ? JSON.parse(`"${match[1]}"`) : null;
}

test('serialization lets AIChat regex read complete replies containing quotes', () => {
  const text = '她说："你好！"\n路径 C:\\music\\，再见。';
  const completion = buildChatCompletion({ model: 'm', text });
  // Regular JSON is correct but exposes the plugin's escaped-quote bug.
  assert.throws(() => extractAIChatContent(JSON.stringify(completion)), SyntaxError);
  const serialized = serializeChatCompletion(completion);
  assert.equal(extractAIChatContent(serialized), text);
  assert.deepEqual(JSON.parse(serialized), completion);
  assert.ok(serialized.includes('\\u0022你好！\\u0022'));
});

test('serialization preserves quote/backslash parity and trailing backslash delimiters', () => {
  for (let preceding = 0; preceding <= 8; preceding++) {
    for (let trailing = 0; trailing <= 8; trailing++) {
      const text = `前缀${'\\'.repeat(preceding)}"quoted"末尾${'\\'.repeat(trailing)}`;
      const completion = buildChatCompletion({ model: 'm', text });
      const serialized = serializeChatCompletion(completion);
      assert.deepEqual(JSON.parse(serialized), completion, `JSON parity ${preceding}/${trailing}`);
      assert.equal(extractAIChatContent(serialized), text, `AIChat parity ${preceding}/${trailing}`);
    }
  }
});

test('serialization preserves JSON values, literal escape text, controls and Unicode', () => {
  const parts = ['"', '\\', '\n', '\r', '\t', '\b', '\f', '\0', '中', '🌙', '\u2028', '\u2029', '\ud800', '\\u0022', '\\n'];
  for (const first of parts) {
    for (const second of parts) {
      const text = first + second;
      const completion = buildChatCompletion({ model: 'm', text });
      const serialized = serializeChatCompletion(completion);
      assert.deepEqual(JSON.parse(serialized), completion);
      assert.equal(extractAIChatContent(serialized), text);
    }
  }
  const arbitraryJSON = {
    'key"with\\escapes': ['text"', 'ends\\', null, false, 12, { value: '\\"\\u0022\u0001' }],
  };
  assert.deepEqual(JSON.parse(serializeChatCompletion(arbitraryJSON)), JSON.parse(JSON.stringify(arbitraryJSON)));
});

