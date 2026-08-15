import { writeFile } from "node:fs/promises";
import { summarizeTrajectory } from "./projector.ts";
import type { TrajectoryEvent, TrajectoryHeader } from "./types.ts";

export async function exportHtml(path: string, header: TrajectoryHeader, events: TrajectoryEvent[], outputPath: string): Promise<void> {
  const summary = summarizeTrajectory(header, events, path);
  const payload = escapeScriptJson(JSON.stringify({ header, summary, events }));
  await writeFile(outputPath, htmlDocument(payload), { mode: 0o600 });
}

function escapeScriptJson(value: string): string {
  return value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function htmlDocument(payload: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi Agent Trajectory</title><style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#121a2f;--line:#263451;--text:#e8edf7;--muted:#9aa8c2;--accent:#77d4b4}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.wrap{max-width:1440px;margin:auto;padding:28px}h1{font:700 25px/1.2 system-ui;margin:0 0 8px}.muted{color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin:22px 0}.stat,.event{background:var(--panel);border:1px solid var(--line);border-radius:10px}.stat{padding:13px}.stat b{display:block;font-size:19px;color:var(--accent)}input{width:100%;background:#0d1426;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:11px;margin-bottom:14px}.event{margin:8px 0;overflow:hidden}.head{display:flex;gap:14px;padding:10px 12px;cursor:pointer}.seq{color:var(--muted)}.type{color:var(--accent);font-weight:700}.time{margin-left:auto;color:var(--muted)}pre{display:none;margin:0;padding:13px;border-top:1px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere;background:#0d1426}.event.open pre{display:block}</style></head>
<body><main class="wrap"><h1>Pi Agent Trajectory</h1><div id="meta" class="muted"></div><section id="stats" class="stats"></section><input id="filter" placeholder="Filter by event type or JSON content"><section id="events"></section></main>
<script>const data=${payload};const esc=s=>String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
document.querySelector('#meta').textContent=data.summary.sessionId+' · '+data.summary.path;
const keys=['eventCount','runs','steps','userMessages','assistantMessages','toolCalls','toolErrors','interrupted','inputTokens','outputTokens'];
document.querySelector('#stats').innerHTML=keys.map(k=>'<div class="stat"><span>'+esc(k)+'</span><b>'+esc(data.summary[k])+'</b></div>').join('');
const root=document.querySelector('#events');function render(q=''){q=q.toLowerCase();root.innerHTML=data.events.filter(e=>!q||e.type.toLowerCase().includes(q)||JSON.stringify(e.data).toLowerCase().includes(q)).map(e=>'<article class="event"><div class="head"><span class="seq">#'+e.seq+'</span><span class="type">'+esc(e.type)+'</span><span class="time">'+esc(e.time)+'</span></div><pre>'+esc(JSON.stringify(e.data,null,2))+'</pre></article>').join('');root.querySelectorAll('.event').forEach(el=>el.querySelector('.head').onclick=()=>el.classList.toggle('open'))}render();document.querySelector('#filter').oninput=e=>render(e.target.value);
</script></body></html>`;
}
