import { evaluateResult } from "../src/utils/evaluateTestResult.js";

const samples = [
  ["TC_AI_006", "Assistant", "What can you do for me?", "get_assistant_info", "general_conversation", "I can help with navigation, weather updates, setting reminders, playing music."],
  ["TC_TIM_009", "Time", "What is the time in Turin?", "get_time_in_location", "time_in_location", "The current time in Turin is eleven thirty-four AM."],
  ["TC_GK_130", "General Knowledge – Facts", "What is the capital of Japan?", "get_live_data", "general_conversation", "The capital of Japan is Tokyo."],
  ["TC_VS_150", "Vehicle Status – Engine", "Is the engine on?", "get_vehicle_status", "vehicle_status", "The engine is on. All doors are locked."],
  ["TC_MEMO_174", "Personal Data – Save Name", "Remember my name is Salman.", "save_user_profile_name", "general_conversation", "I've saved your name as Salman."],
  ["TC_CALL_050", "Call Control", "Answer the call.", "call", "general_conversation", "I can't answer calls directly."],
  ["TC_TRF_117", "Traffic / Area Info", "How's traffic in T Nagar?", "get_live_data", "live_data", "Traffic in T Nagar is currently light, with an estimated travel time of 417 minutes."],
];

for (const [id, module, input, exp, intent, msg] of samples) {
  const r = evaluateResult({ intent, assistant: { message: msg } }, { id, module, input, expectedIntent: exp });
  console.log(id, r.pass ? "PASS" : "FAIL", r.matchSource || "-", r.confidence);
}
