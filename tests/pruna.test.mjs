import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(readFileSync(new URL('../worker/src/pruna.ts', import.meta.url), 'utf8'));
const { prunaInput, prunaRequest, prunaImage, trustedPrunaUrl } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('person, garments and optional pose remain distinct', () => {
  const refs = ['person', 'shirt', 'jacket', 'pose'].map(url => ({ url }));
  const input = prunaInput(refs, 'preserve identity', true);
  assert.equal(input.person_image, 'person');
  assert.deepEqual(input.garment_images, ['shirt', 'jacket']);
  assert.equal(input.reference_pose, 'pose');
  assert.equal(input.turbo, false);
  assert.equal(input.preserve_input_size, true);
  assert.deepEqual(prunaInput(refs.slice(0, 3), '', false).garment_images, ['shirt', 'jacket']);
});

test('async submission, status, error redaction and delivery security', async () => {
  const original = globalThis.fetch;
  const calls = [];
  let payload = { id: 'prediction-1', status: 'starting' };
  let status = 200;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(payload), { status });
  };
  try {
    const input = prunaInput([{ url: 'person' }, { url: 'shirt' }], '', false);
    assert.equal((await prunaRequest('test-secret', input)).id, 'prediction-1');
    assert.equal(calls[0].options.redirect, 'manual');
    assert.equal(calls[0].options.headers.Model, 'p-image-try-on');
    assert.deepEqual(JSON.parse(calls[0].options.body), { input });
    assert.equal(calls[0].options.headers['Try-Sync'], undefined);
    payload = { status: 'succeeded', generation_url: 'https://api.pruna.ai/v1/predictions/delivery/result' };
    assert.equal((await prunaRequest('test-secret', 'prediction/1')).status, 'succeeded');
    assert.match(calls[1].url, /prediction%2F1$/);
    assert.equal(calls[1].options.method, 'GET');
    payload = { error: { message: 'invalid test-secret credential' } };
    status = 401;
    const before = calls.length;
    await assert.rejects(prunaRequest('test-secret', input), /HTTP 401: invalid \[redacted\] credential/);
    assert.equal(calls.length, before + 1, 'paid submission must not retry');
    for (const url of ['https://evil.example/v1/predictions/delivery/x', 'https://api.pruna.ai.evil.example/v1/predictions/delivery/x', 'https://api.pruna.ai/v1/other', 'https://user@api.pruna.ai/v1/predictions/delivery/x']) {
      assert.equal(trustedPrunaUrl(url), false);
      await assert.rejects(prunaImage('test-secret', url), /untrusted/);
    }
    assert.equal(calls.length, before + 1, 'untrusted host must never receive credential');
    status = 200;
    payload = { message: 'x'.repeat(70000) };
    await assert.rejects(prunaRequest('test-secret', 'id'), /unreadable response/);
  } finally { globalThis.fetch = original; }
});
