/**
 * Canonical intent → tool + backend-type mapping.
 * Derived from agent_tool_intent_map.json (source: cara_backend/src/agent/session.py).
 *
 * Use this as the single source of truth for:
 *  1. Which agent tool handles each expected intent.
 *  2. Which backend response "type" field a tool emits.
 *  3. Detecting misrouting (wrong tool called for a given intent).
 */

// ── Intent → { tool, handler, backendTypes[] } ───────────────────────────────

export const INTENT_TOOL_MAP = {
  // handle_session
  get_locale_time:      { tool: "handle_session",            handler: "session_tools.get_locale_time_tool",       backendTypes: ["user_locale_time"] },
  get_time_in_location: { tool: "handle_session",            handler: "session_tools.get_time_in_location_tool",  backendTypes: ["time_in_location"] },
  get_user_location:    { tool: "handle_session",            handler: "session_tools.get_user_location_tool",     backendTypes: ["currentlocation", "currentLocation"] },

  // handle_assistant_info
  get_assistant_info:          { tool: "handle_assistant_info", handler: "user_profile_tools.get_assistant_info_tool",        backendTypes: ["assistant_info"] },
  save_agent_name:             { tool: "handle_assistant_info", handler: "user_profile_tools.set_agent_name_tool",             backendTypes: ["assistant_info"] },
  read_database_info:          { tool: "handle_assistant_info", handler: "user_profile_tools.read_database_info_tool",         backendTypes: ["data_transparency", "assistant_info"] },
  search_manual:               { tool: "handle_assistant_info", handler: "user_manual_tools.search_user_manual_tool",          backendTypes: ["assistant_info"] },
  get_data_collection_scope:   { tool: "handle_assistant_info", handler: "user_profile_tools.get_data_transparency_info_tool", backendTypes: ["data_transparency"] },
  get_data_collection_purpose: { tool: "handle_assistant_info", handler: "user_profile_tools.get_data_transparency_info_tool", backendTypes: ["data_transparency"] },
  get_data_collection_source:  { tool: "handle_assistant_info", handler: "user_profile_tools.get_data_transparency_info_tool", backendTypes: ["data_transparency"] },
  get_data_retention_info:     { tool: "handle_assistant_info", handler: "user_profile_tools.get_data_transparency_info_tool", backendTypes: ["data_transparency"] },
  get_data_access_info:        { tool: "handle_assistant_info", handler: "user_profile_tools.get_data_transparency_info_tool", backendTypes: ["data_transparency"] },
  get_data_storage_info:       { tool: "handle_assistant_info", handler: "user_profile_tools.get_data_transparency_info_tool", backendTypes: ["data_transparency"] },
  get_auto_learning_status:    { tool: "handle_assistant_info", handler: "user_profile_tools.get_data_transparency_info_tool", backendTypes: ["data_transparency"] },

  // handle_user_profile
  save_user_profile_name:          { tool: "handle_user_profile", handler: "user_profile_tools.save_user_profile_name_tool",    backendTypes: ["user_profile"] },
  enable_auto_preference_learning:  { tool: "handle_user_profile", handler: "user_profile_tools.set_auto_preference_learning_tool", backendTypes: ["user_profile"] },
  disable_auto_preference_learning: { tool: "handle_user_profile", handler: "user_profile_tools.set_auto_preference_learning_tool", backendTypes: ["user_profile"] },
  delete_auto_preferences:          { tool: "handle_user_profile", handler: "user_profile_tools.delete_auto_preference_tool",        backendTypes: ["user_profile"] },
  save_preference:                  { tool: "handle_user_profile", handler: "user_profile_tools.save_user_preferences_tool",         backendTypes: ["user_profile"] },
  save_relationship:                { tool: "handle_user_profile", handler: "user_profile_tools.save_user_relationships_tool",        backendTypes: ["user_profile"] },
  save_location:                    { tool: "handle_user_profile", handler: "user_profile_tools.save_user_location_tool",             backendTypes: ["user_profile"] },
  save_language_preference:         { tool: "handle_user_profile", handler: "user_profile_tools.save_user_language_preference_tool",  backendTypes: ["user_profile"] },
  delete_favorite:                  { tool: "handle_user_profile", handler: "user_profile_tools.delete_user_saved_data_tool",          backendTypes: ["user_profile"] },
  delete_favorites_by_type:         { tool: "handle_user_profile", handler: "user_profile_tools.delete_user_saved_scope_tool",         backendTypes: ["user_profile"] },
  delete_all_user_data:             { tool: "handle_user_profile", handler: "user_profile_tools.delete_user_saved_scope_tool",         backendTypes: ["user_profile"] },

  // handle_weather
  get_current_weather: { tool: "handle_weather", handler: "weather_tools.get_current_weather_tool", backendTypes: ["weather"] },
  get_past_weather:    { tool: "handle_weather", handler: "weather_tools.get_past_weather_tool",    backendTypes: ["weather_history", "weather"] },
  get_future_weather:  { tool: "handle_weather", handler: "weather_tools.get_future_weather_tool",  backendTypes: ["weather_forecast", "weather"] },
  rain_forecast:       { tool: "handle_weather", handler: "weather_tools.get_rain_forecast_tool",   backendTypes: ["weather"] },
  uv_index:            { tool: "handle_weather", handler: "weather_tools.get_uv_index_tool",        backendTypes: ["weather"] },
  weather_alerts:      { tool: "handle_weather", handler: "weather_tools.get_weather_alerts_tool",  backendTypes: ["weather"] },

  // handle_places_search
  search_nearby_by_type: { tool: "handle_places_search", handler: "navigation_tools.search_places_by_type_tool", backendTypes: ["navigation"] },
  search_by_text:        { tool: "handle_places_search", handler: "navigation_tools.search_places_by_text_tool",  backendTypes: ["navigation"] },

  // handle_distance
  get_distance: { tool: "handle_distance", handler: "navigation_tools.get_distance_tool", backendTypes: ["distance"] },

  // handle_navigation
  direct:             { tool: "handle_navigation", handler: "navigation_tools.navigate_direct_tool",          backendTypes: ["navigation"] },
  intermediary:       { tool: "handle_navigation", handler: "navigation_tools.navigate_route_with_stops_tool", backendTypes: ["navigation"] },
  transit_directions: { tool: "handle_navigation", handler: "navigation_tools.get_transit_directions_tool",   backendTypes: ["transit_directions"] },
  on_route_places:    { tool: "handle_navigation", handler: "navigation_tools.find_on_route_places_tool",     backendTypes: ["navigation"] },

  // handle_calls
  start_call: { tool: "handle_calls", handler: "calls_tools.get_calls_tool",  backendTypes: ["call", "sos"] },
  call:        { tool: "handle_calls", handler: "calls_tools.get_calls_tool",  backendTypes: ["call"] },
  sos:         { tool: "handle_calls", handler: "calls_tools.start_sos_tool",  backendTypes: ["sos"] },

  // handle_transport  (NOTE: do_not_use_for trains/buses — train queries may incorrectly route here)
  track_flight_status:    { tool: "handle_transport", handler: "flights_tools.track_flight_status_tool",   backendTypes: ["tracking"] },
  search_flights_by_query: { tool: "handle_transport", handler: "flights_tools.search_flights_by_query_tool", backendTypes: ["route"] },

  // handle_connected_vehicle
  get_vehicle_status:     { tool: "handle_connected_vehicle", handler: "connected_vehicle_tools.get_vehicle_status_tool",    backendTypes: ["vehicle_status"] },
  execute_vehicle_command: { tool: "handle_connected_vehicle", handler: "connected_vehicle_tools.execute_vehicle_command_tool", backendTypes: ["remote_command"] },

  // handle_live_data  (catch-all for GK, news, traffic, sports, etc.)
  get_live_data: { tool: "handle_live_data", handler: "live_data_tools.get_live_data_tool", backendTypes: ["live_data"] },

  // handle_infotainment
  tell_joke:  { tool: "handle_infotainment", handler: "infotainment_tools.tell_joke_tool",  backendTypes: ["joke"] },
  get_trivia: { tool: "handle_infotainment", handler: "infotainment_tools.get_trivia_tool",  backendTypes: ["trivia"] },
  play_game:  { tool: "handle_infotainment", handler: "infotainment_tools.play_game_tool",   backendTypes: ["game"] },

  // handle_entertainment
  music:          { tool: "handle_entertainment", handler: "entertainment_tools.handle_music_tool",           backendTypes: ["music", "youtube_music"] },
  suggest_podcast: { tool: "handle_entertainment", handler: "entertainment_tools.handle_suggest_podcast_tool", backendTypes: ["music", "youtube_music"] },
  play_podcast:   { tool: "handle_entertainment", handler: "entertainment_tools.handle_play_podcast_tool",     backendTypes: ["music", "youtube_music"] },

  // handle_reminders
  time_based_reminder: { tool: "handle_reminders", handler: "reminders_tools.time_based_reminder_agent_tool",  backendTypes: ["time_based_reminder"] },
  set:                 { tool: "handle_reminders", handler: "reminders_tools.time_based_reminder_agent_tool",  backendTypes: ["time_based_reminder"] },
  set_recurring:       { tool: "handle_reminders", handler: "reminders_tools.recurring_reminder_agent_tool",   backendTypes: ["time_based_reminder"] },
  set_location:        { tool: "handle_reminders", handler: "reminders_tools.create_location_reminder_agent_tool", backendTypes: ["time_based_reminder"] },
  list:                { tool: "handle_reminders", handler: "reminders_tools.list_reminders_agent_tool",       backendTypes: ["time_based_reminder"] },
  cancel:              { tool: "handle_reminders", handler: "reminders_tools.cancel_reminder_agent_tool",      backendTypes: ["time_based_reminder"] },
  cancel_reminder:     { tool: "handle_reminders", handler: "reminders_tools.cancel_reminder_agent_tool",      backendTypes: ["time_based_reminder"] },
  reschedule:          { tool: "handle_reminders", handler: "reminders_tools.reschedule_reminder_agent_tool",  backendTypes: ["reschedule_reminder"] },
  geo_register:        { tool: "handle_reminders", handler: "reminders_tools.create_location_reminder_agent_tool", backendTypes: ["time_based_reminder"] },
};

