import { existsSync } from 'node:fs';

/** Actionable command used by capture when its deterministic browser dependency is unavailable. */
export const CHROMIUM_INSTALL_COMMAND = 'npx playwright install chromium';

/** Creates the stable user-facing browser dependency error used before capture side effects. */
export function createChromiumDependencyError(): Error {
  return new Error(
    `Blueprint capture requires a local Playwright Chromium browser. Run \`${CHROMIUM_INSTALL_COMMAND}\` and try again.`
  );
}

/**
 * Verifies that Playwright's resolved Chromium executable is present before capture begins.
 *
 * @throws {Error} With an actionable install command when the executable is missing.
 */
export function assertChromiumExecutableAvailable(
  executablePath: string,
  fileExists: (filePath: string) => boolean = existsSync
): void {
  if (!fileExists(executablePath)) {
    throw createChromiumDependencyError();
  }
}
