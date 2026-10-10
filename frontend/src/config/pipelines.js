/**
 * Pipeline isolation — each pipeline must be invoked standalone by default.
 * Cross-pipeline OpenAI usage only when the explicit opt-in below is used.
 *
 * | Pipeline            | Entry point                         | OpenAI usage                    | Opt-in chains                          |
 * |---------------------|-------------------------------------|---------------------------------|----------------------------------------|
 * | Regression          | runRegression()                     | CARA agent via /process-text    | None                                   |
 * | PRISM benchmark     | POST /prism/run-compare             | Direct model calls only         | with_judge=true → LLM judge            |
 * | PRISM Verify Models | GET /prism/ping-models              | 1 ping per model                | None (manual button only)              |
 * | PRISM Judge All     | POST /prism/judge-batch             | 1 judge call per result cell    | None (manual button only)              |
 * | PRD extract         | POST /prd/extract-requirements      | gpt-4o extraction               | None                                   |
 * | PRD generate        | POST /prd/generate-test-cases       | gpt-4o generation               | None                                   |
 * | PRD combined        | POST /prd/pipeline                  | extract + generate              | allowCombinedPipeline=true required    |
 * | PRD run tests       | runSelectedTests() in PRD wizard    | CARA agent via /process-text    | confirm dialog required                |
 * | Judge LLM eval      | POST /judge/run-evaluation          | Judge LLM (Prompt 1+2) + opt executor | Manual panel only; report to UI      |
 */

export const PIPELINE_OPT_IN = {
  /** PRISM: POST /prism/run-compare body field */
  PRISM_WITH_JUDGE: "with_judge",
  /** PRD: POST /prd/pipeline body field */
  PRD_COMBINED_PIPELINE: "allowCombinedPipeline",
  /** Judge: POST /judge/run-evaluation body field */
  JUDGE_WITH_EXECUTOR: "withExecutor",
};

export default PIPELINE_OPT_IN;
