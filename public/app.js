const $ = (id) => document.getElementById(id);

const ui = {
  cloudDot: $("cloudDot"), cloudText: $("cloudText"), moisture: $("moisture"), heroHint: $("heroHint"),
  device: $("device"), state: $("state"), daily: $("daily"), auto: $("auto"),
  controlHint: $("controlHint"), message: $("message"), meta: $("meta"),
  waterBtn: $("waterBtn"), stopBtn: $("stopBtn"), autoBtn: $("autoBtn"), statusBtn: $("statusBtn"), resetBtn: $("resetBtn"), refreshBtn: $("refreshBtn"),
  eventList: $("eventList"), eventCount: $("eventCount"),
  trendBox: $("trendBox"), trendSvg: $("trendSvg"), trendTooltip: $("trendTooltip"),
  trendEmpty: $("trendEmpty"), trendMeta: $("trendMeta"), trendRefreshBtn: $("trendRefreshBtn"),
};

let health = null;
let status = null;
let history = { soil: [], weather: [], watering: [], weatherMeta: null };
let busy = false;
let trendHours = 168;
let trendModel = null;

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
  try{
    const result = await api("/api/status");
    status = result.data;
    renderStatus(result);
  }catch(error){
    document.body.classList.remove("watering-active");
    ui.device.textContent = "异常";
    ui.heroHint.textContent = "状态读取失败";
    setMessage(`状态读取失败：${error.message}`, "err");
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

  ui.moisture.textContent = d.sensorValid ? `${d.moisture}%` : "--%";
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

  if(trendModel) renderTrend();
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
    const events = result.events || [];
    ui.eventCount.textContent = String(events.length);
    ui.eventList.innerHTML = events.length ? events.map(eventHtml).join("") : '<div class="empty">暂无浇水事件</div>';
  }catch(error){
    ui.eventList.innerHTML = `<div class="empty">事件读取失败：${escapeHtml(error.message)}</div>`;
  }
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
    const result = await api("/api/history?days=7&soilLimit=10500&weatherLimit=2000&wateringLimit=100");
    history = {
      soil: Array.isArray(result.soil) ? result.soil : [],
      weather: Array.isArray(result.weather) ? result.weather : [],
      watering: Array.isArray(result.watering) ? result.watering : [],
      weatherMeta: result.weatherMeta || null,
    };
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

