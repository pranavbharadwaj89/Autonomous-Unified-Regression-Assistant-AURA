/** QA runner API base URL for voice E2E orchestration. */

export const DEFAULT_QA_RUNNER_URL =
  import.meta.env.VITE_QA_RUNNER_URL?.trim() || "http://127.0.0.1:3001";
