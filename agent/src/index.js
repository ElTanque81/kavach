import { config } from "./config.js";
import { Engine } from "./engine.js";
import { startServer } from "./server.js";

const engine = new Engine(config.mode);
try {
  await engine.init();
} catch (e) {
  console.error(`\n[KAVACH] could not start in ${config.mode} mode: ${e.message}`);
  if (config.mode !== "sim") console.error("Tip: `npm run sim` runs fully offline with a simulated market.");
  process.exit(1);
}
startServer(engine, config.port);
if (process.env.AUTO_START !== "false") engine.start();

process.on("SIGINT", () => {
  engine.stop();
  process.exit(0);
});
