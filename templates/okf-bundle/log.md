# Log

Generated build log. The S5 index pass replaces this file with the current run's
build lines, and S6 appends one sweep line when the deep sweep runs. It is a
snapshot of the latest build, not an append-only history.

> **Usage:** read this file to see what the most recent index build did. Per-run
> provenance (job id, source, units processed, timings) lives in the job record
> under `.okf/`, which the job runner writes and never rewrites as a log.
