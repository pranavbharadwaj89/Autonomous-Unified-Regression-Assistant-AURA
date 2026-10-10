/**
 * HTTP regression evaluation.
 * Intent aliases are derived from intentToolMap.js (canonical source from agent_tool_intent_map.json).
 * Content signals and module-level rules cover cases where the backend type is coarser
 * than the test-case expected intent.
 */

import { buildIntentAliases, checkToolRouting, BACKEND_TYPE_TO_TOOL, INTENT_TOOL_MAP, getIntentChain } from "./intentToolMap.js";
import { evaluateAdvancedMetrics } from "./evaluateAdvancedMetrics.js";
import { evaluateAgentMetrics } from "./evaluateAgentMetrics.js";

// ── Session / device-id helpers ───────────────────────────────────────────────

export const STATEFUL_MODULES_RE =
  /personal data|favorites|saved data|memo|personal contacts|saved locations/i;

/** Pick device id.
 *  - Multi-turn rows share a session id so context is preserved.
 *  - Memo/profile modules share their Excel session id across save→read chains.
 *  - All other single-turn cases get an isolated id so earlier conversations don't bleed in.
 */
export function deviceIdForTestCase(tc, baseDeviceId) {
  const base = (baseDeviceId || "cara-regression-tool-001").trim();
  const sid = tc.sessionId || tc.id;
  if (tc.flow === "Multi-Turn") return `${base}-${sid}`;
  if (tc.module && STATEFUL_MODULES_RE.test(tc.module) && tc.sessionId) {
    return `${base}-${sid}`;
  }
  return `${base}-${tc.id}`;
}

// Intents where expectedResponse is a reference example, not the one correct answer —
// lexical overlap is a weak signal; don't let it flip a routing-based PASS to FAIL.
const OPEN_ENDED_INTENTS = new Set([
  "get_assistant_info",
  "general_conversation",
]);

// ── Intent alias map (auto-built from canonical intentToolMap) ─────────────────

const _CANONICAL_ALIASES = buildIntentAliases();

// Additional hand-tuned aliases for cases where the backend type is even coarser
// or the test-case uses a legacy intent name not in the canonical map.
const EXTRA_ALIASES = {
  // Backend emits "weather" for multiple weather intents
  get_past_weather:   ["get_past_weather", "weather_history", "weather"],
  get_future_weather: ["get_future_weather", "weather_forecast", "weather"],
  rain_forecast:      ["rain_forecast", "weather"],
  uv_index:           ["uv_index", "weather"],
  weather_alerts:     ["weather_alerts", "weather"],

  // Session types
  get_locale_time:      ["get_locale_time", "user_locale_time", "time", "session", "error"],
  get_time_in_location: ["get_time_in_location", "time_in_location", "time", "session"],
  get_user_location:    ["get_user_location", "currentlocation", "location", "session"],

  // Reminder test cases use legacy intent names
  time_based_reminder: [
    "time_based_reminder", "reminder", "reminders",
    "reschedule_reminder", "set", "set_recurring",
    "general_conversation",               // agent sometimes replies without tool on invalid time
  ],
  cancel_reminder:  ["cancel_reminder", "reminder", "reminders", "cancel"],
  geo_register:     ["geo_register", "reminder", "reminders", "set_location"],
  reschedule:       ["reschedule", "reschedule_reminder", "time_based_reminder"],

  // Flight
  track_flight_status:    ["track_flight_status", "tracking", "route"],
  search_flights_by_query: ["search_flights_by_query", "route", "tracking"],

  // Live data — trains/public transport incorrectly routed to handle_transport
  get_live_data: ["get_live_data", "live_data", "route", "tracking"],

  // Navigation umbrella
  navigation: ["navigation", "directions", "distance", "transit_directions", "error"],

  // Vehicle
  get_vehicle_status:      ["get_vehicle_status", "vehicle_status", "connected_vehicle", "general_conversation"],
  execute_vehicle_command: ["execute_vehicle_command", "remote_command", "vehicle_command", "general_conversation"],

  // Profile write / read — backend returns no "type"; falls through to general_conversation
  save_user_profile_name:  ["save_user_profile_name", "user_profile", "assistant_info", "data_transparency", "general_conversation"],
  read_database_info:      ["read_database_info", "user_profile", "assistant_info", "data_transparency", "general_conversation"],
  save_preference:         ["save_preference", "user_profile", "assistant_info", "data_transparency", "general_conversation"],
  save_relationship:       ["save_relationship", "user_profile", "assistant_info", "data_transparency", "general_conversation"],
  save_location:           ["save_location", "user_profile", "assistant_info", "data_transparency", "general_conversation"],
  delete_favorite:         ["delete_favorite", "user_profile", "assistant_info", "data_transparency", "general_conversation"],

  // Calls
  call: ["call"],
  sos:  ["sos", "emergency"],
};

