export function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason ?? new DOMException('已取消', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', aborted);
    const aborted = () => { cleanup(); reject(signal.reason ?? new DOMException('已取消', 'AbortError')); };
    signal.addEventListener('abort', aborted, {once:true});
    promise.then(value => {cleanup(); resolve(value);}, error => {cleanup(); reject(error);});
  });
}
