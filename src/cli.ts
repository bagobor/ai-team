import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { startDaemon } from './daemon.ts';
import { resolvePaths } from './paths.ts';
import { runSetup } from './setup/setup.ts';

const USAGE = `Usage:
  aiteam setup    Create ~/.aiteam and print the agent-home login command
  aiteam daemon   Run the engine and serve the API until stopped`;

async function main(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  const [command] = positionals;
  const paths = resolvePaths();

  switch (command) {
    case 'setup': {
      const { created, loginCommand } = await runSetup(paths);
      for (const path of created) console.log(`Created ${path}`);
      console.log(`Log the agent home in once, in your own terminal:\n  ${loginCommand}`);
      return 0;
    }
    case 'daemon': {
      const daemon = await startDaemon({ paths, config: loadConfig(paths) });
      console.log(`Listening on http://127.0.0.1:${daemon.port}`);
      const stopThenExit = () => {
        daemon.stop().then(
          () => process.exit(0),
          (err: unknown) => {
            console.error(err);
            process.exit(1);
          },
        );
      };
      process.once('SIGINT', stopThenExit);
      process.once('SIGTERM', stopThenExit);
      return new Promise<number>(() => {});
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
