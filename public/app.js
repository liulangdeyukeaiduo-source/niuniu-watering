const $ = (id) => document.getElementById(id);

const ui = {
  cloudDot: $("cloudDot"), cloudText: $("cloudText"), moisture: $("moisture"), heroHint: $("heroHint"),
  device: $("device"), state: $("state"), daily: $("daily"), auto: $("auto"),
  controlHint: $("controlHint"), message: $("message"), meta: $("meta"),
  waterBtn: $("waterBtn"), stopBtn: $("stopBtn"), autoBtn: $("autoBtn"), statusBtn: $("statusBtn"), resetBtn: $("resetBtn"), refreshBtn: $("refreshBtn"),
  eventList: $("eventList"), eventCount: $("eventCount"),
};

let health = null;
let status = null;
let busy = false;

function stateText(value){
  const map = {monitoring:"监测",pumping:"浇水",soaking:"渗透",locked:"闭锁",sensor_fault:"传感器故障",pump_fault:"水泵故障"};
  return map[value] || value || "--";
}

function timeText(ts){
  if(!ts) return "--";
  return new Date(Number(ts) * 1000).toLocaleString("zh-CN", {hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
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
  // Status still feels near-real-time while cutting D1 reads by ~3x.
  statusTimer = setInterval(loadStatus, 15000);
  // Watering events change infrequently; commands trigger an immediate refresh.
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

await refreshAll();
startPolling();