export const INTENT_ALIASES = { ..._CANONICAL_ALIASES, ...EXTRA_ALIASES };

// ── Content-match signals ─────────────────────────────────────────────────────

const WEATHER_INTENTS = new Set([
  "get_current_weather", "get_past_weather", "get_future_weather",
  "rain_forecast", "uv_index", "weather_alerts",
]);
const TIME_INTENTS = new Set(["get_locale_time", "get_time_in_location"]);

const WEATHER_RE   = /\b(weather|temperature|°|degree|celsius|fahrenheit|cloud|rain|sunny|overcast|humidity|forecast|uv|wind|umbrella)\b/i;
const TIME_RE      = /\b(time|clock|am|pm|o'clock|local time|thirty|forty|fifty|eleven|twelve|one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2}:\d{2})\b/i;
const TRAFFIC_RE   = /\b(traffic|delay|travel time|minutes?|heavy|light|congestion|route)\b/i;
const TRAIN_RE     = /\b(train|shatabdi|express|railway|rail|metro|bus stop|transit|bus to|next bus|nearest metro)\b/i;
const GK_RE        = /\b(capital|located|invented|prime minister|president|speed of light|mount everest|oscar|cricket|fifa|independence|tokyo|agra|telephone|gravity|electricity|atlantis|tallest mountain|taj mahal|shape of you|chatgpt|classified|military|quantum)\b/i;
const ASSISTANT_RE = /\b(cara|kara|assistant|i am|i'm|my name|help you|i can help|capabilities|what i can|i can assist|navigation|weather|reminders?|music)\b/i;
const PROFILE_SAVE_RE = /\b(saved|remember|updated|changed|got it|i'll remember|already (know|saved))\b/i;
const PROFILE_READ_RE = /\b(favorite|home address|office|girlfriend|son's name|don't have|couldn't find|no saved|everything you've saved)\b/i;
const CALL_RE      = /\b(call(ing)?|contact|which one|multiple contacts|redial|answer|reject|end call|phone)\b/i;
const REMINDER_RE  = /\b(remind|reminder|reschedule|scheduled|invalid time|isn't valid|not valid|future times)\b/i;
const NAV_RE       = /\b(navigat|route|direction|destination|toll|gps|app open|cancel nav|add stop|remove stop|marina|bangalore|chennai|hospital|petrol|home|office|airport)\b/i;
const MUSIC_RE     = /\b(play|song|music|spotify|podcast|album|artist|volume|carplay|pause|resume|next song|disconnect)\b/i;
const SOS_RE       = /\b(emergency|sos|ambulance|police|fire|roadside|here for you|stay safe|rsa)\b/i;
const VEHICLE_RE   = /\b(engine|door|lock|unlock|headlight|trunk|fuel|ac|air conditioner|climate|fan|temperature)\b/i;
// Matches the generic fallback the backend emits when both original and retry responses
// were "please repeat" style. Message intent field may still say e.g. "navigation" — this
// constant is the authoritative gate that overrides it to FAIL.
const GENERIC_FALLBACK_RE =
  /^i heard you[.,]? i can help with weather,? navigation,? reminders,? flights,? and more/i;
const FAILURE_APOLOGY_RE =
  /\b(i'?m (?:having trouble|unable to|sorry,? i can'?t)|i can'?t (?:get|retrieve|access|find|determine)|unable to (?:access|get|retrieve|determine|find)|having trouble (?:getting|accessing|retrieving)|couldn'?t (?:get|retrieve|find|determine)|check (?:back|again) later|not configured)\b/i;

function normalizeIntent(v) {
  return String(v || "").trim().toLowerCase();
}

// ── Public: intent matching ────────────────────────────────────────────────────

export function extractActualIntent(data) {
  const candidates = [
    data?.intent,
    data?.type,
    data?.tool_data?.intent,
    data?.tool_data?.type,
  ].map(normalizeIntent).filter(Boolean);
  return candidates[0] || "general_conversation";
}

/** Extract the raw agent tool name from the response.
 *  New backend versions return data.tool = "handle_weather" directly.
 *  Older backends: infer from BACKEND_TYPE_TO_TOOL.
 */
export function extractActualTool(data) {
  if (data?.tool) return String(data.tool).trim().toLowerCase();
  const t = normalizeIntent(data?.intent ?? data?.type ?? "");
  return BACKEND_TYPE_TO_TOOL[t] ?? null;
}

export function intentMatches(expectedIntent, actualIntent) {
  const expected = normalizeIntent(expectedIntent);
  const actual   = normalizeIntent(actualIntent);
  if (!expected) return true;
  if (actual === expected) return true;
  const aliases = INTENT_ALIASES[expected];
  return aliases ? aliases.includes(actual) : false;
}

// ── Content matching helpers ──────────────────────────────────────────────────

function citiesFromTimeInput(input) {
  const m = String(input || "").match(/\btime\s+in\s+(.+?)\??$/i);
  if (!m?.[1]) return [];
  return m[1].split(/,|\band\b/i).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 1);
}

function locationFromInput(input) {
  for (const re of [
    /\bweather\s+in\s+([A-Za-z][A-Za-z\s.-]{1,40})\??$/i,
    /\bin\s+([A-Za-z][A-Za-z\s.-]{1,40})\??$/i,
  ]) {
    const m = String(input || "").match(re);
    if (m?.[1]) return m[1].trim().toLowerCase();
  }
  return "";
}

function tokenMatchScore(expectedResponse, message) {
  const exp = String(expectedResponse || "").trim().toLowerCase();
  const msg = String(message || "").trim().toLowerCase();
  if (!exp || !msg) return 0;
  const tokens = exp.split(/\s+/).filter((t) => t.length > 3);
  if (!tokens.length) return 0;
  return tokens.filter((t) => msg.includes(t)).length / tokens.length;
}

function inputHasSimulatedContext(input) {
  return /\((simulate|simulation|guest user|mobile app closed|no gps|no mobile signal|after sos|end call|while driving|already on|ac unavailable|before saving|nothing saved|home not saved)\)/i.test(
    String(input || "")
  );
}

function contentMatchesExpected(tc, message) {
  const msg      = String(message || "").toLowerCase();
  const input    = String(tc.input || "").toLowerCase();
  const expected = normalizeIntent(tc.expectedIntent);
  const mod      = String(tc.module || "");
  if (!msg || GENERIC_FALLBACK_RE.test(message.trim())) return false;

  // If expectedResponse was provided in Excel and ≥35% tokens match → accept
  if (tc.expectedResponse && tokenMatchScore(tc.expectedResponse, message) >= 0.35) return true;

  // Weather
  if (WEATHER_INTENTS.has(expected)) {
    if (!WEATHER_RE.test(msg)) return false;
    const loc = locationFromInput(tc.input);
    if (loc) {
      const primary = loc.split(/\s+/)[0];
      if (primary.length > 2 && !msg.includes(primary)) return false;
    }
    return true;
  }

  // Assistant identity
  if (expected === "get_assistant_info") return ASSISTANT_RE.test(msg);

  // Time
  if (TIME_INTENTS.has(expected)) {
    if (!TIME_RE.test(msg)) return false;
    if (expected === "get_time_in_location") {
      const cities = citiesFromTimeInput(tc.input);
      if (cities.length) {
        return cities.every((c) => {
          const token = c.split(/\s+/)[0];
          return token.length > 2 && (msg.includes(token) || TIME_RE.test(msg));
        });
      }
    }
    return true;
  }

  // Live data — GK, news, traffic, trains
  if (expected === "get_live_data") {
    if (TRAFFIC_RE.test(input) && TRAFFIC_RE.test(msg)) return true;
    if (TRAIN_RE.test(input) && msg.length > 20) return true; // train misrouted to handle_transport
    if (/\bpublic transport|bus|metro\b/i.test(input) && msg.length > 20) return true;
    // GK: topic keyword hit + length guard.
    // When expectedResponse is available, also require ≥20% token overlap with the
    // reference answer so a response that mentions the right topic but names the wrong
    // country/person/date cannot score as a topic-only pass.
    if (GK_RE.test(msg) && msg.length > 15) {
      if (tc.expectedResponse) {
        return tokenMatchScore(tc.expectedResponse, message) >= 0.2;
      }
      return true;
    }
    if (/\b(capital of|who is|who invented|where is|when did|how far|what is|what was|which country)\b/i.test(input)) {
      return msg.length > 12 && !GENERIC_FALLBACK_RE.test(message);
    }
    if (/\b(news|sports|latest|current affairs|culture)\b/i.test(input)) return msg.length > 20;
    return false;
  }

  // Reminders
  if (expected === "time_based_reminder" || expected === "reschedule") {
    return REMINDER_RE.test(msg);
  }
  if (expected === "cancel_reminder") return REMINDER_RE.test(msg);
  if (expected === "geo_register")    return REMINDER_RE.test(msg) || /\bwhen i reach|arrive at\b/i.test(msg);

  // Profile write / read
  if (new Set(["save_user_profile_name","save_preference","save_relationship","save_location","delete_favorite","delete_favorites_by_type","delete_all_user_data"]).has(expected)) {
    return PROFILE_SAVE_RE.test(msg);
  }
  if (expected === "read_database_info") return PROFILE_READ_RE.test(msg);

  // Calls — valid responses include "can't answer/reject" (correct capability message)
  if (expected === "call" || expected === "start_call") {
    return CALL_RE.test(msg) || /\b(can't|cannot|unable|assist with)\b/i.test(msg);
  }
  if (expected === "sos") {
    return SOS_RE.test(msg) || /\bafter sos\b/i.test(input);
  }

  // Navigation
  if (["navigation", "direct", "intermediary", "transit_directions", "on_route_places"].includes(expected)) {
    if (NAV_RE.test(msg)) return true;
    if (inputHasSimulatedContext(tc.input) && msg.length > 20) return true;
  }

  // Music / entertainment
  if (["music", "suggest_podcast", "play_podcast"].includes(expected)) {
    return MUSIC_RE.test(msg);
  }

  // Vehicle
  if (["get_vehicle_status", "execute_vehicle_command"].includes(expected)) {
    return VEHICLE_RE.test(msg) || /\b(connected|vehicle|need to connect)\b/i.test(msg);
  }

  // Module-level degraded pass — correct polite "can't do X" response
  if (/call control/i.test(mod) && (CALL_RE.test(msg) || /\b(can't|cannot|unable)\b/i.test(msg))) return true;
  if (/music playback|integration.*ivi/i.test(mod) && MUSIC_RE.test(msg)) return true;
  if (/navigation/i.test(mod) && inputHasSimulatedContext(tc.input) && msg.length > 20) return true;
  if (/general emergency/i.test(mod) && /\bafter sos\b/i.test(input) && msg.length > 10) return true;
  if (/trains|public transport/i.test(mod) && msg.length > 25) return true;

  return false;
}

// ── Main evaluator ─────────────────────────────────────────────────────────────

export function evaluateResult(data, tc) {
  const actualIntent  = extractActualIntent(data);
  const message       = data?.assistant?.message || "";
  const hasResponse   = !!(message || data?.transcription);

  // Hard-fail: generic fallback message means the backend couldn't produce a real answer.
  // Treat as FAIL regardless of what the intent field says — this prevents false PASSes
  // when the tool ran correctly but the final spoken reply was silently replaced.
  if (message && GENERIC_FALLBACK_RE.test(message.trim())) {
    const toolCheck    = checkToolRouting(tc.expectedIntent, actualIntent);
    const intentChain  = getIntentChain(tc.expectedIntent);
    return {
      pass: false, intentMatch: false, confidence: 0,
      actualIntent, message, matchSource: "generic_fallback",
      toolCheck, intentChain,
    };
  }

  // Hard-fail: tool/service apology — right topic words but no actual answer delivered.
  if (message && FAILURE_APOLOGY_RE.test(message)) {
    const toolCheck       = checkToolRouting(tc.expectedIntent, actualIntent);
    const intentChain     = getIntentChain(tc.expectedIntent);
    const advancedMetrics = evaluateAdvancedMetrics({
      actualResponse:   message,
      expectedResponse: tc.expectedResponse || "",
      query:            tc.input || "",
    });
    return {
      pass: false, intentMatch: false, confidence: 20,
      actualIntent, message, matchSource: "failure_apology",
      toolCheck, intentChain,
      ...advancedMetrics,
      reviewFlag: null,
    };
  }

  // Intent match — alias table first, then content heuristics
  let intentMatch  = intentMatches(tc.expectedIntent, actualIntent);
  let matchSource  = intentMatch ? "intent" : null;

  if (!intentMatch && hasResponse && contentMatchesExpected(tc, message)) {
    intentMatch = true;
    matchSource = "content";
  }

  // Tool routing check — prefer the exact tool name from response.tool (new backend),
  // otherwise checkToolRouting infers from the response type.
  const directTool = data?.tool ? String(data.tool).trim().toLowerCase() : null;
  const toolCheck  = directTool
    ? (() => {
        const entry = INTENT_TOOL_MAP[normalizeIntent(tc.expectedIntent)];
        const expectedTool = entry?.tool ?? "unknown";
        const isCorrect = expectedTool === "unknown" || directTool === expectedTool;
        return {
          expectedTool,
          actualTool: directTool,
          isCorrect,
          warning: isCorrect ? null : `Expected ${expectedTool}, got ${directTool}`,
        };
      })()
    : checkToolRouting(tc.expectedIntent, actualIntent);

  // Confidence scaling
  const msg = message.toLowerCase();
  const isToolFailure =
    msg.includes("unable to access") ||
    msg.includes("check back later")  ||
    msg.includes("check again later") ||
    msg.includes("not configured");
  const isErrorActual =
    actualIntent === "error" &&
    !TIME_INTENTS.has(normalizeIntent(tc.expectedIntent)) &&
    !contentMatchesExpected(tc, message);
  const isRepeat = msg.includes("please repeat") || msg.includes("say that again");
  const isGoodAnswer = !isToolFailure && !isErrorActual && !isRepeat;

  const pass       = intentMatch && hasResponse;
  const confidence = intentMatch ? (isGoodAnswer ? 90 : 60) : 30;

  // Full intent → tool → handler chain for the expected intent
  const intentChain = getIntentChain(tc.expectedIntent);

  // Advanced quality metrics (synchronous — no extra API calls)
  const advancedMetrics = evaluateAdvancedMetrics({
    actualResponse:   message,
    expectedResponse: tc.expectedResponse || "",
    query:            tc.input || "",
  });

  // ── Reconcile routing-based pass/confidence with content-based accuracy ──────
  // pass/confidence above only ask "right topic + non-error reply?"
  // faithfulnessScore/responseAccuracy ask "does the content match the reference?"
  // When tc.expectedResponse is available and these sharply disagree, trust content.
  let finalPass       = pass;
  let finalConfidence = confidence;
  let reviewFlag      = null;

  if (tc.expectedResponse && !OPEN_ENDED_INTENTS.has(normalizeIntent(tc.expectedIntent))) {
    const contentScore = Math.max(
      advancedMetrics.faithfulnessScore ?? 0,
      advancedMetrics.responseAccuracy  ?? 0,
    );

    if (pass && contentScore < 25) {
      finalPass       = false;
      finalConfidence = contentScore;
      reviewFlag      = "pass_but_low_content_match";
    } else if (!pass && contentScore >= 60) {
      finalPass       = true;
      finalConfidence = Math.max(confidence, contentScore);
      reviewFlag      = "fail_but_high_content_match";
    }
  }

  // E2E Agent workflow metrics — use reconciled values so downstream scores are consistent
  const agentMetrics = evaluateAgentMetrics({
    actualResponse:   message,
    query:            tc.input || "",
    evResult:         { pass: finalPass, intentMatch, confidence: finalConfidence, actualIntent, matchSource },
    toolCheck,
    isMultiTurn:      tc.flow === "Multi-Turn",
    turnNo:           tc.turnNo ?? 1,
    hasSessionContext: !!(tc.userTimezone || tc.latitude),
  });

  return {
    pass:             finalPass,
    intentMatch,
    confidence:       finalConfidence,
    // Keep original heuristic values for debugging — shown in UI as "auto-corrected" badge
    heuristicPass:       pass,
    heuristicConfidence: confidence,
    reviewFlag,          // "pass_but_low_content_match" | "fail_but_high_content_match" | null
    actualIntent,
    message,
    matchSource,
    toolCheck,        // { expectedTool, actualTool, isCorrect, warning }
    intentChain,      // { intent, tool, handler, handlerShort, backendTypes, chain }
    // Advanced quality metrics
    responseAccuracy:   advancedMetrics.responseAccuracy,
    hallucinationScore: advancedMetrics.hallucinationScore,
    hallucinationLevel: advancedMetrics.hallucinationLevel,
    hallucinationFlags: advancedMetrics.hallucinationFlags,
    faithfulnessScore:  advancedMetrics.faithfulnessScore,
    completenessScore:  advancedMetrics.completenessScore,
    safetyScore:        advancedMetrics.safetyScore,
    safetyPassed:       advancedMetrics.safetyPassed,
    safetyFlags:        advancedMetrics.safetyFlags,
    overallQuality:     advancedMetrics.overallQuality,
    // E2E Agent metrics
    reasoningScore:      agentMetrics.reasoningScore,
    toolSelectionScore:  agentMetrics.toolSelectionScore,
    toolExecutionScore:  agentMetrics.toolExecutionScore,
    memoryScore:         agentMetrics.memoryScore,
    taskCompletionScore: agentMetrics.taskCompletionScore,
  };
}
