/**
 * evaluateAgentMetrics.js
 * ─────────────────────────────────────────────────────────────────────────────
 * End-to-End Agent Evaluation — five dimensions that measure the COMPLETE
 * AI workflow, not just the surface response.
 *
 *  1. Reasoning Quality      — coherence, structure, logical depth
 *  2. Tool Selection Accuracy — was the right tool invoked?
 *  3. Tool Execution Success  — did the tool actually complete its task?
 *  4. Memory Utilization      — effective use of session/conversation context
 *  5. Task Completion Rate    — composite end-to-end success
 *
 * All scorers are pure & synchronous (no API calls).
 * Scores are integers 0–100 or null (not applicable / uncomputable).
 *
 * Usage:
 *   import { evaluateAgentMetrics } from "./evaluateAgentMetrics.js";
 *   const agent = evaluateAgentMetrics({ actualResponse, query, evResult, toolCheck, isMultiTurn });
 */

// ── Internal helpers ──────────────────────────────────────────────────────────

function _weightedAvg(pairs) {
  let wSum = 0, wTotal = 0;
  for (const [val, w] of pairs) {
    if (val !== null && val !== undefined) {
      wSum   += val * w;
      wTotal += w;
    }
  }
  return wTotal > 0 ? Math.round(wSum / wTotal) : null;
}

function _countMatches(text, patterns) {
  return patterns.filter(p => p.test(text)).length;
}

// ── 1. Reasoning Quality ──────────────────────────────────────────────────────
/**
 * Evaluates the logical depth and structure of the response.
 *
 * Signals checked:
 *  + Reasoning connectors ("because", "therefore", "since", "based on", ...)
 *  + Multi-step or structured format (bullets, numbered steps)
 *  + Sufficient response length relative to query complexity
 *  + Non-repetitive — response adds information beyond restating the query
 *  + Conditional / nuanced language ("however", "although", "depending on")
 *  − Pure error/fallback messages score low
 *  − Excessively short responses score low
 *
 * Score 0–100.
 */
const REASONING_CONNECTORS = [
  /\b(because|therefore|since|so that|based on|given that|due to|as a result|consequently|thus|hence|this means|which means|that'?s why|in order to|with this in mind)\b/i,
  /\b(however|although|even though|on the other hand|in contrast|nevertheless|despite|while|whereas)\b/i,
  /\b(first(ly)?|second(ly)?|third(ly)?|finally|additionally|furthermore|moreover|in addition|to summarize)\b/i,
];

const REASONING_STRUCTURE = [
  /^\s*[-•*]\s/m,           // markdown bullets
  /\b\d+[.)]\s+\w/m,        // numbered list
  /\bstep\s+\d+/i,          // step-based explanation
  /\bfor example\b|\bsuch as\b|\blike\b.*\bfor instance\b/i,
];

