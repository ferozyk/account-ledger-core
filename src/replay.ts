import { replay } from "./engine.js";
import { createJsonLogger } from "./logger.js";
import { formatReplay } from "./report.js";
import { SCENARIO_CONFIG, SCENARIO_EVENTS } from "./scenario.js";

/** Structured logs go to stderr, the human-readable report to stdout. */
function main(): number {
  const logger = createJsonLogger((line) => process.stderr.write(`${line}\n`));
  try {
    const result = replay(SCENARIO_CONFIG, SCENARIO_EVENTS, logger);
    process.stdout.write(`${formatReplay(result)}\n`);
    // Business rejections are expected outcomes, not failures.
    return 0;
  } catch (error) {
    logger.error("replay.failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

process.exitCode = main();