function renderTrend(){
  const now = Date.now();
  const since = now - trendHours * 3600 * 1000;
  const weatherInfo = weatherFreshness(now);

  const soil = history.soil
    .map(r => ({t:toMillis(r.ts), v:Number(r.moisture), valid:Boolean(r.sensor_valid)}))
    .filter(r => r.t >= since && r.t <= now && Number.isFinite(r.v) && r.valid)
    .sort((a,b)=>a.t-b.t);

  const humidity = history.weather
    .map(r => ({t:toMillis(r.ts), v:Number(r.humidity_pct)}))
    .filter(r => r.t >= since && r.t <= now && Number.isFinite(r.v))
    .sort((a,b)=>a.t-b.t);

  const temp = history.weather
    .map(r => ({t:toMillis(r.ts), v:Number(r.temperature_c)}))
    .filter(r => r.t >= since && r.t <= now && Number.isFinite(r.v))
    .sort((a,b)=>a.t-b.t);

  const watering = history.watering
    .map(normalizeWateringEvent)
    .filter(r => r.start >= since && r.start <= now)
    .sort((a,b)=>a.start-b.start);

  clearSvg(ui.trendSvg);
  hideTrendTooltip();

  if(!soil.length && !humidity.length && !temp.length){
    trendModel = null;
    ui.trendEmpty.textContent = "当前时间范围内暂无可绘制的历史数据";
    ui.trendEmpty.classList.remove("hidden");
    ui.trendMeta.textContent = `已读取：土壤 ${history.soil.length} 条，天气 ${history.weather.length} 条，浇水 ${history.watering.length} 条 ｜ ${weatherInfo.text}`;
    ui.trendMeta.classList.toggle("warn", weatherInfo.stale);
    return;
  }

  ui.trendEmpty.classList.add("hidden");

  const W = 520, H = 240;
  const m = {l:40, r:38, t:18, b:34};
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const x = t => m.l + ((t - since) / (now - since)) * pw;
  const yPct = v => m.t + (1 - clamp(Number(v), 0, 100) / 100) * ph;
  const yTemp = v => m.t + (1 - clamp(Number(v), 0, 50) / 50) * ph;

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

  for(let i=0;i<5;i++){
    const p = i / 4;
    const tx = m.l + p * pw;
    const ts = since + p * (now - since);
    appendSvg("line",{x1:tx,y1:H-m.b,x2:tx,y2:H-m.b+4,class:"axis-tick"});
    appendSvg("text",{x:tx,y:H-10,class:"x-label","text-anchor":i===0?"start":i===4?"end":"middle"}, formatAxisTime(ts, trendHours));
  }

  const wateringBands = [];
  watering.slice(-40).forEach(e=>{
    const realStartX = x(clamp(e.start, since, now));
    const realEndX = x(clamp(Math.max(e.end, e.start + 1000), since, now));
    const minimumWidth = 10;
    let bandX = Math.min(realStartX, W-m.r-minimumWidth);
    let bandW = Math.max(realEndX - realStartX, minimumWidth);
    if(bandX + bandW > W-m.r) bandW = Math.max(3, W-m.r-bandX);

    const kind = e.source === "AUTO" ? "auto" : "manual";
    const fill = e.source === "AUTO" ? "url(#wateringAutoGlow)" : "url(#wateringManualGlow)";
    const centerX = bandX + bandW / 2;

    const halo = appendSvg("rect",{
      x:bandX,
      y:m.t,
      width:bandW,
      height:ph,
      class:`watering-halo ${kind}`,
      fill,
      rx:Math.min(7, bandW/2)
    });
    halo.setAttribute("aria-label", `${sourceText(e.source)} ${timeText(e.start/1000)}`);

    appendSvg("line",{
      x1:centerX,y1:m.t+8,x2:centerX,y2:H-m.b-3,
      class:`watering-focus-line ${kind}`
    });
    appendSvg("circle",{
      cx:centerX,cy:m.t+7,r:4.2,
      class:`watering-dot ${kind}`
    });
    appendSvg("circle",{
      cx:centerX-1.2,cy:m.t+5.8,r:1.1,
      class:"watering-dot-highlight"
    });

    wateringBands.push({...e, x1:bandX, x2:bandX+bandW});
  });

  drawSeries(downsample(soil, 480), x, yPct, "series soil");
  drawSeries(downsample(humidity, 480), x, yPct, "series humidity");
  drawSeries(downsample(temp, 480), x, yTemp, "series temp");

  const hoverLine = appendSvg("line",{x1:m.l,y1:m.t,x2:m.l,y2:H-m.b,class:"hover-line hidden-svg"});
  const hoverSoil = appendSvg("circle",{cx:m.l,cy:m.t,r:4,class:"hover-point soil hidden-svg"});
  const hoverHumidity = appendSvg("circle",{cx:m.l,cy:m.t,r:4,class:"hover-point humidity hidden-svg"});
  const hoverTemp = appendSvg("circle",{cx:m.l,cy:m.t,r:4,class:"hover-point temp hidden-svg"});
  const hit = appendSvg("rect",{x:m.l,y:m.t,width:pw,height:ph,class:"trend-hit",fill:"transparent"});

  trendModel = {
    now, since, W, H, m, pw, ph, x, yPct, yTemp,
    soil, humidity, temp, wateringBands,
    hoverLine, hoverSoil, hoverHumidity, hoverTemp,
  };

  bindTrendPointer(hit);

  const shown = [];
  if(soil.length) shown.push(`土壤 ${soil.length}`);
  if(humidity.length || temp.length) shown.push(`天气 ${Math.max(humidity.length,temp.length)}`);
  if(watering.length) shown.push(`浇水 ${watering.length}`);

  ui.trendMeta.textContent = `${trendHours===168?"7天":trendHours===72?"3天":"24小时"}窗口 ｜ ${shown.join(" · ") || "暂无数据"} ｜ ${weatherInfo.text} ｜ 悬浮/轻触查看时点数据；柔光水幕表示真实浇水时段`;
  ui.trendMeta.classList.toggle("warn", weatherInfo.stale);
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
  hit.addEventListener("pointermove", showTrendPointer);
  hit.addEventListener("pointerdown", showTrendPointer);
  hit.addEventListener("pointerleave", (event)=>{
    if(event.pointerType !== "touch") hideTrendTooltip();
  });
}

