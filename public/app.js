const $ = (id) => document.getElementById(id);

const ui = {
  cloudDot: $("cloudDot"), cloudText: $("cloudText"), moisture: $("moisture"), heroHint: $("heroHint"),
  device: $("device"), state: $("state"), daily: $("daily"), auto: $("auto"),
  controlHint: $("controlHint"), message: $("message"), meta: $("meta"),
  waterBtn: $("waterBtn"), stopBtn: $("stopBtn"), autoBtn: $("autoBtn"), statusBtn: $("statusBtn"), resetBtn: $("resetBtn"), refreshBtn: $("refreshBtn"),
  eventList: $("eventList"), eventCount: $("eventCount"),
  trendBox: $("trendBox"), trendSvg: $("trendSvg"), trendTooltip: $("trendTooltip"),
  trendEmpty: $("trendEmpty"), trendMeta: $("trendMeta"), trendRefreshBtn: $("trendRefreshBtn"),
  trendTitle: $("trendTitle"), zoomOutBtn: $("zoomOutBtn"), zoomInBtn: $("zoomInBtn"), zoomResetBtn: $("zoomResetBtn"),
  liveStrip: $("liveStrip"),
  hardwareLiveBadge: $("hardwareLiveBadge"),
  hwEsp32: $("hwEsp32"), hwEsp32Detail: $("hwEsp32Detail"),
  hwSensor: $("hwSensor"), hwSensorDetail: $("hwSensorDetail"),
  hwMosfet: $("hwMosfet"), hwMosfetDetail: $("hwMosfetDetail"),
  hwPump: $("hwPump"), hwPumpDetail: $("hwPumpDetail"),
  hwPower: $("hwPower"), hwWaterPath: $("hwWaterPath"),
};

let health = null;
let status = null;
let history = { soil: [], weather: [], watering: [], weatherMeta: null };
let busy = false;
let trendHours = 168;
let trendViewHours = 168;
let trendEndOffsetHours = 0;
let trendModel = null;
let trendPan = null;
let trendSelection = null;
let trendSelectionEl = null;
const TREND_MIN_VIEW_HOURS = 0.5;
let eventsCache = [];
let historyCursorMs = 0;
let latestStatusResult = null;
let lastStatusReceivedAt = 0;
let lastRenderedMoisture = null;
let statusRequestInFlight = false;
let deltaRequestInFlight = false;
let lastWeatherDeltaAt = 0;
const TREND_SERIES_KEYS = ["soil","humidity","temp","vpd","watering"];
const trendVisibility = {soil:true,humidity:true,temp:true,vpd:true,watering:true};

function stateText(value){
  const map = {monitoring:"监测",pumping:"浇水",soaking:"渗透",locked:"闭锁",sensor_fault:"传感器故障",pump_fault:"水泵故障"};
  return map[value] || value || "--";
}

