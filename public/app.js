const $ = (id) => document.getElementById(id);

const ui = {
  cloudDot: $("cloudDot"), cloudText: $("cloudText"), moisture: $("moisture"), heroHint: $("heroHint"),
  device: $("device"), state: $("state"), daily: $("daily"), auto: $("auto"),
  controlHint: $("controlHint"), message: $("message"), meta: $("meta"),
  waterBtn: $("waterBtn"), stopBtn: $("stopBtn"), autoBtn: $("autoBtn"), statusBtn: $("statusBtn"), resetBtn: $("resetBtn"), refreshBtn: $("refreshBtn"),
  eventList: $("eventList"), eventCount: $("eventCount"),
  trendSvg: $("trendSvg"), trendEmpty: $("trendEmpty"), trendMeta: $("trendMeta"), trendRefreshBtn: $("trendRefreshBtn"),
};

let health = null;
let status = null;
let history = { soil: [], weather: [], watering: [] };
let busy = false;
let trendHours = 168;

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
    ui.device.textContent = "异常";
    ui.heroHint.textContent = "状态读取失败";
    setMessage(`状态读取失败：${error.message}`, "err");
  }
}

function renderStatus(result){
  const d = result.data;
  if(!d){
    ui.moisture.textContent = "--%";
    ui.device.textContent = "无数据";
    ui.state.textContent = "--";
    ui.daily.textContent = "--/3";
    ui.auto.textContent = "--";
    ui.heroHint.textContent = "等待设备数据进入 Worker";
    updateControls();
    return;
  }

  ui.moisture.textContent = d.sensorValid ? `${d.moisture}%` : "--%";
  ui.device.textContent = d.online ? "在线" : "离线";
  ui.state.textContent = stateText(d.state);
  ui.daily.textContent = `${d.daily ?? "--"}/${d.maxDaily ?? 3}`;
  ui.auto.textContent = d.auto ? "开启" : "关闭";
  ui.heroHint.textContent = result.stale ? "当前为历史/过期状态，等待实时 Webhook" : (d.state === "pumping" ? "妞妞正在认真浇水 💧" : "设备状态已同步到 Worker");

  const items = [];
  if(d.raw !== undefined && d.raw !== null) items.push(`RAW ${d.raw}`);
  if(result.ageSeconds !== undefined) items.push(`数据 ${result.ageSeconds}s 前`);
  if(result.source) items.push(result.source);
  ui.meta.textContent = items.join(" ｜ ");
  ui.resetBtn.classList.toggle("hidden", !d.test);
  ui.autoBtn.textContent = d.auto ? "关闭自动" : "开启自动";
  updateControls();
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
  ui.resetBtn.disabled = !permitted || !deviceUsable;
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
  const source = e.source === "AUTO" ? "自动浇水" : e.source === "MANUAL_WEB" ? "手动浇水" : (e.source || "浇水");
  const seconds = e.actual_seconds ?? e.planned_seconds;
  const when = e.started_at || e.updated_at;
  const phase = e.last_phase || "--";
  const moisture = e.before_moisture != null && e.after_moisture != null ? `湿度 ${e.before_moisture}% → ${e.after_moisture}%` : "湿度数据待补全";
  return `<div class="event"><div class="event-main"><div class="event-title">💧 ${escapeHtml(source)}</div><div class="event-sub">${escapeHtml(timeText(when))}${seconds != null ? ` ｜ ${seconds}s` : ""}<br>${escapeHtml(moisture)}</div></div><div class="event-status">${escapeHtml(phase)}</div></div>`;
}

async function loadHistory(){
  ui.trendEmpty.textContent = "正在读取历史数据…";
  ui.trendEmpty.classList.remove("hidden");
  ui.trendRefreshBtn.disabled = true;
  try{
    const result = await api("/api/history?days=7&soilLimit=10500&weatherLimit=2000&wateringLimit=100");
    history = {
      soil: Array.isArray(result.soil) ? result.soil : [],
      weather: Array.isArray(result.weather) ? result.weather : [],
      watering: Array.isArray(result.watering) ? result.watering : [],
    };
    renderTrend();
  }catch(error){
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
  const soil = history.soil
    .map(r => ({t:toMillis(r.ts), v:Number(r.moisture), valid:Boolean(r.sensor_valid)}))
    .filter(r => r.t >= since && r.t <= now && Number.isFinite(r.v) && r.valid);
  const humidity = history.weather
    .map(r => ({t:toMillis(r.ts), v:Number(r.humidity_pct)}))
    .filter(r => r.t >= since && r.t <= now && Number.isFinite(r.v));
  const temp = history.weather
    .map(r => ({t:toMillis(r.ts), v:Number(r.temperature_c)}))
    .filter(r => r.t >= since && r.t <= now && Number.isFinite(r.v));
  const watering = history.watering
    .map(r => ({...r, t:toMillis(r.started_at || r.updated_at)}))
    .filter(r => r.t >= since && r.t <= now);

  clearSvg(ui.trendSvg);

  if(!soil.length && !humidity.length && !temp.length){
    ui.trendEmpty.textContent = "当前时间范围内暂无可绘制的历史数据";
    ui.trendEmpty.classList.remove("hidden");
    ui.trendMeta.textContent = `已读取：土壤 ${history.soil.length} 条，天气 ${history.weather.length} 条，浇水 ${history.watering.length} 条。`;
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

  watering.slice(-30).forEach(e=>{
    const xx = x(e.t);
    const cls = e.source === "AUTO" ? "watering-marker auto" : "watering-marker manual";
    const line = appendSvg("line",{x1:xx,y1:m.t,x2:xx,y2:H-m.b,class:cls});
    const title = document.createElementNS("http://www.w3.org/2000/svg","title");
    title.textContent = `${e.source === "AUTO" ? "自动浇水" : "手动浇水"} · ${timeText(e.t/1000)}`;
    line.appendChild(title);
    appendSvg("circle",{cx:xx,cy:m.t+4,r:3.2,class:cls});
  });

  drawSeries(downsample(soil, 480), x, yPct, "series soil");
  drawSeries(downsample(humidity, 480), x, yPct, "series humidity");
  drawSeries(downsample(temp, 480), x, yTemp, "series temp");

  const shown = [];
  if(soil.length) shown.push(`土壤 ${soil.length}`);
  if(humidity.length || temp.length) shown.push(`天气 ${Math.max(humidity.length,temp.length)}`);
  if(watering.length) shown.push(`浇水 ${watering.length}`);
  ui.trendMeta.textContent = `${trendHours===168?"7天":trendHours===72?"3天":"24小时"}窗口 ｜ ${shown.join(" · ") || "暂无数据"} ｜ 图表仅手动刷新历史数据`;
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
ui.resetBtn.addEventListener("click",()=>{ if(confirm("TEST 模式：确认清零今日次数？")) sendCommand("test_reset"); });
ui.refreshBtn.addEventListener("click",refreshAll);
ui.trendRefreshBtn.addEventListener("click",loadHistory);

document.querySelectorAll(".range-btn").forEach(btn=>{
  btn.addEventListener("click",()=>{
    trendHours = Number(btn.dataset.hours || 168);
    document.querySelectorAll(".range-btn").forEach(x=>x.classList.toggle("active",x===btn));
    renderTrend();
  });
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
