import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const probe = 'import sys,json; print(json.dumps({"uno_python":1,"executable":sys.executable,"major":sys.version_info.major}))';

export async function resolvePreprocessPython({ signal, env = process.env, platform = process.platform, run = runFile } = {}) {
  signal?.throwIfAborted();
  const override = env.UNO_PYTHON?.trim();
  const candidates = override ? [[override, []]] : platform === 'win32'
    ? [['python', []], ['py', ['-3']], ['python3', []]]
    : [['python3', []], ['python', []]];
  const failures = [];
  for (const [command, prefix] of candidates) {
    signal?.throwIfAborted();
    try {
      const { stdout } = await run(command, [...prefix, '-B', '-X', 'utf8', '-c', probe], {
        env, signal, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 65536, killSignal: 'SIGKILL',
      });
      signal?.throwIfAborted();
      const result = JSON.parse(stdout.trim());
      if (result.uno_python !== 1 || result.major !== 3 || typeof result.executable !== 'string' || !isAbsolute(result.executable)) {
        throw new Error('入口未返回有效的 Python 3 解释器');
      }
      return result.executable;
    } catch (error) {
      signal?.throwIfAborted();
      failures.push({ command, detail: String(error.stderr || error.message).trim().slice(0, 1000) });
    }
  }
  throw Object.assign(new Error(override
    ? 'UNO_PYTHON 指定的 Python 3 不可用，请检查该路径后重试。原件保留，尚未请求模型。'
    : '未找到可运行的 Python 3。请安装 Python 3，或将 UNO_PYTHON 设置为解释器完整路径后重试。原件保留，尚未请求模型。'),
  { code: 'PREPROCESS_PYTHON_UNAVAILABLE', attempts: failures });
}
