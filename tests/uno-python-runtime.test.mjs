import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolvePreprocessPython } from '../packages/nexogenesis-tools/lib/uno/python-runtime.js';

const executable = resolve('test Python', 'python.exe');
const valid = () => ({ stdout: JSON.stringify({ uno_python: 1, executable, major: 3 }) });

test('Windows Store alias failure falls back to the Python 3 launcher and binds its executable', async () => {
  const calls = [];
  const result = await resolvePreprocessPython({ env: {}, platform: 'win32', run: async (command, args, options) => {
    calls.push({ command, args });
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 5000);
    if (command === 'python') throw Object.assign(new Error('exit 9009'), { stderr: 'Python was not found; run without arguments to install from the Microsoft Store' });
    assert.equal(command, 'py');
    assert.equal(args[0], '-3');
    return valid();
  } });
  assert.equal(result, executable);
  assert.deepEqual(calls.map(call => call.command), ['python', 'py']);
});

test('working default Python remains selected without running fallback commands', async () => {
  const calls = [];
  assert.equal(await resolvePreprocessPython({ env: {}, platform: 'win32', run: async command => {
    calls.push(command); return valid();
  } }), executable);
  assert.deepEqual(calls, ['python']);
});

test('explicit UNO_PYTHON is verified and never silently replaced', async () => {
  const env = { UNO_PYTHON: executable };
  assert.equal(await resolvePreprocessPython({ env, run: async (command, args) => {
    assert.equal(command, executable); assert.equal(args[0], '-B'); return valid();
  } }), executable);
  const calls = [];
  await assert.rejects(resolvePreprocessPython({ env, run: async command => {
    calls.push(command); throw new Error('ENOENT');
  } }), error => error.code === 'PREPROCESS_PYTHON_UNAVAILABLE' && /UNO_PYTHON/.test(error.message));
  assert.deepEqual(calls, [executable]);
});

test('invalid responses, Python 2 and unavailable commands do not pass the probe', async () => {
  const calls = [];
  await assert.rejects(resolvePreprocessPython({ env: {}, platform: 'win32', run: async command => {
    calls.push(command);
    if (command === 'python') return { stdout: 'Store placeholder' };
    if (command === 'py') return { stdout: JSON.stringify({ uno_python: 1, executable, major: 2 }) };
    throw new Error('ENOENT');
  } }), error => error.code === 'PREPROCESS_PYTHON_UNAVAILABLE' && error.attempts.length === 3);
  assert.deepEqual(calls, ['python', 'py', 'python3']);
});

test('Unix uses python3 and timed-out probes can fall back', async () => {
  const calls = [];
  assert.equal(await resolvePreprocessPython({ env: {}, platform: 'linux', run: async command => {
    calls.push(command);
    if (command === 'python3') throw new Error('probe timed out');
    return valid();
  } }), executable);
  assert.deepEqual(calls, ['python3', 'python']);
});

test('cancellation before or during discovery never tries another interpreter', async () => {
  const controller = new AbortController(), reason = new Error('cancelled');
  let calls = 0;
  const run = async () => { calls++; controller.abort(reason); throw reason; };
  await assert.rejects(resolvePreprocessPython({ env: {}, signal: controller.signal, run }), error => error === reason);
  assert.equal(calls, 1);
  await assert.rejects(resolvePreprocessPython({ env: {}, signal: controller.signal, run }), error => error === reason);
  assert.equal(calls, 1);
});
