#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createBlueprintMcpServer } from './create-server';

const handle = serveStdio(() => createBlueprintMcpServer(), {
  onerror: error => {
    console.error(error.message);
  }
});

const close = (): void => {
  void handle.close().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
};

process.once('SIGINT', close);
process.once('SIGTERM', close);
