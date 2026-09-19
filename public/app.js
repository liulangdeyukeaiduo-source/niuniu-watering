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
let eventsCache = [];
let historyCursorMs = 0;
let latestStatusResult = null;
let lastStatusReceivedAt = 0;
let lastRenderedMoisture = null;
let statusRequestInFlight = false;
let deltaRequestInFlight = false;
let lastWeatherDeltaAt = 0;

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
  trendViewHours = clamp(trendViewHours, 2, trendHours);
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
  watering.slice(-60).forEach(e=>{
    const realStartX = x(clamp(e.start, viewStart, viewEnd));
    const realEndX = x(clamp(Math.max(e.end, e.start + 1000), viewStart, viewEnd));
    const minimumWidth = 10;
    let bandX = Math.min(realStartX, W-m.r-minimumWidth);
    let bandW = Math.max(realEndX - realStartX, minimumWidth);
    if(bandX + bandW > W-m.r) bandW = Math.max(3, W-m.r-bandX);

    const kind = e.source === "AUTO" || e.source === "AUTO_VPD" ? "auto" : "manual";
    const fill = kind === "auto" ? "url(#wateringAutoGlow)" : "url(#wateringManualGlow)";
    const centerX = bandX + bandW / 2;

    const halo = appendSvg("rect",{
      x:bandX,y:m.t,width:bandW,height:vpdBottom-m.t,
      class:`watering-halo ${kind}`,fill,rx:Math.min(7, bandW/2)
    });
    halo.setAttribute("aria-label", `${sourceText(e.source)} ${timeText(e.start/1000)}`);

    appendSvg("line",{
      x1:centerX,y1:m.t+8,x2:centerX,y2:vpdBottom-3,
      class:`watering-focus-line ${kind}`
    });
    appendSvg("circle",{cx:centerX,cy:m.t+7,r:4.2,class:`watering-dot ${kind}`});
    appendSvg("circle",{cx:centerX-1.2,cy:m.t+5.8,r:1.1,class:"watering-dot-highlight"});
    wateringBands.push({...e, x1:bandX, x2:bandX+bandW});
  });

  const dynamicMaxPoints = clamp(Math.round(480 * trendHours / Math.max(2,effectiveHours)), 480, 1800);
  drawSeries(downsample(soil, dynamicMaxPoints), x, yPct, "series soil");
  drawSeries(downsample(humidity, dynamicMaxPoints), x, yPct, "series humidity");
  drawSeries(downsample(temp, dynamicMaxPoints), x, yTemp, "series temp");
  drawSeries(downsample(vpd, dynamicMaxPoints), x, yVpd, "series vpd");

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

  ui.trendMeta.textContent = `${viewLabel}视窗 ｜ ${shown.join(" · ") || "暂无数据"} ｜ ${weatherInfo.text} ｜ 悬浮/轻触查看；放大后左右拖动平移`;
  ui.trendMeta.classList.toggle("warn", weatherInfo.stale);
}

function updateTrendControls(effectiveHours = trendViewHours){
  const fullyZoomedOut = trendViewHours >= trendHours - 0.01;
  const fullyZoomedIn = trendViewHours <= 2.01;
  ui.zoomOutBtn.disabled = fullyZoomedOut;
  ui.zoomInBtn.disabled = fullyZoomedIn;
  ui.zoomResetBtn.disabled = fullyZoomedOut && trendEndOffsetHours <= 0.01;

  if(!ui.trendTitle) return;
  if(!Number.isFinite(effectiveHours)) effectiveHours = trendViewHours;
}

function zoomTrend(factor){
  const oldHours = trendViewHours;
  const newHours = clamp(oldHours * factor, 2, trendHours);
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
    if(trendPan?.moved) return;
    showTrendPointer(event);
  });
  hit.addEventListener("pointerdown", showTrendPointer);
  hit.addEventListener("pointerleave", (event)=>{
    if(event.pointerType !== "touch" && !trendPan) hideTrendTooltip();
  });
}

function showTrendPointer(event){
  const model = trendModel;
  if(!model || trendPan?.moved) return;
  if(event.pointerType === "touch" && !event.isPrimary) return;

  const svgRect = ui.trendSvg.getBoundingClientRect();
  if(!svgRect.width || !svgRect.height) return;

  const svgX = (event.clientX - svgRect.left) * model.W / svgRect.width;
  const clampedX = clamp(svgX, model.m.l, model.W-model.m.r);
  const ratio = (clampedX - model.m.l) / model.pw;
  const t = model.since + ratio * (model.now - model.since);

  const soil = nearestPoint(model.soil, t);
  const humidity = nearestPoint(model.humidity, t);
  const temp = nearestPoint(model.temp, t);
  const vpd = nearestPoint(model.vpd, t);
  const watering = nearestWateringBand(model.wateringBands, clampedX);

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
    rows.push(`<div class="tip-watering">💧 ${escapeHtml(sourceText(watering.source))}<br><span>${escapeHtml(timeText(watering.start/1000))} · ${seconds}s</span></div>`);
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

// Pan the zoomed view without any new D1 query.
// Mobile Safari safety:
// - only the primary finger participates;
// - do not capture on pointerdown;
// - take over only after a clear horizontal gesture;
// - vertical gestures stay available for normal page scrolling.
ui.trendBox.addEventListener("pointerdown",(event)=>{
  if(!trendModel || trendViewHours >= trendHours - 0.01) return;
  if(event.pointerType === "touch" && !event.isPrimary) return;

  trendPan = {
    pointerId:event.pointerId,
    pointerType:event.pointerType,
    startX:event.clientX,
    startY:event.clientY,
    startOffset:trendEndOffsetHours,
    moved:false,
    captured:false,
  };
});

ui.trendBox.addEventListener("pointermove",(event)=>{
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

    if(verticalIntent){
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

function finishTrendPan(event){
  if(!trendPan || trendPan.pointerId !== event.pointerId) return;
  const moved = trendPan.moved;
  const captured = trendPan.captured;
  trendPan = null;
  if(captured){
    try{ ui.trendBox.releasePointerCapture?.(event.pointerId); }catch{}
  }
  if(moved) hideTrendTooltip();
}
ui.trendBox.addEventListener("pointerup",finishTrendPan);
ui.trendBox.addEventListener("pointercancel",finishTrendPan);

window.addEventListener("resize",()=>{
  hideTrendTooltip();
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

await Promise.all([refreshAll(), loadHistory()]);
renderRealtimeTick();
startPolling();
