#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createBlueprintMcpServer } from './create-server';

const handle = serveStdio(() => createBlueprintMcpServer(), {
  onerror: error => {
    console.error(error.message);
  }
});

let closing: Promise<void> | undefined;
const close = (): Promise<void> => {
  closing ??= handle.close().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  return closing;
};

const requestClose = (): void => {
  void close();
};

process.stdin.once('end', requestClose);
process.stdin.once('close', requestClose);
process.once('SIGINT', requestClose);
process.once('SIGTERM', requestClose);
