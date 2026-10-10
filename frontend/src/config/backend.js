/** Backend URL and default session settings for CARA QA tool. */

export const DEFAULT_BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL?.trim() || "http://127.0.0.1:9090";

export const DEFAULT_CONFIG = {
  backendUrl: DEFAULT_BACKEND_URL,
  deviceId: "cara-regression-tool-001",
  language: "en",
  timezone: "Asia/Kolkata",
  latitude: "12.9716",
  longitude: "77.5946",
  pipeline: "modular",
  modelName: "gpt-5.4-nano",
  /** Enable mock vehicle headers for Vehicle Status / command test modules. */
  enableRegressionVehicle:
    (import.meta.env.VITE_REGRESSION_VEHICLE || "1").trim() !== "0",
  vehicleBackend: import.meta.env.VITE_VEHICLE_BACKEND?.trim() || "cvip",
  vehicleVin: import.meta.env.VITE_VEHICLE_VIN?.trim() || "REGRESSION_VIN001",
  regressionVehicleToken:
    import.meta.env.VITE_REGRESSION_VEHICLE_TOKEN?.trim() || "cara-regression-mock",
};

/** Modules that should send connected-vehicle headers to process-text. */
export const VEHICLE_MODULE_RE = /vehicle status|execute_vehicle|vehicle command/i;
