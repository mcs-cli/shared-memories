#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import module from "node:module";

// Before any .mts loads: from Node 23 the cache also skips type stripping, most of a hook's startup.
module.enableCompileCache?.();
const { main } = await import("./lib/status-main.mts");
main(import.meta.dirname);
