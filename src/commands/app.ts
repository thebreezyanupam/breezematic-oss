import { env } from '../config.js';
import { out } from '../log.js';
import { startAppServer } from '../app/server.js';

export type AppOptions = {
  port?: number;
  host: string;
};

export async function appCommand(options: AppOptions): Promise<number> {
  const port = options.port ?? env.BREEZEMATIC_APP_PORT;
  await startAppServer({ port, host: options.host });

  out(`BreezeMatic  http://${options.host}:${port}`);
  out('one run at a time; Ctrl-C to stop');

  // Serve until the process is killed.
  return new Promise<number>(() => {});
}
