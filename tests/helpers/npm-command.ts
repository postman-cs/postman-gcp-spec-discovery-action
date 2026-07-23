import { win32 } from 'node:path';

export interface NpmCommand {
  command: string;
  args: string[];
}

export function selectNpmCommand(
  platform: NodeJS.Platform,
  nodeExecPath: string,
  npmExecPath?: string,
): NpmCommand {
  if (platform !== 'win32') return { command: 'npm', args: [] };

  const npmCliPath = npmExecPath?.trim()
    || win32.join(win32.dirname(nodeExecPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return { command: nodeExecPath, args: [npmCliPath] };
}
