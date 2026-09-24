const quiet = process.env.LOG_LEVEL === 'silent' || process.env.NODE_TEST_CONTEXT !== undefined;
function emit(level: string, msg: string, extra?: Record<string, unknown>) {
  if (quiet) return;
  // Never log message bodies or tokens: ids and event kinds only.
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
}
export const log = {
  info: (m: string, e?: Record<string, unknown>) => emit('info', m, e),
  warn: (m: string, e?: Record<string, unknown>) => emit('warn', m, e),
  error: (m: string, e?: Record<string, unknown>) => emit('error', m, e),
};