function timeText(ts){
  if(!ts) return "--";
  return new Date(toMillis(ts)).toLocaleString("zh-CN", {hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
}

function toMillis(ts){
  const n = Number(ts || 0);
  return n > 1e12 ? n : n * 1000;
}

function setMessage(text, type=""){
  ui.message.textContent = text;
  ui.message.className = "message" + (type ? ` ${type}` : "");
}

async function api(path, options={}){
  const response = await fetch(path, {cache:"no-store", ...options});
  let data = null;
  try{ data = await response.json(); }catch{}
  if(!response.ok){
    const error = new Error(data?.message || data?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function loadHealth(){
  try{
    health = await api("/api/health");
    ui.cloudDot.className = "dot ok";
    ui.cloudText.textContent = "WORKER+";
    if(health.commandProtected){
      ui.controlHint.textContent = "Cloudflare Access 已认证，远程控制可用";
    }else{
      ui.controlHint.textContent = "为安全起见，启用 Cloudflare Access 后开放远程控制";
    }
  }catch(error){
    ui.cloudDot.className = "dot";
    ui.cloudText.textContent = "WORKER-";
    ui.controlHint.textContent = "Worker API 暂不可用";
  }
}

async function loadStatus(){
  if(statusRequestInFlight) return;
  statusRequestInFlight = true;
  try{
    const result = await api("/api/status");
    latestStatusResult = result;
    lastStatusReceivedAt = Date.now();
    status = result.data;
    renderStatus(result);
  }catch(error){
    document.body.classList.remove("watering-active");
    ui.device.textContent = "异常";
    ui.heroHint.textContent = "状态读取失败";
    if(ui.liveStrip){
      ui.liveStrip.className = "live-strip offline";
      ui.liveStrip.textContent = "实时状态读取失败，正在自动重试";
    }
    setMessage(`状态读取失败：${error.message}`, "err");
  }finally{
    statusRequestInFlight = false;
  }
}

function renderStatus(result){
  const d = result.data;
  if(!d){
    document.body.classList.remove("watering-active");
    ui.moisture.textContent = "--%";
    ui.device.textContent = "无数据";
    ui.state.textContent = "--";
    ui.daily.textContent = "--/3";
    ui.auto.textContent = "--";
    ui.heroHint.textContent = "等待设备数据进入 Worker";
    renderHardwareStatus(null, result);
    updateControls();
    return;
  }

  const wateringNow = d.online && d.state === "pumping";
  document.body.classList.toggle("watering-active", wateringNow);

  updateMoistureDisplay(d);
  ui.device.textContent = d.online ? "在线" : "离线";
  ui.state.textContent = stateText(d.state);
  ui.daily.textContent = `${d.daily ?? "--"}/${d.maxDaily ?? 3}`;
  ui.auto.textContent = d.auto ? "开启" : "关闭";
  ui.heroHint.textContent = result.stale
    ? "当前为历史/过期状态，等待实时 Webhook"
    : wateringNow
      ? "💧 正在浇水 · 水泵运行中"
      : d.vpdAssistReady
        ? "VPD持续偏高 · 环境辅助已就绪"
        : "设备状态已同步到 Worker";

  const items = [];
  if(d.raw !== undefined && d.raw !== null) items.push(`RAW ${d.raw}`);
  if(result.ageSeconds !== undefined) items.push(`数据 ${result.ageSeconds}s 前`);
  if(Number.isFinite(Number(d.vpd)) && d.environmentValid){
    items.push(`VPD ${Number(d.vpd).toFixed(2)} kPa`);
    if(d.vpdAssistReady) items.push("VPD辅助就绪");
  }else{
    items.push("VPD降级：仅土壤");
  }
  if(result.source) items.push(result.source);
  ui.meta.textContent = items.join(" ｜ ");
  ui.resetBtn.classList.remove("hidden");
  ui.autoBtn.textContent = d.auto ? "关闭自动" : "开启自动";
  updateControls();
  renderRealtimeTick();
  renderHardwareStatus(d, result);

  if(trendModel) renderTrend();
}

function updateMoistureDisplay(d){
  const next = d?.sensorValid ? Number(d.moisture) : null;
  const text = Number.isFinite(next) ? `${next}%` : "--%";

  if(lastRenderedMoisture !== null && Number.isFinite(next) && next !== lastRenderedMoisture){
    ui.moisture.classList.remove("changed");
    void ui.moisture.offsetWidth;
    ui.moisture.classList.add("changed");
    setTimeout(()=>ui.moisture.classList.remove("changed"), 420);
  }

  ui.moisture.textContent = text;
  lastRenderedMoisture = Number.isFinite(next) ? next : null;
}

function currentStatusAgeSeconds(){
  if(!latestStatusResult || !lastStatusReceivedAt) return 0;
  const base = Number(latestStatusResult.ageSeconds || 0);
  const elapsed = Math.max(0, Math.floor((Date.now() - lastStatusReceivedAt) / 1000));
  return base + elapsed;
}

function renderRealtimeTick(){
  if(!ui.liveStrip) return;

  const d = status;
  if(d) renderHardwareStatus(d, latestStatusResult);
  if(!d){
    ui.liveStrip.className = "live-strip syncing";
    ui.liveStrip.textContent = "正在同步实时状态…";
    return;
  }

  const age = currentStatusAgeSeconds();
  const daily = d.daily ?? "--";
  const maxDaily = d.maxDaily ?? 3;
  const moistureText = d.sensorValid ? `${d.moisture}%` : "--";
  const vpdText = Number.isFinite(Number(d.vpd)) && d.environmentValid
    ? ` · VPD ${Number(d.vpd).toFixed(2)} kPa`
    : "";

  if(!d.online || age > 90){
    ui.liveStrip.className = "live-strip stale";
    ui.liveStrip.textContent = `设备状态已过期 · 最近数据约 ${age}s 前`;
    ui.heroHint.textContent = "等待设备恢复实时上报";
    return;
  }

  if(d.state === "pumping"){
    const remaining = Math.max(0, Number(d.countdown || 0) - age);
    ui.liveStrip.className = "live-strip watering";
    ui.liveStrip.textContent = `正在浇水 · 剩余约 ${remaining}s · 今日 ${daily}/${maxDaily}`;
    ui.heroHint.textContent = `💧 水泵运行中 · ${remaining}s`;
    return;
  }

  if(d.state === "soaking"){
    const remaining = Math.max(0, Number(d.intervalRemaining || 0) - age);
    ui.liveStrip.className = "live-strip soaking";
    ui.liveStrip.textContent = `正在渗透 · 约 ${remaining}s 后复测土壤湿度`;
    ui.heroHint.textContent = `渗透复测倒计时 · ${remaining}s`;
    return;
  }

  if(d.vpdAssistReady){
    ui.liveStrip.className = "live-strip assist";
    ui.liveStrip.textContent = `VPD辅助已就绪 · 土壤 ${moistureText}${vpdText} · ${age}s前`;
    ui.heroHint.textContent = "VPD持续偏高 · 环境辅助已就绪";
    return;
  }

  ui.liveStrip.className = "live-strip monitoring";
  if(d.auto){
    ui.liveStrip.textContent = `自动监测中 · 土壤 ${moistureText}${vpdText} · ${age}s前`;
    ui.heroHint.textContent = "自动浇水已开启 · 实时监测中";
  }else{
    ui.liveStrip.textContent = `实时监测 · 土壤 ${moistureText}${vpdText} · ${age}s前`;
    ui.heroHint.textContent = "设备状态已同步到 Worker";
  }
}

function setHardwareState(el, text, stateClass){
  if(!el) return;
  el.className = `hardware-state ${stateClass}`;
  const node = el.closest(".hardware-node");
  if(node) node.dataset.state = stateClass;
  const label = el.querySelector("span");
  if(label) label.textContent = text;
}

const HARDWARE_MOBILE_PATHS = {
  signal: "M180 100 H420 M450 100 V330",
  power: "M450 560 V330 H300 V560 H180",
  water: "M150 330 V560 H24 V100 H150",
};

let hardwareLinkFrame = 0;

function scheduleHardwareLinks(){
  if(hardwareLinkFrame) cancelAnimationFrame(hardwareLinkFrame);
  hardwareLinkFrame = requestAnimationFrame(()=>{
    hardwareLinkFrame = 0;
    updateHardwareLinks();
  });
}

function updateHardwareLinks(){
  const map = document.querySelector(".hardware-map");
  const svg = $("hardwareLinks");
  const signal = $("hardwareSignalLink");
  const power = $("hardwarePowerLink");
  const water = $("hardwareWaterLink");
  const flow = $("hardwareWaterFlow");
  if(!map || !svg || !signal || !power || !water || !flow) return;

  // Keep the phone layout exactly as before.
  if(!window.matchMedia("(min-width: 768px)").matches){
    svg.setAttribute("viewBox", "0 0 600 660");
    signal.setAttribute("d", HARDWARE_MOBILE_PATHS.signal);
    power.setAttribute("d", HARDWARE_MOBILE_PATHS.power);
    water.setAttribute("d", HARDWARE_MOBILE_PATHS.water);
    flow.setAttribute("d", HARDWARE_MOBILE_PATHS.water);
    return;
  }

  const mapRect = map.getBoundingClientRect();
  if(mapRect.width < 1 || mapRect.height < 1) return;
  svg.setAttribute("viewBox", `0 0 ${mapRect.width} ${mapRect.height}`);

  const rel = (id)=>{
    const el = $(id);
    if(!el) return null;
    const r = el.getBoundingClientRect();
    return {
      left:r.left-mapRect.left,
      right:r.right-mapRect.left,
      top:r.top-mapRect.top,
      bottom:r.bottom-mapRect.top,
      cx:(r.left+r.right)/2-mapRect.left,
      cy:(r.top+r.bottom)/2-mapRect.top,
    };
  };

  const sensor = rel("nodeSensor");
  const controller = rel("nodeEsp32");
  const tank = rel("nodeWaterPath");
  const mosfet = rel("nodeMosfet");
  const pump = rel("nodePump");
  const supply = rel("nodePower");
  if(!sensor || !controller || !tank || !mosfet || !pump || !supply) return;

  const fmt = (n)=>Number(n.toFixed(1));
  const midColumn = fmt((sensor.right + controller.left) / 2);
  const outerLeft = fmt(Math.max(10, Math.min(sensor.left, tank.left, pump.left) - 18));

  // Sampling/control: sensor -> ESP32, ESP32 -> MOSFET.
  const signalD = [
    `M ${fmt(sensor.right)} ${fmt(sensor.cy)} H ${fmt(controller.left)}`,
    `M ${fmt(controller.cx)} ${fmt(controller.bottom)} V ${fmt(mosfet.top)}`,
  ].join(" ");

  // 24V chain: power -> MOSFET -> pump. The cross-column segment stays in the center gutter.
  const powerD = [
    `M ${fmt(supply.cx)} ${fmt(supply.top)} V ${fmt(mosfet.bottom)}`,
    `M ${fmt(mosfet.left)} ${fmt(mosfet.cy)} H ${midColumn} V ${fmt(pump.cy)} H ${fmt(pump.right)}`,
  ].join(" ");

  // Water path: tank -> pump -> plant. Route the return leg through the left gutter,
  // so it never cuts through a card at wide desktop aspect ratios.
  const waterD = [
    `M ${fmt(tank.cx)} ${fmt(tank.bottom)} V ${fmt(pump.top)}`,
    `M ${fmt(pump.left)} ${fmt(pump.cy)} H ${outerLeft} V ${fmt(sensor.cy)} H ${fmt(sensor.left)}`,
  ].join(" ");

  signal.setAttribute("d", signalD);
  power.setAttribute("d", powerD);
  water.setAttribute("d", waterD);
  flow.setAttribute("d", waterD);
}

function renderHardwareStatus(d, result = latestStatusResult){
  const stale = Boolean(result?.stale) || currentStatusAgeSeconds() > 90;
  const online = Boolean(d?.online) && !stale;
  const age = currentStatusAgeSeconds();
  const fault = d?.state === "pump_fault";
  const driving = online && !fault && (d?.pump === true || d?.state === "pumping");
  const scene = $("hardwareScene");
  const stage = $("hardwareStage");
  const mode = !d ? "unknown" : !online ? "offline" : fault ? "fault" : driving ? "pumping" : d.state === "soaking" ? "soaking" : "idle";
  if(scene) scene.dataset.mode = mode;
  scheduleHardwareLinks();
  if(stage){
    const countdown = Number(driving ? d?.countdown : d?.intervalRemaining);
    const remaining = Number.isFinite(countdown) ? Math.max(0, Math.ceil(countdown - age)) : null;
    stage.textContent = !d ? "暂无设备数据 · 等待同步" : !online ? "设备离线或数据过期 · 运行状态无法确认" : fault ? "控制系统报告故障 · 请检查设备" : driving
      ? `浇水指令执行中 · ${remaining > 0 ? `预计剩余 ${remaining} 秒` : "等待设备确认结束"}`
      : d.state === "soaking" ? `渗透复测 · ${remaining > 0 ? `约 ${remaining} 秒后复测` : "等待设备复测结果"}`
      : d.auto ? "自动监测中 · 等待浇水条件" : "手动模式 · 设备待机";
  }


  if(ui.hardwareLiveBadge){
    ui.hardwareLiveBadge.className = `hardware-live-badge ${online ? "online" : "offline"}`;
    ui.hardwareLiveBadge.textContent = online ? "实时同步" : "设备离线";
  }

  if(!d || !online){
    setHardwareState(ui.hwEsp32, "离线", "error");
    setHardwareState(ui.hwSensor, "无法确认", "error");
    setHardwareState(ui.hwMosfet, "无法确认", "error");
    setHardwareState(ui.hwPump, "无法确认", "error");
    if(ui.hwEsp32Detail) ui.hwEsp32Detail.textContent = stale ? "状态数据已过期" : "等待设备连接";
    if(ui.hwSensorDetail) ui.hwSensorDetail.textContent = "无实时传感器数据";
    if(ui.hwMosfetDetail) ui.hwMosfetDetail.textContent = "无实时GPIO状态";
    if(ui.hwPumpDetail) ui.hwPumpDetail.textContent = "无实时控制状态";
    return;
  }

  setHardwareState(ui.hwEsp32, "在线", "ok");
  if(ui.hwEsp32Detail){
    const age = currentStatusAgeSeconds();
    ui.hwEsp32Detail.textContent = `最近上报 ${age}s 前`;
  }

  if(d.sensorValid){
    setHardwareState(ui.hwSensor, `${d.moisture ?? "--"}%`, "ok");
    if(ui.hwSensorDetail){
      ui.hwSensorDetail.textContent = `RAW ${d.raw ?? "--"} · 采样有效`;
    }
  }else{
    setHardwareState(ui.hwSensor, "异常", "warn");
    if(ui.hwSensorDetail) ui.hwSensorDetail.textContent = "传感器数据无效";
  }

  setHardwareState(ui.hwMosfet, fault ? "状态待确认" : driving ? "输出 ON" : "输出 OFF", fault ? "error" : driving ? "active" : "ok");
  if(ui.hwMosfetDetail){
    ui.hwMosfetDetail.textContent = fault ? "控制系统报告故障" : "依据设备控制状态上报";
  }

  if(d.state === "pump_fault"){
    setHardwareState(ui.hwPump, "故障", "error");
    if(ui.hwPumpDetail) ui.hwPumpDetail.textContent = "控制系统报告水泵故障";
  }else{
    setHardwareState(ui.hwPump, driving ? "运行指令" : "待机", driving ? "active" : "ok");
    if(ui.hwPumpDetail){
      ui.hwPumpDetail.textContent = driving
        ? "指令已上报 · 未确认出水"
        : d.state === "soaking" ? "停泵渗透 · 等待复测" : "停止指令 · 无流量反馈";
    }
  }

  // These two components have no independent telemetry yet.
  setHardwareState(ui.hwPower, "未独立监测", "unmonitored");
  setHardwareState(ui.hwWaterPath, "未独立监测", "unmonitored");
}

function updateControls(){
  const d = status;
  const permitted = Boolean(health?.commandProtected) && !busy;
  const deviceUsable = Boolean(d?.online);
  const daily = Number(d?.daily || 0);
  const max = Number(d?.maxDaily || 3);
  const blocking = d?.state === "pumping" || d?.state === "soaking";

  ui.waterBtn.disabled = !permitted || !deviceUsable || !d?.sensorValid || daily >= max || blocking;
  ui.stopBtn.disabled = !permitted || !deviceUsable;
  ui.autoBtn.disabled = !permitted || !deviceUsable;
  ui.statusBtn.disabled = !permitted;
  ui.resetBtn.disabled = !permitted || !deviceUsable || blocking;
}

async function loadEvents(){
  try{
    const result = await api("/api/watering-events?days=7&limit=30");
    eventsCache = Array.isArray(result.events) ? result.events : [];
    renderEvents();
  }catch(error){
    ui.eventList.innerHTML = `<div class="empty">事件读取失败：${escapeHtml(error.message)}</div>`;
  }
}

function renderEvents(){
  const events = [...eventsCache]
    .sort((a,b)=>Number(b.updated_at || b.started_at || 0)-Number(a.updated_at || a.started_at || 0))
    .slice(0,30);
  ui.eventCount.textContent = String(events.length);
  ui.eventList.innerHTML = events.length
    ? events.map(eventHtml).join("")
    : '<div class="empty">暂无浇水事件</div>';
}

function eventHtml(e){
  const source = sourceText(e.source);
  const seconds = e.actual_seconds ?? e.planned_seconds;
  const when = e.started_at || e.updated_at;
  const phase = e.last_phase || "--";
  const moisture = e.before_moisture != null && e.after_moisture != null
    ? `湿度 ${e.before_moisture}% → ${e.after_moisture}%`
    : "湿度数据待补全";
  return `<div class="event"><div class="event-main"><div class="event-title">💧 ${escapeHtml(source)}</div><div class="event-sub">${escapeHtml(timeText(when))}${seconds != null ? ` ｜ ${seconds}s` : ""}<br>${escapeHtml(moisture)}</div></div><div class="event-status">${escapeHtml(phase)}</div></div>`;
}

function sourceText(source){
  if(source === "AUTO") return "自动浇水";
  if(source === "AUTO_VPD") return "VPD辅助浇水";
  if(source === "MANUAL_WEB") return "手动浇水";
  if(source === "MANUAL_SERIAL") return "串口手动";
  return source || "浇水";
}

async function loadHistory(){
  ui.trendEmpty.textContent = "正在读取历史数据…";
  ui.trendEmpty.classList.remove("hidden");
  ui.trendRefreshBtn.disabled = true;
  hideTrendTooltip();

  try{
    const result = await api("/api/history?days=7&soilLimit=22000&weatherLimit=1200&wateringLimit=100");
    history = {
      soil: Array.isArray(result.soil) ? result.soil : [],
      weather: Array.isArray(result.weather) ? result.weather : [],
      watering: Array.isArray(result.watering) ? result.watering : [],
      weatherMeta: result.weatherMeta || null,
    };
    historyCursorMs = computeHistoryCursorMs();
    lastWeatherDeltaAt = Date.now();
    renderTrend();
  }catch(error){
    trendModel = null;
    clearSvg(ui.trendSvg);
    ui.trendEmpty.textContent = `历史趋势读取失败：${error.message}`;
    ui.trendEmpty.classList.remove("hidden");
    ui.trendMeta.textContent = "趋势读取失败不会影响实时状态和远程控制。";
  }finally{
    ui.trendRefreshBtn.disabled = false;
  }
}

function computeHistoryCursorMs(){
  let cursor = 0;
  for(const row of history.soil || []) cursor = Math.max(cursor, toMillis(row.ts));
  for(const row of history.weather || []) cursor = Math.max(cursor, toMillis(row.ts));
  for(const row of history.watering || []) cursor = Math.max(cursor, toMillis(row.updated_at || row.started_at));
  return cursor || Math.max(0, Date.now() - 120000);
}

function mergeRows(existing, incoming, keyFn, sortFn){
  const map = new Map();
  for(const row of existing || []) map.set(keyFn(row), row);
  for(const row of incoming || []){
    const key = keyFn(row);
    map.set(key, {...(map.get(key) || {}), ...row});
  }
  return [...map.values()].sort(sortFn);
}

function pruneHistory(){
  const cutoffMs = Date.now() - 7 * 86400 * 1000;
  const cutoffSec = Math.floor(cutoffMs / 1000);
  history.soil = history.soil.filter(r=>toMillis(r.ts) >= cutoffMs);
  history.weather = history.weather.filter(r=>toMillis(r.ts) >= cutoffMs);
  history.watering = history.watering.filter(r=>Number(r.updated_at || r.started_at || 0) >= cutoffSec);
  eventsCache = eventsCache.filter(r=>Number(r.updated_at || r.started_at || 0) >= cutoffSec);
}

async function loadHistoryDelta(){
  if(deltaRequestInFlight || !historyCursorMs || document.hidden) return;
  deltaRequestInFlight = true;

  try{
    const since = Math.max(0, historyCursorMs - 1000);
    const includeWeather = Date.now() - lastWeatherDeltaAt >= 5 * 60 * 1000;
    const result = await api(
      `/api/history/delta?since=${since}&soilLimit=240&weatherLimit=64&wateringLimit=40&weather=${includeWeather ? 1 : 0}`
    );
    if(includeWeather) lastWeatherDeltaAt = Date.now();

    const soilDelta = Array.isArray(result.soil) ? result.soil : [];
    const weatherDelta = Array.isArray(result.weather) ? result.weather : [];
    const wateringDelta = Array.isArray(result.watering) ? result.watering : [];

    if(soilDelta.length){
      history.soil = mergeRows(
        history.soil,
        soilDelta,
        r=>`${r.device_id || "niuniu-main"}:${r.ts}`,
        (a,b)=>toMillis(a.ts)-toMillis(b.ts)
      );
    }

    if(weatherDelta.length){
      history.weather = mergeRows(
        history.weather,
        weatherDelta,
        r=>String(r.ts),
        (a,b)=>toMillis(a.ts)-toMillis(b.ts)
      );
    }

    if(wateringDelta.length){
      history.watering = mergeRows(
        history.watering,
        wateringDelta,
        r=>String(r.event_id || `${r.started_at}:${r.source}`),
        (a,b)=>Number(a.updated_at || a.started_at || 0)-Number(b.updated_at || b.started_at || 0)
      );

      eventsCache = mergeRows(
        eventsCache,
        wateringDelta,
        r=>String(r.event_id || `${r.started_at}:${r.source}`),
        (a,b)=>Number(b.updated_at || b.started_at || 0)-Number(a.updated_at || a.started_at || 0)
      );
      renderEvents();
    }

    if(soilDelta.length || weatherDelta.length || wateringDelta.length){
      pruneHistory();
      historyCursorMs = Math.max(historyCursorMs, computeHistoryCursorMs());
      renderTrend();
    }
  }catch(error){
    console.warn("delta refresh failed", error);
  }finally{
    deltaRequestInFlight = false;
  }
}

function renderTrend(){
  const dataNow = Date.now();
  const fullStart = dataNow - trendHours * 3600 * 1000;
  trendViewHours = clamp(trendViewHours, TREND_MIN_VIEW_HOURS, trendHours);
  trendEndOffsetHours = clamp(trendEndOffsetHours, 0, Math.max(0, trendHours - trendViewHours));

  const viewEnd = dataNow - trendEndOffsetHours * 3600 * 1000;
  const viewStart = Math.max(fullStart, viewEnd - trendViewHours * 3600 * 1000);
  const effectiveHours = (viewEnd - viewStart) / 3600000;
  const weatherInfo = weatherFreshness(dataNow);

  let soil = history.soil
    .map(r => ({t:toMillis(r.ts), v:Number(r.moisture), valid:Boolean(r.sensor_valid)}))
    .filter(r => r.t >= viewStart && r.t <= viewEnd && Number.isFinite(r.v) && r.valid)
    .sort((a,b)=>a.t-b.t);

  const liveSoilTs = toMillis(status?.timestamp || 0);
  const liveSoilValue = Number(status?.moisture);
  if(status?.sensorValid &&
     Number.isFinite(liveSoilValue) &&
     liveSoilTs >= viewStart &&
     liveSoilTs <= viewEnd &&
     (!soil.length || liveSoilTs > soil[soil.length-1].t)){
    soil = [...soil,{t:liveSoilTs,v:liveSoilValue,valid:true,live:true}];
  }

  const weatherRows = history.weather
    .map(r => ({
      t:toMillis(r.ts),
      humidity:Number(r.humidity_pct),
      temp:Number(r.temperature_c),
    }))
    .filter(r => r.t >= viewStart && r.t <= viewEnd)
    .sort((a,b)=>a.t-b.t);

  const humidity = weatherRows
    .filter(r => Number.isFinite(r.humidity))
    .map(r => ({t:r.t,v:r.humidity}));

  const temp = weatherRows
    .filter(r => Number.isFinite(r.temp))
    .map(r => ({t:r.t,v:r.temp}));

  const vpd = weatherRows
    .filter(r => Number.isFinite(r.temp) && Number.isFinite(r.humidity))
    .map(r => ({t:r.t,v:calculateVpd(r.temp,r.humidity)}))
    .filter(r => Number.isFinite(r.v));

  const watering = history.watering
    .map(normalizeWateringEvent)
    .filter(r => r.end >= viewStart && r.start <= viewEnd)
    .sort((a,b)=>a.start-b.start);

  clearSvg(ui.trendSvg);
  hideTrendTooltip();

  updateTrendControls(effectiveHours);

  if(!soil.length && !humidity.length && !temp.length && !vpd.length){
    trendModel = null;
    ui.trendEmpty.textContent = "当前时间范围内暂无可绘制的历史数据";
    ui.trendEmpty.classList.remove("hidden");
    ui.trendMeta.textContent = `已读取：土壤 ${history.soil.length} 条，天气 ${history.weather.length} 条，浇水 ${history.watering.length} 条 ｜ ${weatherInfo.text}`;
    ui.trendMeta.classList.toggle("warn", weatherInfo.stale);
    return;
  }

  ui.trendEmpty.classList.add("hidden");

  const W = 520, H = 300;
  const m = {l:40, r:38, t:18};
  const mainBottom = 204;
  const vpdTop = 221;
  const vpdBottom = 269;
  const xAxisY = 292;
  const pw = W - m.l - m.r;
  const ph = mainBottom - m.t;
  const vpdH = vpdBottom - vpdTop;
  const x = t => m.l + ((t - viewStart) / (viewEnd - viewStart)) * pw;
  const yPct = v => m.t + (1 - clamp(Number(v), 0, 100) / 100) * ph;
  const yTemp = v => m.t + (1 - clamp(Number(v), 0, 50) / 50) * ph;

  const maxObservedVpd = vpd.length ? Math.max(...vpd.map(p=>p.v)) : 0;
  const vpdMax = Math.max(2.5, Math.ceil(maxObservedVpd * 2) / 2);
  const yVpd = v => vpdTop + (1 - clamp(Number(v), 0, vpdMax) / vpdMax) * vpdH;

  appendSvg("defs",{}, "");
  const defs = ui.trendSvg.querySelector("defs");
  defs.innerHTML = `
    <linearGradient id="wateringAutoGlow" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#7ab987" stop-opacity="0"></stop>
      <stop offset="28%" stop-color="#7ab987" stop-opacity=".08"></stop>
      <stop offset="50%" stop-color="#6fab7b" stop-opacity=".24"></stop>
      <stop offset="72%" stop-color="#7ab987" stop-opacity=".08"></stop>
      <stop offset="100%" stop-color="#7ab987" stop-opacity="0"></stop>
    </linearGradient>
    <linearGradient id="wateringManualGlow" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#79a8b4" stop-opacity="0"></stop>
      <stop offset="28%" stop-color="#79a8b4" stop-opacity=".07"></stop>
      <stop offset="50%" stop-color="#6d9eaa" stop-opacity=".22"></stop>
      <stop offset="72%" stop-color="#79a8b4" stop-opacity=".07"></stop>
      <stop offset="100%" stop-color="#79a8b4" stop-opacity="0"></stop>
    </linearGradient>
  `;

  for(const pct of [0,25,50,75,100]){
    const y = yPct(pct);
    appendSvg("line",{x1:m.l,y1:y,x2:W-m.r,y2:y,class:"grid-line"});
    appendSvg("text",{x:m.l-7,y:y+3,class:"axis-label left","text-anchor":"end"}, `${pct}`);
  }
  appendSvg("text",{x:m.l-7,y:m.t-6,class:"axis-unit left","text-anchor":"end"},"%");

  for(const t of [0,25,50]){
    const y = yTemp(t);
    appendSvg("text",{x:W-m.r+7,y:y+3,class:"axis-label right","text-anchor":"start"}, `${t}`);
  }
  appendSvg("text",{x:W-m.r+7,y:m.t-6,class:"axis-unit right","text-anchor":"start"},"°C");

  appendSvg("rect",{x:m.l,y:vpdTop,width:pw,height:vpdH,rx:7,class:"vpd-band-bg"});
  appendSvg("text",{x:m.l+6,y:vpdTop+11,class:"vpd-title"},"VPD · kPa");
  appendSvg("text",{x:m.l-7,y:yVpd(0)+3,class:"vpd-label","text-anchor":"end"},"0");
  appendSvg("text",{x:m.l-7,y:yVpd(vpdMax)+3,class:"vpd-label","text-anchor":"end"},vpdMax.toFixed(1));

  const assistThreshold = 1.60;
  if(assistThreshold <= vpdMax){
    const ty = yVpd(assistThreshold);
    appendSvg("line",{x1:m.l,y1:ty,x2:W-m.r,y2:ty,class:"vpd-threshold"});
    appendSvg("text",{x:W-m.r-4,y:ty-3,class:"vpd-label","text-anchor":"end"},"辅助阈值 1.60");
  }

  for(let i=0;i<5;i++){
    const p = i / 4;
    const tx = m.l + p * pw;
    const ts = viewStart + p * (viewEnd - viewStart);
    appendSvg("line",{x1:tx,y1:vpdBottom,x2:tx,y2:vpdBottom+4,class:"axis-tick"});
    appendSvg("text",{x:tx,y:xAxisY,class:"x-label","text-anchor":i===0?"start":i===4?"end":"middle"}, formatAxisTime(ts, effectiveHours));
  }

  const wateringBands = [];
  if(trendVisibility.watering){
    watering.slice(-60).forEach(e=>{
      const realStartX = x(clamp(e.start, viewStart, viewEnd));
      const realEndX = x(clamp(Math.max(e.end, e.start + 1000), viewStart, viewEnd));
      const realLeft = Math.min(realStartX, realEndX);
      const realRight = Math.max(realStartX, realEndX);
      const realWidth = Math.max(0, realRight - realLeft);
      const minimumWidth = effectiveHours >= 72 ? 5 : effectiveHours >= 24 ? 4 : 3;
      const bandW = Math.min(pw, Math.max(realWidth, minimumWidth));
      const centerX = (realLeft + realRight) / 2;
      const bandX = clamp(centerX - bandW / 2, m.l, W - m.r - bandW);
      const kind = e.source === "AUTO" || e.source === "AUTO_VPD" ? "auto" : "manual";

      const band = appendSvg("rect",{
        x:bandX,y:m.t,width:bandW,height:vpdBottom-m.t,
        class:`watering-band ${kind}`,rx:Math.min(3, bandW/2)
      });
      band.setAttribute("aria-label", `${sourceText(e.source)} ${timeText(e.start/1000)} 至 ${timeText(e.end/1000)}`);
      wateringBands.push({...e, x1:bandX, x2:bandX+bandW});
    });
  }

  const dynamicMaxPoints = clamp(Math.round(480 * trendHours / Math.max(TREND_MIN_VIEW_HOURS,effectiveHours)), 480, 1800);
  if(trendVisibility.soil) drawSeries(downsample(soil, dynamicMaxPoints), x, yPct, "series soil");
  if(trendVisibility.humidity) drawSeries(downsample(humidity, dynamicMaxPoints), x, yPct, "series humidity");
  if(trendVisibility.temp) drawSeries(downsample(temp, dynamicMaxPoints), x, yTemp, "series temp");
  if(trendVisibility.vpd) drawSeries(downsample(vpd, dynamicMaxPoints), x, yVpd, "series vpd");

  const hoverLine = appendSvg("line",{x1:m.l,y1:m.t,x2:m.l,y2:vpdBottom,class:"hover-line hidden-svg"});
  const hoverSoil = appendSvg("circle",{cx:m.l,cy:m.t,r:4,class:"hover-point soil hidden-svg"});
  const hoverHumidity = appendSvg("circle",{cx:m.l,cy:m.t,r:4,class:"hover-point humidity hidden-svg"});
  const hoverTemp = appendSvg("circle",{cx:m.l,cy:m.t,r:4,class:"hover-point temp hidden-svg"});
  const hoverVpd = appendSvg("circle",{cx:m.l,cy:vpdTop,r:4,class:"hover-point vpd hidden-svg"});
  const hit = appendSvg("rect",{x:m.l,y:m.t,width:pw,height:vpdBottom-m.t,class:"trend-hit",fill:"transparent"});

  trendModel = {
    now:viewEnd, since:viewStart, fullStart, dataNow, W, H, m, pw, ph, x, yPct, yTemp, yVpd,
    vpdTop, vpdBottom, soil, humidity, temp, vpd, wateringBands,
    hoverLine, hoverSoil, hoverHumidity, hoverTemp, hoverVpd,
  };

  bindTrendPointer(hit);

  const shown = [];
  if(soil.length) shown.push(`土壤 ${soil.length}`);
  if(humidity.length || temp.length) shown.push(`天气 ${Math.max(humidity.length,temp.length)}`);
  if(vpd.length) shown.push(`VPD ${vpd.length}`);
  if(watering.length) shown.push(`浇水 ${watering.length}`);

  const rangeLabel = trendHours===168?"7天":trendHours===72?"3天":"24小时";
  const viewLabel = effectiveHours >= 24
    ? `${Math.round(effectiveHours/24)}天`
    : `${effectiveHours.toFixed(effectiveHours<4?1:0)}小时`;
  ui.trendTitle.textContent = trendViewHours < trendHours
    ? `${rangeLabel}环境趋势 · 当前${viewLabel}视窗`
    : `${rangeLabel}环境趋势`;

  ui.trendMeta.textContent = `${viewLabel}视窗 ｜ ${shown.join(" · ") || "暂无数据"} ｜ ${weatherInfo.text} ｜ 电脑：左键框选放大，Shift+拖动平移；手机：轻触查看，放大后左右拖动`;
  ui.trendMeta.classList.toggle("warn", weatherInfo.stale);
}

function updateTrendControls(effectiveHours = trendViewHours){
  const fullyZoomedOut = trendViewHours >= trendHours - 0.01;
  const fullyZoomedIn = trendViewHours <= TREND_MIN_VIEW_HOURS + 0.01;
  ui.zoomOutBtn.disabled = fullyZoomedOut;
  ui.zoomInBtn.disabled = fullyZoomedIn;
  ui.zoomResetBtn.disabled = fullyZoomedOut && trendEndOffsetHours <= 0.01;

  if(!ui.trendTitle) return;
  if(!Number.isFinite(effectiveHours)) effectiveHours = trendViewHours;
}

function zoomTrend(factor){
  const oldHours = trendViewHours;
  const newHours = clamp(oldHours * factor, TREND_MIN_VIEW_HOURS, trendHours);
  if(Math.abs(newHours-oldHours) < 0.01) return;

  const currentEndOffset = trendEndOffsetHours;
  const currentCenterOffset = currentEndOffset + oldHours/2;
  trendViewHours = newHours;
  trendEndOffsetHours = clamp(
    currentCenterOffset - newHours/2,
    0,
    Math.max(0, trendHours-newHours)
  );
  renderTrend();
}

function resetTrendView(){
  trendViewHours = trendHours;
  trendEndOffsetHours = 0;
  renderTrend();
}

function weatherFreshness(now = Date.now()){
  const times = history.weather
    .map(row => toMillis(row.ts))
    .filter(Number.isFinite);

  if(!times.length){
    return { stale:true, text:"⚠ 天气数据暂未更新" };
  }

  const latest = Math.max(...times);
  const ageMinutes = Math.max(0, Math.floor((now - latest) / 60000));
  const stamp = new Date(latest).toLocaleString("zh-CN",{
    hour12:false,
    month:"2-digit",
    day:"2-digit",
    hour:"2-digit",
    minute:"2-digit"
  });

  if(ageMinutes > 90){
    return {
      stale:true,
      text:`⚠ 天气更新：${stamp}（已 ${ageMinutes} 分钟未更新）`
    };
  }

  return {
    stale:false,
    text:`天气更新：${stamp}`
  };
}

function normalizeWateringEvent(row){
  const start = toMillis(row.started_at || row.updated_at);
  let end = toMillis(row.stopped_at || row.verified_at || 0);
  const seconds = Number(row.actual_seconds ?? row.planned_seconds ?? 0);

  if(!end || end < start){
    end = start + Math.max(1, seconds || 1) * 1000;
  }

  return {
    ...row,
    start,
    end,
    source: row.source || "UNKNOWN",
  };
}

function bindTrendPointer(hit){
  hit.addEventListener("pointermove", (event)=>{
    if(trendPan?.moved || trendSelection?.moved) return;
    showTrendPointer(event);
  });
  hit.addEventListener("pointerdown", showTrendPointer);
  hit.addEventListener("pointerleave", (event)=>{
    if(event.pointerType !== "touch" && !trendPan && !trendSelection) hideTrendTooltip();
  });
}

function showTrendPointer(event){
  const model = trendModel;
  if(!model || trendPan?.moved || trendSelection?.moved) return;
  if(event.pointerType === "touch" && !event.isPrimary) return;

  const svgRect = ui.trendSvg.getBoundingClientRect();
  if(!svgRect.width || !svgRect.height) return;

  const svgX = (event.clientX - svgRect.left) * model.W / svgRect.width;
  const clampedX = clamp(svgX, model.m.l, model.W-model.m.r);
  const ratio = (clampedX - model.m.l) / model.pw;
  const t = model.since + ratio * (model.now - model.since);

  const soil = trendVisibility.soil ? nearestPoint(model.soil, t) : null;
  const humidity = trendVisibility.humidity ? nearestPoint(model.humidity, t) : null;
  const temp = trendVisibility.temp ? nearestPoint(model.temp, t) : null;
  const vpd = trendVisibility.vpd ? nearestPoint(model.vpd, t) : null;
  const watering = trendVisibility.watering ? nearestWateringBand(model.wateringBands, clampedX) : null;

  model.hoverLine.setAttribute("x1", clampedX);
  model.hoverLine.setAttribute("x2", clampedX);
  model.hoverLine.classList.remove("hidden-svg");

  positionHoverPoint(model.hoverSoil, clampedX, soil ? model.yPct(soil.v) : null);
  positionHoverPoint(model.hoverHumidity, clampedX, humidity ? model.yPct(humidity.v) : null);
  positionHoverPoint(model.hoverTemp, clampedX, temp ? model.yTemp(temp.v) : null);
  positionHoverPoint(model.hoverVpd, clampedX, vpd ? model.yVpd(vpd.v) : null);

  const rows = [
    `<div class="tip-time">${escapeHtml(formatTooltipTime(t))}</div>`,
    soil ? `<div class="tip-row"><span><i class="tip-dot soil"></i>土壤湿度</span><b>${formatValue(soil.v, "%")}</b></div>` : "",
    humidity ? `<div class="tip-row"><span><i class="tip-dot humidity"></i>环境湿度</span><b>${formatValue(humidity.v, "%")}</b></div>` : "",
    temp ? `<div class="tip-row"><span><i class="tip-dot temp"></i>温度</span><b>${formatValue(temp.v, "℃", 1)}</b></div>` : "",
    vpd ? `<div class="tip-row"><span><i class="tip-dot vpd"></i>VPD</span><b>${formatValue(vpd.v, " kPa", 2)}</b></div>` : "",
  ];

  if(watering){
    const seconds = Math.max(1, Math.round((watering.end-watering.start)/1000));
    const startText = formatTooltipTime(watering.start);
    const endText = formatTooltipTime(watering.end);
    rows.push(`<div class="tip-watering">💧 ${escapeHtml(sourceText(watering.source))}<br><span>${escapeHtml(startText)} → ${escapeHtml(endText)} · ${seconds}s</span></div>`);
  }

  ui.trendTooltip.innerHTML = rows.filter(Boolean).join("");
  ui.trendTooltip.classList.remove("hidden");

  const boxRect = ui.trendBox.getBoundingClientRect();
  const px = event.clientX - boxRect.left;
  ui.trendTooltip.style.left = `${clamp(px, 12, boxRect.width-12)}px`;
  ui.trendTooltip.style.top = "10px";
  ui.trendTooltip.classList.toggle("flip", px > boxRect.width * 0.58);
}

function hideTrendTooltip(){
  ui.trendTooltip?.classList.add("hidden");
  if(!trendModel) return;
  trendModel.hoverLine?.classList.add("hidden-svg");
  trendModel.hoverSoil?.classList.add("hidden-svg");
  trendModel.hoverHumidity?.classList.add("hidden-svg");
  trendModel.hoverTemp?.classList.add("hidden-svg");
  trendModel.hoverVpd?.classList.add("hidden-svg");
}

function positionHoverPoint(el, x, y){
  if(y == null || !Number.isFinite(y)){
    el.classList.add("hidden-svg");
    return;
  }
  el.setAttribute("cx", x);
  el.setAttribute("cy", y);
  el.classList.remove("hidden-svg");
}

function nearestPoint(rows, target){
  if(!rows.length) return null;
  let lo = 0, hi = rows.length - 1;

  while(lo < hi){
    const mid = Math.floor((lo + hi) / 2);
    if(rows[mid].t < target) lo = mid + 1;
    else hi = mid;
  }

  const a = rows[lo];
  const b = lo > 0 ? rows[lo-1] : null;
  if(!b) return a;
  return Math.abs(a.t-target) < Math.abs(b.t-target) ? a : b;
}

function nearestWateringBand(bands, x){
  if(!bands.length) return null;
  const direct = bands.find(b => x >= b.x1 && x <= b.x2);
  if(direct) return direct;

  let best = null;
  let bestDistance = Infinity;
  for(const band of bands){
    const center = (band.x1 + band.x2) / 2;
    const distance = Math.abs(center - x);
    if(distance < bestDistance){
      bestDistance = distance;
      best = band;
    }
  }
  return bestDistance <= 7 ? best : null;
}

function formatTooltipTime(ms){
  return new Date(ms).toLocaleString("zh-CN",{
    hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"
  });
}

function calculateVpd(temperature, humidity){
  const t = Number(temperature);
  const rh = Number(humidity);
  if(!Number.isFinite(t) || !Number.isFinite(rh)) return NaN;
  const saturationKpa = 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
  return saturationKpa * (1 - clamp(rh, 0, 100) / 100);
}

function formatValue(value, unit, digits=0){
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(digits)}${unit}` : "--";
}

function drawSeries(points, x, y, className){
  if(points.length < 2) return;
  const d = points.map((p,i)=>`${i?"L":"M"} ${x(p.t).toFixed(2)} ${y(p.v).toFixed(2)}`).join(" ");
  appendSvg("path",{d,class:className});
}

function appendSvg(tag, attrs={}, text=""){
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for(const [k,v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if(text) el.textContent = text;
  ui.trendSvg.appendChild(el);
  return el;
}

function clearSvg(svg){
  while(svg.firstChild) svg.removeChild(svg.firstChild);
}

function downsample(rows, maxPoints){
  if(rows.length <= maxPoints) return rows;
  const step = rows.length / maxPoints;
  const out = [];
  for(let i=0;i<maxPoints;i++) out.push(rows[Math.floor(i*step)]);
  if(out[out.length-1] !== rows[rows.length-1]) out.push(rows[rows.length-1]);
  return out;
}

function formatAxisTime(ms, hours){
  const d = new Date(ms);
  if(hours <= 24) return d.toLocaleTimeString("zh-CN",{hour12:false,hour:"2-digit",minute:"2-digit"});
  return d.toLocaleDateString("zh-CN",{month:"2-digit",day:"2-digit"});
}

function clamp(v,min,max){
  return Math.min(max,Math.max(min,v));
}

async function sendCommand(command){
  if(busy) return;
  busy = true;
  updateControls();
  setMessage(`正在发送：${command}…`);
  try{
    await api("/api/command", {
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({command}),
    });
    setMessage(`命令已发送：${command}`, "ok");
    await new Promise(r=>setTimeout(r,700));
    await Promise.all([loadStatus(), loadEvents()]);
    if(command === "water" || command === "stop"){
      setTimeout(loadHistoryDelta, 1500);
    }
  }catch(error){
    if(error.status === 403){
      setMessage("远程控制尚未开放：请先启用 Cloudflare Access。", "err");
    }else if(error.status === 409){
      setMessage("EMQX 已接收命令，但当前没有在线订阅设备。", "err");
    }else{
      setMessage(`命令失败：${error.message}`, "err");
    }
  }finally{
    busy = false;
    updateControls();
  }
}

function escapeHtml(value){
  return String(value ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
}

ui.waterBtn.addEventListener("click",()=>{ if(confirm("确认执行一次浇水吗？")) sendCommand("water"); });
ui.stopBtn.addEventListener("click",()=>sendCommand("stop"));
ui.autoBtn.addEventListener("click",()=>sendCommand(status?.auto ? "auto_off" : "auto_on"));
ui.statusBtn.addEventListener("click",()=>sendCommand("status"));
ui.resetBtn.addEventListener("click",()=>{ if(confirm("确认将今日浇水次数复位为 0/3 吗？\n\n水泵运行或渗透复测期间不能复位。")) sendCommand("reset_daily"); });
ui.refreshBtn.addEventListener("click",refreshAll);
ui.trendRefreshBtn.addEventListener("click",loadHistory);

function setupTrendLegend(){
  document.querySelectorAll(".legend > span").forEach((item,index)=>{
    const key = TREND_SERIES_KEYS[index];
    if(!key) return;
    item.dataset.series = key;
    item.setAttribute("role","button");
    item.setAttribute("tabindex","0");
    item.setAttribute("aria-pressed","true");

    const updateLabelState = ()=>{
      const visible = trendVisibility[key];
      item.classList.toggle("off", !visible);
      item.setAttribute("aria-pressed", String(visible));
      item.title = `点击${visible ? "隐藏" : "显示"}${item.textContent.trim()}`;
    };

    const toggle = ()=>{
      trendVisibility[key] = !trendVisibility[key];
      updateLabelState();
      hideTrendTooltip();
      renderTrend();
    };

    updateLabelState();
    item.addEventListener("click", toggle);
    item.addEventListener("keydown",(event)=>{
      if(event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    });
  });
}

document.querySelectorAll(".range-btn").forEach(btn=>{
  btn.addEventListener("click",()=>{
    trendHours = Number(btn.dataset.hours || 168);
    trendViewHours = trendHours;
    trendEndOffsetHours = 0;
    document.querySelectorAll(".range-btn").forEach(x=>x.classList.toggle("active",x===btn));
    renderTrend();
  });
});

ui.zoomInBtn.addEventListener("click",()=>zoomTrend(0.5));
ui.zoomOutBtn.addEventListener("click",()=>zoomTrend(2));
ui.zoomResetBtn.addEventListener("click",resetTrendView);

// Desktop:
// - plain left-drag selects a time range and zooms into it;
// - Shift + left-drag pans an already zoomed view.
// Mobile:
// - keep the existing horizontal pan gesture after zooming;
// - vertical gestures remain available for normal page scrolling.
function ensureTrendSelectionEl(){
  if(trendSelectionEl) return trendSelectionEl;
  trendSelectionEl = document.createElement("div");
  trendSelectionEl.className = "trend-select-band";
  ui.trendBox.appendChild(trendSelectionEl);
  return trendSelectionEl;
}

function hideTrendSelectionBand(){
  if(trendSelectionEl) trendSelectionEl.classList.remove("active");
  ui.trendBox.classList.remove("selecting");
}

function trendPlotGeometry(){
  const model = trendModel;
  if(!model) return null;

  const boxRect = ui.trendBox.getBoundingClientRect();
  const svgRect = ui.trendSvg.getBoundingClientRect();
  if(!boxRect.width || !svgRect.width || !svgRect.height) return null;

  // SVG uses the default xMidYMid meet behavior, so the rendered viewBox may
  // have letterboxing when CSS min-height changes the aspect ratio.
  const scale = Math.min(svgRect.width / model.W, svgRect.height / model.H);
  const offsetX = (svgRect.width - model.W * scale) / 2;
  const offsetY = (svgRect.height - model.H * scale) / 2;

  return {
    boxRect,
    left: svgRect.left - boxRect.left + offsetX + model.m.l * scale,
    right: svgRect.left - boxRect.left + offsetX + (model.W - model.m.r) * scale,
    top: svgRect.top - boxRect.top + offsetY + model.m.t * scale,
    bottom: svgRect.top - boxRect.top + offsetY + model.vpdBottom * scale,
  };
}

function pointInsideTrendPlot(event, geometry){
  const x = event.clientX - geometry.boxRect.left;
  const y = event.clientY - geometry.boxRect.top;
  return x >= geometry.left && x <= geometry.right && y >= geometry.top && y <= geometry.bottom;
}

function updateTrendSelectionBand(selection, clientX){
  const g = selection.geometry;
  const currentX = clamp(clientX - g.boxRect.left, g.left, g.right);
  const left = Math.min(selection.startBoxX, currentX);
  const right = Math.max(selection.startBoxX, currentX);

  const band = ensureTrendSelectionEl();
  band.style.left = `${left}px`;
  band.style.top = `${g.top}px`;
  band.style.width = `${Math.max(1, right-left)}px`;
  band.style.height = `${Math.max(1, g.bottom-g.top)}px`;
  band.classList.add("active");
  ui.trendBox.classList.add("selecting");
}

function applyTrendSelection(selection, clientX){
  const g = selection.geometry;
  const endBoxX = clamp(clientX - g.boxRect.left, g.left, g.right);
  const left = Math.min(selection.startBoxX, endBoxX);
  const right = Math.max(selection.startBoxX, endBoxX);
  const plotWidth = Math.max(1, g.right - g.left);

  if(right-left < 8) return;

  const leftRatio = clamp((left-g.left)/plotWidth, 0, 1);
  const rightRatio = clamp((right-g.left)/plotWidth, 0, 1);
  const selectedStart = selection.viewStart + leftRatio * (selection.viewEnd-selection.viewStart);
  const selectedEnd = selection.viewStart + rightRatio * (selection.viewEnd-selection.viewStart);
  const selectedHours = Math.max(0, (selectedEnd-selectedStart) / 3600000);
  const newHours = clamp(selectedHours, TREND_MIN_VIEW_HOURS, trendHours);
  const center = (selectedStart + selectedEnd) / 2;
  const centerOffsetHours = (selection.dataNow - center) / 3600000;

  trendViewHours = newHours;
  trendEndOffsetHours = clamp(
    centerOffsetHours - newHours/2,
    0,
    Math.max(0, trendHours-newHours)
  );
  renderTrend();
}

function beginTrendPan(event){
  if(trendViewHours >= trendHours - 0.01) return false;
  trendPan = {
    pointerId:event.pointerId,
    pointerType:event.pointerType,
    startX:event.clientX,
    startY:event.clientY,
    startOffset:trendEndOffsetHours,
    moved:false,
    captured:false,
  };
  return true;
}

ui.trendBox.addEventListener("pointerdown",(event)=>{
  if(!trendModel) return;
  if(event.pointerType === "touch" && !event.isPrimary) return;

  // Mouse: ordinary left drag = box zoom; Shift+drag = pan.
  if(event.pointerType === "mouse"){
    if(event.button !== 0) return;

    if(event.shiftKey){
      beginTrendPan(event);
      return;
    }

    const geometry = trendPlotGeometry();
    if(!geometry || !pointInsideTrendPlot(event, geometry)) return;

    trendSelection = {
      pointerId:event.pointerId,
      startX:event.clientX,
      startY:event.clientY,
      startBoxX:clamp(event.clientX - geometry.boxRect.left, geometry.left, geometry.right),
      geometry,
      viewStart:trendModel.since,
      viewEnd:trendModel.now,
      dataNow:trendModel.dataNow,
      moved:false,
      captured:false,
    };
    return;
  }

  // Touch/pen: preserve the existing pan behavior.
  beginTrendPan(event);
});

ui.trendBox.addEventListener("pointermove",(event)=>{
  if(trendSelection && trendSelection.pointerId === event.pointerId){
    const dx = event.clientX - trendSelection.startX;

    if(!trendSelection.moved){
      if(Math.abs(dx) < 6) return;
      trendSelection.moved = true;
      try{
        ui.trendBox.setPointerCapture?.(event.pointerId);
        trendSelection.captured = true;
      }catch{}
      hideTrendTooltip();
    }

    if(event.cancelable) event.preventDefault();
    updateTrendSelectionBand(trendSelection, event.clientX);
    return;
  }

  if(!trendPan || trendPan.pointerId !== event.pointerId) return;
  if(event.pointerType === "touch" && !event.isPrimary) return;

  const width = Math.max(1, ui.trendBox.getBoundingClientRect().width);
  const dx = event.clientX - trendPan.startX;
  const dy = event.clientY - trendPan.startY;

  if(!trendPan.moved){
    const horizontalIntent =
      Math.abs(dx) >= 8 &&
      Math.abs(dx) > Math.abs(dy) * 1.15;

    const verticalIntent =
      Math.abs(dy) >= 8 &&
      Math.abs(dy) >= Math.abs(dx);

    if(verticalIntent && event.pointerType === "touch"){
      trendPan = null;
      return;
    }

    if(!horizontalIntent) return;

    trendPan.moved = true;
    try{
      ui.trendBox.setPointerCapture?.(event.pointerId);
      trendPan.captured = true;
    }catch{}
    hideTrendTooltip();
  }

  if(event.cancelable) event.preventDefault();

  const deltaHours = dx / width * trendViewHours;
  const nextOffset = clamp(
    trendPan.startOffset + deltaHours,
    0,
    Math.max(0, trendHours-trendViewHours)
  );

  if(Math.abs(nextOffset-trendEndOffsetHours) >= 0.01){
    trendEndOffsetHours = nextOffset;
    renderTrend();
  }
});

function finishTrendGesture(event, cancelled=false){
  if(trendSelection && trendSelection.pointerId === event.pointerId){
    const selection = trendSelection;
    trendSelection = null;

    if(selection.captured){
      try{ ui.trendBox.releasePointerCapture?.(event.pointerId); }catch{}
    }

    hideTrendSelectionBand();
    if(!cancelled && selection.moved){
      applyTrendSelection(selection, event.clientX);
    }
    hideTrendTooltip();
    return;
  }

  if(!trendPan || trendPan.pointerId !== event.pointerId) return;
  const moved = trendPan.moved;
  const captured = trendPan.captured;
  trendPan = null;

  if(captured){
    try{ ui.trendBox.releasePointerCapture?.(event.pointerId); }catch{}
  }
  if(moved) hideTrendTooltip();
}

ui.trendBox.addEventListener("pointerup",(event)=>finishTrendGesture(event,false));
ui.trendBox.addEventListener("pointercancel",(event)=>finishTrendGesture(event,true));

window.addEventListener("resize",()=>{
  hideTrendTooltip();
  scheduleHardwareLinks();
});

async function refreshAll(){
  await loadHealth();
  await Promise.all([loadStatus(), loadEvents()]);
  updateControls();
}

let statusTimer = null;
let deltaTimer = null;
let localTicker = null;

function stopPolling(){
  if(statusTimer) clearTimeout(statusTimer);
  if(deltaTimer) clearInterval(deltaTimer);
  if(localTicker) clearInterval(localTicker);
  statusTimer = null;
  deltaTimer = null;
  localTicker = null;
}

function statusPollDelay(){
  return status?.state === "pumping" || status?.state === "soaking"
    ? 5000
    : 10000;
}

function scheduleStatusPoll(delay = statusPollDelay()){
  if(document.hidden) return;
  if(statusTimer) clearTimeout(statusTimer);

  statusTimer = setTimeout(async ()=>{
    if(document.hidden) return;
    await loadStatus();
    scheduleStatusPoll(statusPollDelay());
  }, delay);
}

function startPolling(){
  stopPolling();
  if(document.hidden) return;

  renderRealtimeTick();
  localTicker = setInterval(renderRealtimeTick, 1000);
  deltaTimer = setInterval(loadHistoryDelta, 30000);
  scheduleStatusPoll(statusPollDelay());
}

document.addEventListener("visibilitychange", async ()=>{
  if(document.hidden){
    stopPolling();
    return;
  }

  await refreshAll();
  await loadHistoryDelta();
  startPolling();
});

setupTrendLegend();
await Promise.all([refreshAll(), loadHistory()]);
renderRealtimeTick();
scheduleHardwareLinks();
startPolling();
