/**
 * The dry-run preview (INGEST-03).
 *
 * `previewJob` is the inspectable number the user sees before committing:
 * one enumeration, the same filters the job will run, and the locked integer
 * cost model. It writes nothing — no job directory, no event, no raw capture —
 * and has no job id, so it cannot create state by accident.
 *
 * It calls the same `enumerateChannel` that the runner's S0 calls. The preview
 * number therefore cannot diverge from the job it describes.
 */
import { enumerateChannel, type EnumerateResult } from "./enumerate.js";
import {
  applyFilters,
  estimateCalls,
  estimateMinutes,
  type FilterInput,
  type FilteredUnit,
} from "./filters.js";
import { normalizeChannelUrl } from "./urls.js";

/** The preview form: the create form minus `vaultId`. */
export interface PreviewInput extends FilterInput {
  channelUrl: string;
}

export interface PreviewResult {
  /** The number of enumerated candidates, before filters. */
  found: number;
  /** Present only when the scan cap was reached; never a false total. */
  foundAtLeast?: boolean;
  /** The number of candidates left after filters and `maxVideos`. */
  selected: number;
  skipped: FilteredUnit[];
  estimatedCalls: number;
  estimatedMinutes: number;
}

export interface PreviewDeps {
  enumerate(
    url: string,
    opts: { maxVideos: number },
    signal?: AbortSignal,
  ): Promise<EnumerateResult>;
}

const DEFAULT_DEPS: PreviewDeps = {
  enumerate: (url, opts, signal) => enumerateChannel(url, { ...opts, signal }),
};

/**
 * Enumerate, filter, estimate. No filesystem call happens anywhere in this
 * path, so a preview can never leave a job directory or a `raw/` file behind.
 */
export async function previewJob(
  input: PreviewInput,
  deps: PreviewDeps = DEFAULT_DEPS,
): Promise<PreviewResult> {
  // Enumeration only ever receives the canonical `/videos` URL.
  const url = normalizeChannelUrl(input.channelUrl);
  const { candidates, foundAtLeast } = await deps.enumerate(url, {
    maxVideos: input.maxVideos,
  });
  const { selected, skipped } = applyFilters(candidates, {
    maxVideos: input.maxVideos,
    ...(input.dateFrom !== undefined ? { dateFrom: input.dateFrom } : {}),
    ...(input.dateTo !== undefined ? { dateTo: input.dateTo } : {}),
    ...(input.minDurationSec !== undefined
      ? { minDurationSec: input.minDurationSec }
      : {}),
    ...(input.language !== undefined ? { language: input.language } : {}),
  });

  return {
    found: candidates.length,
    ...(foundAtLeast ? { foundAtLeast: true as const } : {}),
    selected: selected.length,
    skipped,
    estimatedCalls: estimateCalls(selected.length),
    estimatedMinutes: estimateMinutes(selected.length),
  };
}