// ── Backend type → tool (reverse mapping) ────────────────────────────────────

export const BACKEND_TYPE_TO_TOOL = {
  user_locale_time:     "handle_session",
  time_in_location:     "handle_session",
  currentlocation:      "handle_session",
  currentLocation:      "handle_session",
  assistant_info:       "handle_assistant_info",
  data_transparency:    "handle_assistant_info",
  user_profile:         "handle_user_profile",
  weather:              "handle_weather",
  weather_history:      "handle_weather",
  weather_forecast:     "handle_weather",
  navigation:           "handle_navigation",       // also handle_places_search
  distance:             "handle_distance",
  transit_directions:   "handle_navigation",
  call:                 "handle_calls",
  sos:                  "handle_calls",
  tracking:             "handle_transport",
  route:                "handle_transport",
  vehicle_status:       "handle_connected_vehicle",
  remote_command:       "handle_connected_vehicle",
  live_data:            "handle_live_data",
  joke:                 "handle_infotainment",
  trivia:               "handle_infotainment",
  game:                 "handle_infotainment",
  music:                "handle_entertainment",
  youtube_music:        "handle_entertainment",
  time_based_reminder:  "handle_reminders",
  reschedule_reminder:  "handle_reminders",
  general_conversation: null,   // no tool invoked
  error:                null,
};