const SHORT_FALLBACK = [
  /^(ok|okay|sure|alright|got it|understood|i see)[.!]?\s*$/i,
  /^(yes|no|maybe|perhaps)[.!]?\s*$/i,
  /^i('?m| am) sorry[,.]/i,
];

export function scoreReasoningQuality(actualResponse, query = "") {
  if (!actualResponse) return null;
  if (SHORT_FALLBACK.some(p => p.test(actualResponse.trim()))) return 10;

  let score = 45; // neutral baseline

  // Reasoning connectors
  const connectors = _countMatches(actualResponse, REASONING_CONNECTORS);
  score += Math.min(20, connectors * 8);

  // Structured format
  const structures = _countMatches(actualResponse, REASONING_STRUCTURE);
  score += Math.min(15, structures * 8);

  // Length signal
  const words = actualResponse.split(/\s+/).filter(Boolean).length;
  if      (words >= 50)  score += 15;
  else if (words >= 20)  score += 8;
  else if (words < 6)    score -= 25;

  // Non-repetition: penalise if response echoes query too closely
  if (query.length > 10) {
    const qTokens  = new Set(query.toLowerCase().replace(/[^\w\s]/g," ").split(/\s+/).filter(w => w.length > 3));
    const rTokens  = new Set(actualResponse.toLowerCase().replace(/[^\w\s]/g," ").split(/\s+/));
    const overlap  = qTokens.size > 0 ? [...qTokens].filter(w => rTokens.has(w)).length / qTokens.size : 0;
    if (overlap > 0.75) score -= 15;
  }

  // Specificity bonus: contains concrete data (numbers, names, places)
  if (/\b\d+(?:\.\d+)?/.test(actualResponse)) score += 5;

  return Math.max(0, Math.min(100, score));
}

// ── 2. Tool Selection Accuracy ────────────────────────────────────────────────
/**
 * Measures whether the correct tool/function was selected for the query.
 *
 * Uses the `toolCheck` object produced by checkToolRouting() in intentToolMap.js.
 * When toolCheck is not available, falls back to intent-match heuristics.
 *
 * Score 0–100.
 */
export function scoreToolSelectionAccuracy(toolCheck, evResult) {
  // Direct tool-routing check result
  if (toolCheck) {
    if (toolCheck.isCorrect === true)         return 100;
    if (toolCheck.isCorrect === false)        return 0;
    if (toolCheck.expectedTool === "unknown") return evResult?.intentMatch ? 80 : 40;
  }
  // No tool metadata — infer from intent match
  if (evResult?.intentMatch)  return 75;
  if (evResult?.pass)         return 65;
  return 20;
}

// ── 3. Tool Execution Success ─────────────────────────────────────────────────
/**
 * Determines whether the invoked tool successfully completed its task and
 * returned a valid, non-error response.
 *
 * Checks for:
 *  - Error intent (type = "error") → failure
 *  - Service-failure / fallback patterns in response → partial/full failure
 *  - Concrete result data in response → success
 *  - Generic "I can help with…" fallback → failure
 *
 * Score 0–100.
 */
const EXECUTION_FAILURES = [
  /\bunable to (retrieve|access|fetch|get|find|load|connect to|check)\b/i,
  /\b(service|connection|network|api|server)\s+(error|unavailable|failed|timed? ?out|not responding)\b/i,
  /\b(check|try) (back|again) (later|in a (moment|bit|few))\b/i,
  /\bnot (configured|available|set up|enabled) (for|in|at)\b/i,
  /\bfailed to (execute|run|process|complete|perform)\b/i,
  /\b(something went wrong|an error occurred|encountered an (issue|error|problem))\b/i,
  /\bi('m| am) (currently )?(unable|not able) to (access|retrieve|get|fetch)\b/i,
  /\bi can('t| not) (access|retrieve|find|get|check) (that|this|the)\b/i,
  /\b(please|kindly) (check|verify|confirm) (your|the) (settings|configuration|connection)\b/i,
];

const EXECUTION_SUCCESSES = [
  /\b(here('?s| is)|here are|the (current|latest|live|real-?time))\b/i,
  /\b(navigat(ing|e|ed)|set(ting)? (a )?(reminder|alarm|route))\b/i,
  /\b(currently|right now|as of|at the moment)\b.{0,30}\b\d+\b/i,
  /\b\d+(?:\.\d+)?\s*(?:°[CF]|km\/h?|m\/s|mph|%|°|min|hrs?|sec(onds?)?)\b/i,
  /\b(temperature|humidity|visibility|wind|forecast|precipitation|pressure)\b.{0,20}\b\d+\b/i,
  /\b(eta|arrival|departure|duration|distance|route)\b/i,
  /\b(found|located|showing|displaying|playing|calling|dialing)\b/i,
];

const GENERIC_FALLBACK_AGENT = [
  /\bi (heard|can hear) you\b/i,
  /\bi can help with (navigation|weather|reminders|music|calls)\b/i,
  /\bwhat (can i|would you like (me to)?|may i)\b/i,
];

export function scoreToolExecutionSuccess(actualResponse, evResult) {
  if (!actualResponse) return null;

  // Generic assistant fallback (tool was never called)
  if (GENERIC_FALLBACK_AGENT.some(p => p.test(actualResponse))) return 0;

  // Error type from backend
  if (evResult?.actualIntent === "error") return 15;

  const failCount    = _countMatches(actualResponse, EXECUTION_FAILURES);
  const successCount = _countMatches(actualResponse, EXECUTION_SUCCESSES);

  if (failCount >= 3)    return 5;
  if (failCount === 2)   return 20;
  if (failCount === 1)   return successCount >= 1 ? 55 : 35;

  if (successCount >= 3) return 100;
  if (successCount >= 2) return 90;
  if (successCount === 1) return 75;

  // No strong signals — use intent pass/fail as a proxy
  return evResult?.pass ? 65 : 30;
}

// ── 4. Memory Utilization ─────────────────────────────────────────────────────
/**
 * Measures how well the AI uses conversation context and session data.
 *
 * Two tiers:
 *  a. Multi-turn conversations: does the response reference earlier turns?
 *  b. Single-turn queries: does the response leverage session context
 *     (user location, timezone, name, preferences)?
 *
 * Returns null for isolated single-turn queries with no context signals
 * (not applicable — can't fail what was never needed).
 *
 * Score 0–100 or null.
 */
const CONVERSATIONAL_CONTEXT = [
  /\b(as (you|i) (mentioned|said|asked|noted)|you (previously|just) (asked|mentioned|said))\b/i,
  /\b(continuing (from|with|our)|building on (your|our) (previous|earlier|last))\b/i,
  /\b(following up (on)?|regarding (your|the) (earlier|previous|last))\b/i,
  /\b(referr?ing to (your|the) (earlier|previous|last|prior))\b/i,
  /\b(from (our|the) (earlier|previous|last) (conversation|chat|exchange|message))\b/i,
];

const SESSION_CONTEXT = [
  /\b(your (current )?location|where you (are|'re))\b/i,
  /\b(your (local |current )?time(zone)?|your time zone)\b/i,
  /\b(your (name|profile|preferences|saved|favourite|favorite))\b/i,
  /\b(as (set|configured|saved) in your (settings|preferences|profile|account))\b/i,
  /\b(based on your (location|position|settings|history|preferences))\b/i,
  /\b(in (your|the) timezone|in your area|near you)\b/i,
];

export function scoreMemoryUtilization(
  actualResponse,
  { isMultiTurn = false, turnNo = 1, hasSessionContext = false } = {}
) {
  if (!actualResponse) return null;

  const convRefs    = _countMatches(actualResponse, CONVERSATIONAL_CONTEXT);
  const sessionRefs = _countMatches(actualResponse, SESSION_CONTEXT);

  // Multi-turn: conversation memory is expected
  if (isMultiTurn || turnNo > 1) {
    if (convRefs >= 2)   return 100;
    if (convRefs === 1)  return 85;
    if (sessionRefs >= 1) return 70;
    return 45; // multi-turn but no explicit reference (context may be implicit)
  }

  // Single-turn with session data provided (timezone, location, etc.)
  if (hasSessionContext || sessionRefs > 0) {
    if (sessionRefs >= 2) return 95;
    if (sessionRefs === 1) return 80;
    return 40; // context was available but seemingly unused
  }

  // Isolated single-turn — memory utilization not applicable
  return null;
}

// ── 5. Overall Task Completion Rate ───────────────────────────────────────────
/**
 * Composite end-to-end success score.
 * Weights:
 *   Intent accuracy (pass/fail)  30%
 *   Tool selection accuracy       25%
 *   Tool execution success        25%
 *   Response confidence           20%
 *
 * Score 0–100.
 */
export function scoreTaskCompletion(evResult, toolCheck, actualResponse) {
  const intentScore  = evResult?.pass ? 100 : evResult?.intentMatch ? 55 : 0;
  const toolSel      = scoreToolSelectionAccuracy(toolCheck, evResult);
  const toolExec     = scoreToolExecutionSuccess(actualResponse, evResult);
  const confScore    = evResult?.confidence ?? 50;

  return _weightedAvg([
    [intentScore,  0.30],
    [toolSel,      0.25],
    [toolExec,     0.25],
    [confScore,    0.20],
  ]);
}

// ── Combined entry point ──────────────────────────────────────────────────────
/**
 * Run all five End-to-End Agent metrics in one call.
 *
 * @param {object}  p
 * @param {string}  p.actualResponse  — model's actual reply
 * @param {string}  [p.query]         — original user input
 * @param {object}  [p.evResult]      — result from evaluateResult() (pass, confidence, actualIntent, …)
 * @param {object}  [p.toolCheck]     — result from checkToolRouting() (isCorrect, expectedTool, actualTool)
 * @param {boolean} [p.isMultiTurn]   — true if this is a multi-turn conversation
 * @param {number}  [p.turnNo]        — turn number (>1 means prior turns exist)
 * @param {boolean} [p.hasSessionContext] — true if timezone/location/profile was injected
 *
 * @returns {AgentMetrics}
 */
export function evaluateAgentMetrics({
  actualResponse,
  query          = "",
  evResult       = null,
  toolCheck      = null,
  isMultiTurn    = false,
  turnNo         = 1,
  hasSessionContext = false,
} = {}) {
  const reasoningScore      = scoreReasoningQuality(actualResponse, query);
  const toolSelectionScore  = scoreToolSelectionAccuracy(toolCheck, evResult);
  const toolExecutionScore  = scoreToolExecutionSuccess(actualResponse, evResult);
  const memoryScore         = scoreMemoryUtilization(actualResponse, { isMultiTurn, turnNo, hasSessionContext });
  const taskCompletionScore = scoreTaskCompletion(evResult, toolCheck, actualResponse);

  return {
    reasoningScore,
    toolSelectionScore,
    toolExecutionScore,
    memoryScore,
    taskCompletionScore,
  };
}

// ── UI metadata ───────────────────────────────────────────────────────────────

export const AGENT_METRIC_META = {
  reasoningScore: {
    label: "Reasoning Quality",
    color: "#00e5ff",
    icon:  "🧠",
    desc:  "Coherence, structure, and logical depth of the response",
  },
  toolSelectionScore: {
    label: "Tool Selection Accuracy",
    color: "#a78bfa",
    icon:  "⚙",
    desc:  "Whether the correct tool / function was invoked for the intent",
  },
  toolExecutionScore: {
    label: "Tool Execution Success",
    color: "#10b981",
    icon:  "✓",
    desc:  "Whether the invoked tool completed its task and returned valid data",
  },
  memoryScore: {
    label: "Memory Utilization",
    color: "#f59e0b",
    icon:  "◉",
    desc:  "Effective use of session context and multi-turn conversation memory",
  },
  taskCompletionScore: {
    label: "Task Completion Rate",
    color: "#f97316",
    icon:  "★",
    desc:  "End-to-end composite: intent + tool selection + execution + confidence",
  },
};

export function agentMetricColor(score) {
  if (score === null || score === undefined) return "#475569";
  return score >= 80 ? "#10b981" : score >= 55 ? "#f59e0b" : "#ef4444";
}
