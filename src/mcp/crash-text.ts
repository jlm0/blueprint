/** A raw TypeError or RangeError comes from a reader that met a shape it does not expect, and the worker sends only its text across the thread. */
export function withCrashFix(error: Error): string {
  if (!(error instanceof TypeError || error instanceof RangeError) || error.message.includes('Fix:')) return error.message;
  return `${error.message}. Fix: call the validate tool, correct each error that it reports, and call this tool again. If validate ends in this same error, report the message as a Blueprint bug.`;
}