// ── Cross-tool routing rules from JSON ───────────────────────────────────────

const MISROUTING_RULES = [
  { expectedTool: "handle_weather",    badTypes: ["live_data"],              note: "Weather should NOT use handle_live_data" },
  { expectedTool: "handle_navigation", badTypes: [],                          note: null },
  { expectedTool: "handle_transport",  badTypes: ["live_data"],              note: "Flights should NOT use handle_live_data" },
  { expectedTool: "handle_live_data",  badTypes: ["weather", "weather_history", "weather_forecast"], note: "GK/traffic should NOT use handle_weather" },
  { expectedTool: "handle_reminders",  badTypes: ["general_conversation"],   note: "Reminders should NOT fall through to general_conversation" },
  { expectedTool: "handle_entertainment", badTypes: ["joke", "trivia", "game"], note: "Music should NOT use handle_infotainment" },
  { expectedTool: "handle_infotainment",  badTypes: ["music", "youtube_music"], note: "Jokes/trivia should NOT use handle_entertainment" },
  { expectedTool: "handle_user_profile",  badTypes: ["assistant_info"],       note: "Profile saves should NOT use handle_assistant_info" },
  { expectedTool: "handle_assistant_info", badTypes: ["user_profile"],        note: "Assistant name/read should NOT use handle_user_profile" },
];

