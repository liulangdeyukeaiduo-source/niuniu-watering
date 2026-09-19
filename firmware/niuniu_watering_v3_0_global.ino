/*
  NIUNIU WATERING SYSTEM V3.0 GLOBAL
  ESP32-S3 + Capacitive Soil Sensor + MOSFET + EMQX Cloud Global
  NO OLED / NO LED

  Wiring:
    Soil VCC  -> 3V3
    Soil GND  -> GND
    Soil AOUT -> GPIO4
    MOS TRIG  -> GPIO10
    MOS GND   -> ESP32 GND

  MQTT:
    publish status:         niuniu/status
    publish watering event: niuniu/watering/event
    subscribe command:      niuniu/command

  Notes:
    - First integrated test: TEST_MODE=true => pump 3 s, soak/verify 15 s.
    - Production: set TEST_MODE=false => pump 60 s, soak/verify 90 s.
    - Auto mode is OFF after reboot.
    - MQTT uses TLS port 8883. Per current project decision, CA verification is disabled.
    - No direct HTTP history upload. One MQTT status per minute is marked historySample=true;
      Worker persists that point to D1 soil_history.
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <time.h>

// ============================================================
// 1. Fill only these credentials before upload
// ============================================================
const char* WIFI_SSID     = "XUE & LIU family";
const char* WIFI_PASSWORD = "填写你的WiFi密码";

const char* MQTT_HOST     = "h1730b1a.ala.asia-southeast1.emqxsl.com";
const uint16_t MQTT_PORT  = 8883;
const char* MQTT_USERNAME = "niuniu_esp32";
const char* MQTT_PASSWORD = "填写国际版niuniu_esp32的MQTT密码";

// ============================================================
// 2. Device / topics
// ============================================================
const char* DEVICE_ID       = "niuniu-main";
const char* STATUS_TOPIC    = "niuniu/status";
const char* COMMAND_TOPIC   = "niuniu/command";
const char* WATERING_TOPIC  = "niuniu/watering/event";

// ============================================================
// 3. GPIO
// ============================================================
constexpr uint8_t SOIL_PIN = 4;
constexpr uint8_t PUMP_PIN = 10;
constexpr uint8_t PUMP_ON_LEVEL  = HIGH;
constexpr uint8_t PUMP_OFF_LEVEL = LOW;

// ============================================================
// 4. Soil calibration
// ============================================================
constexpr int RAW_DRY = 3451;
constexpr int RAW_WET = 1300;
constexpr int START_MOISTURE = 35;
constexpr int STOP_MOISTURE  = 55;

// ============================================================
// 5. Watering parameters
// ============================================================
constexpr bool TEST_MODE = true;   // FIRST FULL-LINK TEST: true. Production: false.
constexpr uint8_t MAX_DAILY = 3;

constexpr uint32_t AUTO_WATER_MS   = TEST_MODE ? 3000UL  : 60000UL;
constexpr uint32_t MANUAL_WATER_MS = TEST_MODE ? 3000UL  : 60000UL;
constexpr uint32_t SOAK_MS         = TEST_MODE ? 15000UL : 90000UL;

constexpr uint32_t PUMP_ON_CONFIRM_DELAY_MS  = 300UL;
constexpr uint32_t PUMP_OFF_CONFIRM_DELAY_MS = 150UL;

// ============================================================
// 6. Timers
// ============================================================
constexpr uint32_t SENSOR_SAMPLE_MS       = 3000UL;
constexpr uint32_t STATUS_PUBLISH_MS      = 10000UL;
constexpr uint32_t HISTORY_SAMPLE_MS      = 60000UL;
constexpr uint32_t WIFI_RETRY_MS          = 10000UL;
constexpr uint32_t MQTT_RETRY_MS          = 5000UL;

// ============================================================
// 7. Runtime objects
// ============================================================
WiFiClientSecure mqttSecureClient;
PubSubClient mqtt(mqttSecureClient);
Preferences prefs;

enum class RunState {
  MONITORING,
  PUMPING,
  SOAKING,
  LOCKED,
  SENSOR_FAULT
};

RunState runState = RunState::MONITORING;

bool autoMode = false;
bool pumpOn = false;
bool currentPumpManual = false;
bool autoCycleActive = false;

int soilRaw = 0;
int moisture = 0;
bool sensorValid = false;

uint8_t dailyCount = 0;
uint32_t savedDayKey = 0;

uint32_t pumpStopAt = 0;
uint32_t soakUntil = 0;
uint32_t pumpStartedAtMs = 0;

uint32_t lastSensorAt = 0;
uint32_t lastStatusAt = 0;
uint32_t lastHistorySampleAt = 0;
uint32_t lastWifiAttemptAt = 0;
uint32_t lastMqttAttemptAt = 0;

// Active watering event
bool eventActive = false;
String eventId = "";
String eventSource = "UNKNOWN";
String stopResult = "PLANNED_COMPLETE";
int beforeMoisture = -1;
int beforeRaw = -1;
int afterMoisture = -1;
int afterRaw = -1;
uint32_t plannedSeconds = 0;
uint32_t actualSeconds = 0;
bool pumpOnConfirmed = false;
bool pumpOffConfirmed = false;
uint32_t eventSequence = 0;

// ============================================================
// 8. Time helpers
// ============================================================
bool timeReached(uint32_t now, uint32_t target) {
  return (int32_t)(now - target) >= 0;
}

uint32_t secondsRemaining(uint32_t target) {
  uint32_t now = millis();
  if (timeReached(now, target)) return 0;
  return (target - now + 999UL) / 1000UL;
}

uint32_t epochNow() {
  time_t now = time(nullptr);
  if (now < 1700000000) return 0;
  return (uint32_t)now;
}

uint32_t eventTimestamp() {
  uint32_t ts = epochNow();
  return ts > 0 ? ts : (uint32_t)(millis() / 1000UL);
}

uint32_t currentDayKey() {
  struct tm t;
  if (!getLocalTime(&t, 50)) return 0;

  uint32_t year  = (uint32_t)t.tm_year + 1900U;
  uint32_t month = (uint32_t)t.tm_mon + 1U;
  uint32_t day   = (uint32_t)t.tm_mday;
  return year * 10000UL + month * 100UL + day;
}

// ============================================================
// 9. State / persistence
// ============================================================
const char* stateText() {
  switch (runState) {
    case RunState::MONITORING:   return "monitoring";
    case RunState::PUMPING:      return "pumping";
    case RunState::SOAKING:      return "soaking";
    case RunState::LOCKED:       return "locked";
    case RunState::SENSOR_FAULT: return "sensor_fault";
  }
  return "unknown";
}

void saveDailyCounter() {
  prefs.putUChar("daily", dailyCount);
  prefs.putUInt("dayKey", savedDayKey);
}

void checkDailyReset() {
  uint32_t key = currentDayKey();
  if (key == 0) return;

  if (savedDayKey == 0) {
    savedDayKey = key;
    saveDailyCounter();
    return;
  }

  if (key != savedDayKey) {
    savedDayKey = key;
    dailyCount = 0;
    autoCycleActive = false;

    if (!pumpOn && runState == RunState::LOCKED) {
      runState = sensorValid ? RunState::MONITORING : RunState::SENSOR_FAULT;
    }

    saveDailyCounter();
    Serial.println("[DAY] Daily counter reset.");
  }
}

// Forward declaration: sensor fault during pumping must use the normal
// stop/event lifecycle instead of silently switching the GPIO off.
void stopPumpAndSoak(const char* result);

// ============================================================
// 10. Soil sensor
// ============================================================
int readSoilAverage() {
  constexpr int samples = 12;
  long sum = 0;

  for (int i = 0; i < samples; ++i) {
    sum += analogRead(SOIL_PIN);
    delay(2);
  }
  return (int)(sum / samples);
}

int rawToMoisture(int raw) {
  long pct = map(raw, RAW_DRY, RAW_WET, 0, 100);
  return constrain((int)pct, 0, 100);
}

void updateSoilSensor() {
  soilRaw = readSoilAverage();

  sensorValid = (soilRaw > 100 && soilRaw < 4000);

  if (sensorValid) {
    moisture = rawToMoisture(soilRaw);

    if (runState == RunState::SENSOR_FAULT && !pumpOn) {
      runState = RunState::MONITORING;
    }
  } else {
    moisture = 0;
    autoCycleActive = false;

    if (pumpOn) {
      Serial.println("[SAFETY] Sensor fault while pumping. Stop pump immediately.");
      stopPumpAndSoak("SENSOR_FAULT");
      return;
    }

    runState = RunState::SENSOR_FAULT;
  }

  Serial.printf("[SOIL] RAW=%d  Moisture=%d%%  Valid=%s\n",
                soilRaw,
                moisture,
                sensorValid ? "YES" : "NO");
}

// ============================================================
// 11. Pump hardware confirmation
// IMPORTANT: digitalRead confirms the ESP32 GPIO output level only.
// It does NOT prove pump current/flow. Physical feedback needs a current/flow sensor.
// ============================================================
bool confirmPumpPin(uint8_t expectedLevel, uint32_t delayMs) {
  delay(delayMs);
  return digitalRead(PUMP_PIN) == expectedLevel;
}

void pumpHardwareOffNoEvent() {
  digitalWrite(PUMP_PIN, PUMP_OFF_LEVEL);
  delay(PUMP_OFF_CONFIRM_DELAY_MS);
  pumpOn = false;
}

// ============================================================
// 12. MQTT payloads
// ============================================================
void publishStatus(bool historySample = false) {
  if (!mqtt.connected()) return;

  char payload[900];
  String ip = (WiFi.status() == WL_CONNECTED)
                ? WiFi.localIP().toString()
                : String("");

  uint32_t intervalRemaining = 0;
  uint32_t countdown = 0;

  if (runState == RunState::SOAKING) {
    intervalRemaining = secondsRemaining(soakUntil);
  }

  if (runState == RunState::PUMPING) {
    countdown = secondsRemaining(pumpStopAt);
  }

  uint32_t ts = epochNow();

  snprintf(
    payload, sizeof(payload),
    "{"
      "\"deviceId\":\"%s\","
      "\"timestamp\":%lu,"
      "\"online\":true,"
      "\"moisture\":%d,"
      "\"raw\":%d,"
      "\"sensorValid\":%s,"
      "\"state\":\"%s\","
      "\"daily\":%u,"
      "\"maxDaily\":%u,"
      "\"auto\":%s,"
      "\"pump\":%s,"
      "\"source\":\"ESP32\","
      "\"eventId\":\"%s\","
      "\"intervalRemaining\":%lu,"
      "\"countdown\":%lu,"
      "\"ip\":\"%s\","
      "\"test\":%s,"
      "\"historySample\":%s"
    "}",
    DEVICE_ID,
    (unsigned long)ts,
    moisture,
    soilRaw,
    sensorValid ? "true" : "false",
    stateText(),
    dailyCount,
    MAX_DAILY,
    autoMode ? "true" : "false",
    pumpOn ? "true" : "false",
    eventActive ? eventId.c_str() : "",
    (unsigned long)intervalRemaining,
    (unsigned long)countdown,
    ip.c_str(),
    TEST_MODE ? "true" : "false",
    historySample ? "true" : "false"
  );

  bool ok = mqtt.publish(STATUS_TOPIC, payload, true);

  Serial.printf("[MQTT] Status: %s%s\n",
                ok ? "PUBLISHED" : "FAILED",
                historySample ? " + HISTORY" : "");
}

void publishWateringEvent(const char* phase, const char* result) {
  if (!mqtt.connected() || !eventActive) return;

  char payload[1100];

  snprintf(
    payload, sizeof(payload),
    "{"
      "\"deviceId\":\"%s\","
      "\"eventId\":\"%s\","
      "\"phase\":\"%s\","
      "\"source\":\"%s\","
      "\"result\":\"%s\","
      "\"timestamp\":%lu,"
      "\"beforeMoisture\":%d,"
      "\"beforeRaw\":%d,"
      "\"afterMoisture\":%d,"
      "\"afterRaw\":%d,"
      "\"currentMoisture\":%d,"
      "\"currentRaw\":%d,"
      "\"plannedSeconds\":%lu,"
      "\"actualSeconds\":%lu,"
      "\"daily\":%u,"
      "\"maxDaily\":%u,"
      "\"pumpOnConfirmed\":%s,"
      "\"pumpOffConfirmed\":%s,"
      "\"test\":%s"
    "}",
    DEVICE_ID,
    eventId.c_str(),
    phase,
    eventSource.c_str(),
    result,
    (unsigned long)eventTimestamp(),
    beforeMoisture,
    beforeRaw,
    afterMoisture,
    afterRaw,
    moisture,
    soilRaw,
    (unsigned long)plannedSeconds,
    (unsigned long)actualSeconds,
    dailyCount,
    MAX_DAILY,
    pumpOnConfirmed ? "true" : "false",
    pumpOffConfirmed ? "true" : "false",
    TEST_MODE ? "true" : "false"
  );

  bool ok = mqtt.publish(WATERING_TOPIC, payload, false);
  Serial.printf("[EVENT] %s publish: %s\n", phase, ok ? "OK" : "FAILED");
}

void buildEventId() {
  eventSequence++;

  uint32_t ts = epochNow();

  if (ts > 0) {
    eventId = String(DEVICE_ID) + "-" + String(ts) + "-" + String(eventSequence);
  } else {
    eventId = String(DEVICE_ID) + "-ms" + String(millis()) + "-" + String(eventSequence);
  }
}

void beginEvent(const char* source, uint32_t durationMs) {
  eventActive = true;
  eventSource = source;
  buildEventId();

  beforeMoisture = sensorValid ? moisture : -1;
  beforeRaw = sensorValid ? soilRaw : -1;
  afterMoisture = -1;
  afterRaw = -1;

  plannedSeconds = durationMs / 1000UL;
  actualSeconds = 0;

  pumpOnConfirmed = false;
  pumpOffConfirmed = false;
  stopResult = "PLANNED_COMPLETE";
}

// ============================================================
// 13. Pump / watering event lifecycle
// ============================================================
bool canStartPump() {
  return sensorValid &&
         !pumpOn &&
         runState != RunState::SOAKING &&
         dailyCount < MAX_DAILY;
}

bool startPump(uint32_t durationMs, bool manualSource, const char* sourceName) {
  if (!canStartPump()) {
    Serial.println("[PUMP] Start rejected.");
    return false;
  }

  updateSoilSensor();

  if (!sensorValid) {
    Serial.println("[PUMP] Start rejected after fresh sensor check.");
    return false;
  }

  currentPumpManual = manualSource;
  beginEvent(sourceName, durationMs);

  digitalWrite(PUMP_PIN, PUMP_ON_LEVEL);
  pumpOnConfirmed = confirmPumpPin(PUMP_ON_LEVEL, PUMP_ON_CONFIRM_DELAY_MS);

  if (!pumpOnConfirmed) {
    pumpHardwareOffNoEvent();

    runState = sensorValid ? RunState::MONITORING : RunState::SENSOR_FAULT;
    publishWateringEvent("START_FAILED", "GPIO_ON_CONFIRM_FAILED");

    Serial.println("[PUMP] GPIO ON confirmation FAILED.");
    eventActive = false;
    publishStatus();
    return false;
  }

  pumpOn = true;
  runState = RunState::PUMPING;
  pumpStartedAtMs = millis();
  pumpStopAt = pumpStartedAtMs + durationMs;

  dailyCount++;
  saveDailyCounter();

  publishWateringEvent("STARTED", "OK");
  publishStatus();

  Serial.println("\n========================================");
  Serial.println("               PUMP ON");
  Serial.println("========================================");
  Serial.printf("[PUMP] Source  = %s\n", sourceName);
  Serial.printf("[PUMP] Event   = %s\n", eventId.c_str());
  Serial.printf("[PUMP] Today   = %u/%u\n", dailyCount, MAX_DAILY);
  Serial.printf("[PUMP] Planned = %lu sec\n", durationMs / 1000UL);
  Serial.println("[PUMP] GPIO10 ON readback = OK");

  return true;
}

void enterSoaking() {
  runState = RunState::SOAKING;
  soakUntil = millis() + SOAK_MS;
}

void stopPumpAndSoak(const char* result) {
  if (!pumpOn) {
    if (runState != RunState::SOAKING) {
      enterSoaking();
    }
    return;
  }

  actualSeconds = (millis() - pumpStartedAtMs + 500UL) / 1000UL;
  stopResult = result;

  digitalWrite(PUMP_PIN, PUMP_OFF_LEVEL);
  pumpOffConfirmed = confirmPumpPin(PUMP_OFF_LEVEL, PUMP_OFF_CONFIRM_DELAY_MS);
  pumpOn = false;

  Serial.println("\n========================================");
  Serial.println("               PUMP OFF");
  Serial.println("========================================");
  Serial.printf("[PUMP] Actual = %lu sec\n", (unsigned long)actualSeconds);
  Serial.printf("[PUMP] GPIO10 OFF readback = %s\n",
                pumpOffConfirmed ? "OK" : "FAILED");

  publishWateringEvent(
    pumpOffConfirmed ? "STOPPED" : "STOP_FAILED",
    pumpOffConfirmed ? result : "GPIO_OFF_CONFIRM_FAILED"
  );

  enterSoaking();
  publishStatus();
}

void verifyWateringEvent() {
  if (!eventActive) return;

  updateSoilSensor();

  if (sensorValid) {
    afterMoisture = moisture;
    afterRaw = soilRaw;

    const char* finalResult =
      (stopResult == "PLANNED_COMPLETE") ? "OK" : stopResult.c_str();

    publishWateringEvent("VERIFIED", finalResult);
  } else {
    afterMoisture = -1;
    afterRaw = -1;
    publishWateringEvent("VERIFIED", "SENSOR_INVALID");
  }

  Serial.println("\n========================================");
  Serial.println("          WATERING VERIFIED");
  Serial.println("========================================");
  Serial.printf("[VERIFY] Before = %d%% / RAW %d\n", beforeMoisture, beforeRaw);
  Serial.printf("[VERIFY] After  = %d%% / RAW %d\n", afterMoisture, afterRaw);

  eventActive = false;
  eventId = "";
  eventSource = "UNKNOWN";
  currentPumpManual = false;

  publishStatus();
}

void emergencyStop() {
  autoCycleActive = false;

  if (pumpOn) {
    stopPumpAndSoak("MANUAL_STOP");
  } else {
    digitalWrite(PUMP_PIN, PUMP_OFF_LEVEL);
    pumpOn = false;

    if (runState != RunState::SOAKING) {
      runState = sensorValid ? RunState::MONITORING : RunState::SENSOR_FAULT;
    }

    publishStatus();
  }

  Serial.println("[PUMP] Emergency/remote stop processed.");
}

// ============================================================
// 14. Automatic watering state machine
// ============================================================
void updateWateringLogic() {
  uint32_t now = millis();

  if (runState == RunState::PUMPING) {
    if (timeReached(now, pumpStopAt)) {
      stopPumpAndSoak("PLANNED_COMPLETE");
    }
    return;
  }

  if (runState == RunState::SOAKING) {
    if (!timeReached(now, soakUntil)) return;

    verifyWateringEvent();

    if (!sensorValid) {
      runState = RunState::SENSOR_FAULT;
      autoCycleActive = false;
      return;
    }

    if (dailyCount >= MAX_DAILY) {
      runState = RunState::LOCKED;
      autoCycleActive = false;
      publishStatus();
      return;
    }

    if (autoCycleActive && autoMode) {
      if (moisture >= STOP_MOISTURE) {
        autoCycleActive = false;
        runState = RunState::MONITORING;
        Serial.println("[AUTO] Target moisture reached.");
        publishStatus();
      } else {
        Serial.println("[AUTO] Moisture still low after soak. Start next small watering.");
        runState = RunState::MONITORING;
        startPump(AUTO_WATER_MS, false, "AUTO");
      }
    } else {
      runState = RunState::MONITORING;
      publishStatus();
    }

    return;
  }

  if (dailyCount >= MAX_DAILY) {
    runState = RunState::LOCKED;
    autoCycleActive = false;
    return;
  }

  if (!sensorValid) {
    runState = RunState::SENSOR_FAULT;
    autoCycleActive = false;
    return;
  }

  if (runState == RunState::MONITORING &&
      autoMode &&
      moisture <= START_MOISTURE) {
    Serial.println("[AUTO] Dry threshold reached. Start watering cycle.");
    autoCycleActive = true;
    startPump(AUTO_WATER_MS, false, "AUTO");
  }
}

// ============================================================
// 15. Wi-Fi
// ============================================================
void configureClock() {
  configTime(
    8 * 3600,
    0,
    "ntp.aliyun.com",
    "pool.ntp.org",
    "time.cloudflare.com"
  );
}

void startWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("[WiFi] Connecting to ");
  Serial.println(WIFI_SSID);

  uint32_t start = millis();

  while (WiFi.status() != WL_CONNECTED &&
         millis() - start < 15000UL) {
    delay(300);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("[WiFi] CONNECTED");
    Serial.print("[WiFi] IP   = ");
    Serial.println(WiFi.localIP());
    Serial.print("[WiFi] RSSI = ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");

    configureClock();
  } else {
    Serial.println("[WiFi] NOT CONNECTED. Local automatic logic remains available.");
  }
}

void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  uint32_t now = millis();

  if (now - lastWifiAttemptAt < WIFI_RETRY_MS) return;
  lastWifiAttemptAt = now;

  Serial.println("[WiFi] Reconnecting...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// ============================================================
// 16. Commands
// ============================================================
void handleCommand(const String& cmd, bool fromSerial = false) {
  Serial.print(fromSerial ? "[SERIAL] Command = " : "[MQTT] Command = ");
  Serial.println(cmd);

  if (cmd == "status") {
    publishStatus();
    return;
  }

  if (cmd == "stop") {
    emergencyStop();
    return;
  }

  if (cmd == "auto_on") {
    autoMode = true;
    Serial.println("[AUTO] ON");
    publishStatus();
    return;
  }

  if (cmd == "auto_off") {
    autoMode = false;
    autoCycleActive = false;

    if (pumpOn && !currentPumpManual) {
      stopPumpAndSoak("AUTO_DISABLED");
    } else {
      publishStatus();
    }

    Serial.println("[AUTO] OFF");
    return;
  }

  if (cmd == "water") {
    if (runState == RunState::SOAKING ||
        runState == RunState::PUMPING ||
        dailyCount >= MAX_DAILY ||
        !sensorValid) {
      Serial.println("[COMMAND] WATER rejected.");
      publishStatus();
      return;
    }

    autoCycleActive = false;

    startPump(
      MANUAL_WATER_MS,
      true,
      fromSerial ? "MANUAL_SERIAL" : "MANUAL_WEB"
    );
    return;
  }

  if (cmd == "test_reset") {
    if (!TEST_MODE) {
      Serial.println("[COMMAND] test_reset rejected: TEST_MODE=false.");
      return;
    }

    if (pumpOn) {
      Serial.println("[COMMAND] test_reset rejected while pump is ON.");
      return;
    }

    dailyCount = 0;
    autoCycleActive = false;

    if (runState == RunState::LOCKED) {
      runState = sensorValid ? RunState::MONITORING : RunState::SENSOR_FAULT;
    }

    saveDailyCounter();
    Serial.println("[TEST] Daily counter reset.");
    publishStatus();
    return;
  }

  Serial.println("[COMMAND] Unknown command.");
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  if (String(topic) != COMMAND_TOPIC) return;

  String cmd;
  cmd.reserve(length + 1);

  for (unsigned int i = 0; i < length; ++i) {
    cmd += (char)payload[i];
  }

  cmd.trim();
  handleCommand(cmd, false);
}

void maintainSerialCommands() {
  if (!Serial.available()) return;

  String cmd = Serial.readStringUntil('\n');
  cmd.trim();

  if (cmd.length() > 0) {
    handleCommand(cmd, true);
  }
}

// ============================================================
// 17. MQTT
// ============================================================
bool connectMQTT() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (mqtt.connected()) return true;

  String clientId = "niuniu-esp32-";
  clientId += String((uint32_t)(ESP.getEfuseMac() & 0xFFFFFFFFULL), HEX);

  const char* offlinePayload =
    "{\"deviceId\":\"niuniu-main\","
    "\"online\":false,"
    "\"state\":\"offline\","
    "\"source\":\"ESP32_LWT\"}";

  Serial.print("[MQTT] Connecting to Global EMQX... ");

  bool ok = mqtt.connect(
    clientId.c_str(),
    MQTT_USERNAME,
    MQTT_PASSWORD,
    STATUS_TOPIC,
    0,
    true,
    offlinePayload
  );

  if (!ok) {
    Serial.print("FAILED, state=");
    Serial.println(mqtt.state());
    return false;
  }

  Serial.println("OK");

  bool subOk = mqtt.subscribe(COMMAND_TOPIC, 0);
  Serial.print("[MQTT] Subscribe niuniu/command: ");
  Serial.println(subOk ? "OK" : "FAILED");

  publishStatus(false);

  // Put the first history point into the new pipeline shortly after boot.
  lastHistorySampleAt = millis() - HISTORY_SAMPLE_MS + 10000UL;

  return true;
}

void maintainMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;

  if (mqtt.connected()) {
    mqtt.loop();
    return;
  }

  uint32_t now = millis();

  if (now - lastMqttAttemptAt < MQTT_RETRY_MS) return;
  lastMqttAttemptAt = now;

  connectMQTT();
}

// ============================================================
// 18. Setup / Loop
// ============================================================
void setup() {
  Serial.begin(115200);
  Serial.setTimeout(100);
  delay(1200);

  Serial.println("\n========================================");
  Serial.println(" NIUNIU WATERING SYSTEM V3.0 GLOBAL");
  Serial.println(" ESP32-S3 + MQTT EVENT PIPELINE");
  Serial.println(" NO OLED / NO LED");
  Serial.println("========================================");
  Serial.printf("[MODE] TEST_MODE = %s\n", TEST_MODE ? "TRUE" : "FALSE");

  // Safety first: pump OFF before anything else.
  pinMode(PUMP_PIN, OUTPUT);
  digitalWrite(PUMP_PIN, PUMP_OFF_LEVEL);
  pumpOn = false;

  analogReadResolution(12);

  prefs.begin("niuniu", false);
  dailyCount = prefs.getUChar("daily", 0);
  savedDayKey = prefs.getUInt("dayKey", 0);

  Serial.printf("[SYSTEM] Daily count = %u/%u\n", dailyCount, MAX_DAILY);

  updateSoilSensor();
  startWiFi();

  // TLS encrypted. Project currently chooses no CA certificate validation.
  mqttSecureClient.setInsecure();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(1400);
  mqtt.setKeepAlive(60);
  mqtt.setSocketTimeout(8);

  connectMQTT();

  lastSensorAt = millis();
  lastStatusAt = millis();

  Serial.println("[SYSTEM] READY");
  Serial.println("[SERIAL] Commands: status | water | stop | auto_on | auto_off | test_reset");
}

void loop() {
  uint32_t now = millis();

  maintainWiFi();
  maintainMQTT();
  maintainSerialCommands();
  checkDailyReset();

  if (now - lastSensorAt >= SENSOR_SAMPLE_MS) {
    lastSensorAt = now;
    updateSoilSensor();
  }

  updateWateringLogic();

  if (mqtt.connected() &&
      now - lastStatusAt >= STATUS_PUBLISH_MS) {
    lastStatusAt = now;

    bool historyDue =
      (now - lastHistorySampleAt >= HISTORY_SAMPLE_MS);

    if (historyDue) {
      lastHistorySampleAt = now;
    }

    publishStatus(historyDue);
  }

  delay(5);
}
