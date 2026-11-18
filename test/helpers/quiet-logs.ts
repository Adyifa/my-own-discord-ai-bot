import { configureLogger } from "../../src/logger.js";

// Keep test output readable; failures are asserted explicitly instead.
configureLogger({ level: "silent" });