function showTrendPointer(event){
  const model = trendModel;
  if(!model) return;

  const svgRect = ui.trendSvg.getBoundingClientRect();
  if(!svgRect.width || !svgRect.height) return;

  const svgX = (event.clientX - svgRect.left) * model.W / svgRect.width;
  const clampedX = clamp(svgX, model.m.l, model.W-model.m.r);
  const ratio = (clampedX - model.m.l) / model.pw;
  const t = model.since + ratio * (model.now - model.since);

  const soil = nearestPoint(model.soil, t);
  const humidity = nearestPoint(model.humidity, t);
  const temp = nearestPoint(model.temp, t);
  const watering = nearestWateringBand(model.wateringBands, clampedX);

  model.hoverLine.setAttribute("x1", clampedX);
  model.hoverLine.setAttribute("x2", clampedX);
  model.hoverLine.classList.remove("hidden-svg");

  positionHoverPoint(model.hoverSoil, clampedX, soil ? model.yPct(soil.v) : null);
  positionHoverPoint(model.hoverHumidity, clampedX, humidity ? model.yPct(humidity.v) : null);
  positionHoverPoint(model.hoverTemp, clampedX, temp ? model.yTemp(temp.v) : null);

  const rows = [
    `<div class="tip-time">${escapeHtml(formatTooltipTime(t))}</div>`,
    soil ? `<div class="tip-row"><span><i class="tip-dot soil"></i>土壤湿度</span><b>${formatValue(soil.v, "%")}</b></div>` : "",
    humidity ? `<div class="tip-row"><span><i class="tip-dot humidity"></i>环境湿度</span><b>${formatValue(humidity.v, "%")}</b></div>` : "",
    temp ? `<div class="tip-row"><span><i class="tip-dot temp"></i>温度</span><b>${formatValue(temp.v, "℃", 1)}</b></div>` : "",
    temp && humidity ? `<div class="tip-row"><span>VPD</span><b>${formatValue(calculateVpd(temp.v, humidity.v), " kPa", 2)}</b></div>` : "",
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
      setTimeout(loadHistory, 1500);
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
    document.querySelectorAll(".range-btn").forEach(x=>x.classList.toggle("active",x===btn));
    renderTrend();
  });
});

window.addEventListener("resize",()=>{
  hideTrendTooltip();
});

async function refreshAll(){
  await loadHealth();
  await Promise.all([loadStatus(), loadEvents()]);
  updateControls();
}

let statusTimer = null;
let eventsTimer = null;

function stopPolling(){
  if(statusTimer) clearInterval(statusTimer);
  if(eventsTimer) clearInterval(eventsTimer);
  statusTimer = null;
  eventsTimer = null;
}

function startPolling(){
  stopPolling();
  if(document.hidden) return;
  statusTimer = setInterval(loadStatus, 15000);
  eventsTimer = setInterval(loadEvents, 300000);
}

document.addEventListener("visibilitychange", async ()=>{
  if(document.hidden){
    stopPolling();
    return;
  }
  await refreshAll();
  startPolling();
});

await Promise.all([refreshAll(), loadHistory()]);
startPolling();