// ── Public helpers ─────────────────────────────────────────────────────────────

/**
 * Given expectedIntent + actualBackendType, return a routing check result:
 * { expectedTool, actualTool, isCorrect, warning }
 */
export function checkToolRouting(expectedIntent, actualBackendType) {
  const norm = (v) => String(v || "").trim().toLowerCase();
  const expNorm = norm(expectedIntent);
  const typeNorm = norm(actualBackendType);

  const expected = INTENT_TOOL_MAP[expNorm];
  const actualTool = BACKEND_TYPE_TO_TOOL[typeNorm] ?? null;
  const expectedTool = expected?.tool ?? null;

  if (!expectedTool) {
    return { expectedTool: "unknown", actualTool, isCorrect: true, warning: null };
  }

  // Correct if actual tool matches, or actual type is one of the expected backend types
  const typeMatches =
    actualTool === expectedTool ||
    (expected.backendTypes || []).includes(typeNorm);

  // Check misrouting rules
  const rule = MISROUTING_RULES.find((r) => r.expectedTool === expectedTool);
  const isMisrouted = rule ? rule.badTypes.includes(typeNorm) : false;

  const isCorrect = typeMatches && !isMisrouted;
  const warning = isMisrouted ? (rule.note || `Expected ${expectedTool}, got ${actualTool}`) : null;

  return { expectedTool, actualTool: actualTool ?? typeNorm ?? "none", isCorrect, warning };
}

/**
 * Returns the canonical intent aliases for the evaluator.
 * Builds INTENT_ALIASES dynamically so the evaluator stays in sync with this map.
 */
export function buildIntentAliases() {
  const aliases = {};
  for (const [intent, entry] of Object.entries(INTENT_TOOL_MAP)) {
    const types = (entry.backendTypes || []).map((t) => t.toLowerCase());
    aliases[intent] = [intent, ...types];
  }
  return aliases;
}

/** Display label: "handle_weather › weather_tools.get_current_weather_tool" */
export function toolLabel(expectedIntent) {
  const entry = INTENT_TOOL_MAP[String(expectedIntent || "").toLowerCase()];
  if (!entry) return "—";
  return `${entry.tool} › ${entry.handler.split(".").pop()}`;
}

/**
 * Return the complete intent → tool → handler chain for a given intent.
 *
 * @param {string} expectedIntent   e.g. "get_current_weather"
 * @returns {{
 *   intent: string,
 *   tool: string,
 *   handler: string,
 *   handlerShort: string,   // just the function name, no module prefix
 *   backendTypes: string[],
 *   chain: string,          // "get_current_weather → handle_weather → get_current_weather_tool"
 * } | null}
 */
export function getIntentChain(expectedIntent) {
  const key   = String(expectedIntent || "").trim().toLowerCase();
  const entry = INTENT_TOOL_MAP[key];
  if (!entry) return null;
  const handlerShort = entry.handler.split(".").pop();
  return {
    intent:       key,
    tool:         entry.tool,
    handler:      entry.handler,
    handlerShort,
    backendTypes: entry.backendTypes,
    chain: `${key} → ${entry.tool} → ${handlerShort}`,
  };
}
