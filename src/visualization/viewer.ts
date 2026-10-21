import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";

import type { ProjectAnalysis } from "../analyzer/analyzeProject.js";

export interface VisualizationServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly openBrowser?: boolean;
  readonly openSource?: (uri: string) => void | Promise<void>;
}

export interface VisualizationServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

export function createVisualizationDocument(
  analysis: ProjectAnalysis,
  openMode: "ide" | "server" = "ide",
): string {
  const payload = JSON.stringify({
    rootDirectory: analysis.rootDirectory,
    nodes: analysis.graph.getNodes(),
    edges: analysis.graph.getEdges(),
    openMode,
  }).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codegraph</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; overflow: hidden; background: #0d0e17; color: #f5f6fb; }
    canvas { display: block; width: 100vw; height: 100vh; cursor: grab; }
    canvas.dragging { cursor: grabbing; }
    .panel { position: fixed; z-index: 2; background: rgba(18,20,32,.92); border: 1px solid #30344b; border-radius: 12px; box-shadow: 0 16px 48px #0008; backdrop-filter: blur(12px); }
    #controls { top: 16px; left: 16px; width: min(340px, calc(100vw - 32px)); padding: 16px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .subtitle, .hint { color: #9da4bd; font-size: 12px; }
    input[type=search] { width: 100%; margin: 14px 0 10px; padding: 10px 12px; color: inherit; background: #0d0e17; border: 1px solid #3b405b; border-radius: 8px; outline: none; }
    input[type=search]:focus { border-color: #74b9ff; }
    .ask-row { display: flex; gap: 7px; margin: 12px 0 8px; }
    #question { flex: 1; min-width: 0; padding: 9px 10px; color: inherit; background: #0d0e17; border: 1px solid #3b405b; border-radius: 8px; outline: none; }
    #question:focus { border-color: #74b9ff; }
    #ask { margin: 0; }
    #answer { display: none; margin: 0 0 12px; padding: 9px 10px; border-radius: 8px; background: #191c2c; color: #cbd0e2; font-size: 12px; line-height: 1.4; max-height: 130px; overflow: auto; }
    #answer.visible { display: block; }
    #answer button { display: block; width: 100%; margin: 4px 0 0; padding: 4px 6px; text-align: left; border: 0; background: transparent; color: #7fc8ff; }
    #answer .result { display: flex; align-items: center; gap: 6px; }
    #answer .result button { flex: 1; width: auto; }
    a.source-link { color: #7fc8ff; text-decoration: none; }
    a.source-link:hover { text-decoration: underline; }
    #answer a.source-link { flex: none; font-size: 11px; white-space: nowrap; }
    .filters { display: flex; flex-wrap: wrap; gap: 10px 14px; font-size: 12px; }
    label { display: flex; align-items: center; gap: 6px; }
    .swatch { width: 9px; height: 9px; border-radius: 50%; }
    button { margin-top: 12px; padding: 7px 10px; border: 1px solid #3b405b; border-radius: 7px; background: #252941; color: inherit; cursor: pointer; }
    button:hover { background: #303651; }
    #details { right: 16px; top: 16px; width: min(360px, calc(100vw - 32px)); padding: 16px; display: none; }
    #details.visible { display: block; }
    #details h2 { margin: 0 24px 8px 0; font-size: 16px; overflow-wrap: anywhere; }
    #details dl { margin: 0; display: grid; grid-template-columns: 92px 1fr; gap: 6px 10px; font-size: 12px; }
    #details dt { color: #9da4bd; }
    #details dd { margin: 0; overflow-wrap: anywhere; }
    #close { position: absolute; right: 10px; top: 4px; border: 0; background: none; font-size: 20px; }
    #status { position: fixed; left: 16px; bottom: 14px; color: #a9aec2; font-size: 11px; pointer-events: none; }
    @media (max-width: 720px) { #details { top: auto; bottom: 40px; } }
  </style>
</head>
<body>
  <canvas id="graph" aria-label="Interactive code graph"></canvas>
  <section id="controls" class="panel">
    <h1>Codegraph</h1>
    <div id="summary" class="subtitle"></div>
    <div class="ask-row"><input id="question" placeholder="Ask: What calls analyzeProject?"><button id="ask">Ask</button></div>
    <div id="answer" aria-live="polite"></div>
    <input id="search" type="search" placeholder="Search files and symbols…" autocomplete="off">
    <div class="filters">
      <label><input type="checkbox" data-edge="DEFINES" checked><span class="swatch" style="background:#73809f"></span>Defines</label>
      <label><input type="checkbox" data-edge="IMPORTS" checked><span class="swatch" style="background:#f6bd60"></span>Imports</label>
      <label><input type="checkbox" data-edge="CALLS" checked><span class="swatch" style="background:#f28482"></span>Calls</label>
    </div>
    <button id="fit">Fit graph</button> <button id="reset">Show all</button>
    <div class="hint" style="margin-top:10px">Hover a node to reveal its label · scroll to zoom · drag to pan · click to focus</div>
  </section>
  <aside id="details" class="panel"><button id="close" aria-label="Close">×</button><div id="detail-content"></div></aside>
  <div id="status"></div>
  <script id="codegraph-data" type="application/json">${payload}</script>
  <script>
  (() => {
    const data = JSON.parse(document.getElementById('codegraph-data').textContent);
    const canvas = document.getElementById('graph');
    const context = canvas.getContext('2d');
    const nodes = data.nodes.map((entry, index) => ({
      ...entry, index, x: Math.cos(index * 2.39996) * Math.sqrt(index + 1) * 12,
      y: Math.sin(index * 2.39996) * Math.sqrt(index + 1) * 12, vx: 0, vy: 0, degree: 0
    }));
    const byId = new Map(nodes.map(node => [node.id, node]));
    const edges = data.edges.map(edge => ({ ...edge, source: byId.get(edge.from), target: byId.get(edge.to) })).filter(edge => edge.source && edge.target);
    edges.forEach(edge => { edge.source.degree++; edge.target.degree++; });
    const edgeColors = { DEFINES: '#73809f', IMPORTS: '#f6bd60', CALLS: '#f28482' };
    const kindColors = { file: '#4cc9f0', function: '#ff6b6b', class: '#ffd166', interface: '#70e000', method: '#c77dff' };
    const enabledEdges = new Set(Object.keys(edgeColors));
    let width = 0, height = 0, scale = 1, offsetX = 0, offsetY = 0;
    let dragging = false, moved = false, lastX = 0, lastY = 0, selected = null, hovered = null;
    let visibleNodes = new Set(nodes), simulationTicks = 0;

    const label = node => node.data.nodeType === 'file' ? node.data.filePath : node.data.qualifiedName;
    const file = node => node.data.nodeType === 'file' ? node.data.filePath : node.data.location.file;
    const color = node => kindColors[node.data.nodeType === 'file' ? 'file' : node.data.declarationKind] || '#8ecae6';
    const radius = node => Math.min(11, 3.3 + Math.sqrt(node.degree) * 1.15);
    const activeEdges = () => edges.filter(edge => enabledEdges.has(edge.type) && visibleNodes.has(edge.source) && visibleNodes.has(edge.target));
    const displayLabel = node => node.data.nodeType === 'file' ? node.data.filePath.split('/').pop() : node.data.name;
    const showLabel = node => node === hovered;

    function resize() {
      const ratio = window.devicePixelRatio || 1;
      width = window.innerWidth; height = window.innerHeight;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function simulate() {
      if (simulationTicks++ > 500) return;
      const active = [...visibleNodes];
      const cellSize = 80; const cells = new Map();
      active.forEach(node => { const key=Math.floor(node.x/cellSize)+','+Math.floor(node.y/cellSize); const bucket=cells.get(key)||[]; bucket.push(node); cells.set(key,bucket); });
      active.forEach(a => {
        const cellX=Math.floor(a.x/cellSize), cellY=Math.floor(a.y/cellSize);
        for (let x=cellX-1; x<=cellX+1; x++) for (let y=cellY-1; y<=cellY+1; y++) for (const b of cells.get(x+','+y)||[]) {
          if (b.index <= a.index) continue;
          const dx = b.x - a.x; const dy = b.y - a.y;
          const distance2 = Math.max(100, dx * dx + dy * dy); const force = Math.min(1.2, 900 / distance2);
          a.vx -= dx * force / Math.sqrt(distance2); a.vy -= dy * force / Math.sqrt(distance2);
          b.vx += dx * force / Math.sqrt(distance2); b.vy += dy * force / Math.sqrt(distance2);
        }
      });
      activeEdges().forEach(edge => {
        const dx = edge.target.x - edge.source.x; const dy = edge.target.y - edge.source.y;
        const distance = Math.max(1, Math.hypot(dx, dy)); const target = edge.type === 'DEFINES' ? 45 : 90;
        const force = Math.max(-2, Math.min(2, (distance - target) * .008));
        const forceX = dx / distance * force, forceY = dy / distance * force;
        edge.source.vx += forceX; edge.source.vy += forceY;
        edge.target.vx -= forceX; edge.target.vy -= forceY;
      });
      active.forEach(node => { node.vx -= node.x * .00035; node.vy -= node.y * .00035; node.vx *= .84; node.vy *= .84; node.x += node.vx; node.y += node.vy; });
    }

    function draw() {
      simulate(); context.clearRect(0, 0, width, height); context.save();
      context.translate(width / 2 + offsetX, height / 2 + offsetY); context.scale(scale, scale);
      activeEdges().forEach(edge => {
        context.beginPath(); context.moveTo(edge.source.x, edge.source.y); context.lineTo(edge.target.x, edge.target.y);
        const edgeColor=edgeColors[edge.type] + (selected && edge.source !== selected && edge.target !== selected ? '35' : '78');
        context.strokeStyle = edgeColor; context.lineWidth = 1 / Math.sqrt(scale); context.stroke();
        const angle=Math.atan2(edge.target.y-edge.source.y,edge.target.x-edge.source.x); const tip=radius(edge.target)+2/scale;
        const tx=edge.target.x-Math.cos(angle)*tip, ty=edge.target.y-Math.sin(angle)*tip, arrow=3.5/Math.sqrt(scale);
        context.beginPath(); context.moveTo(tx,ty); context.lineTo(tx-Math.cos(angle-.55)*arrow,ty-Math.sin(angle-.55)*arrow); context.lineTo(tx-Math.cos(angle+.55)*arrow,ty-Math.sin(angle+.55)*arrow); context.closePath(); context.fillStyle=edgeColor; context.fill();
      });
      visibleNodes.forEach(node => {
        const r = radius(node); context.beginPath(); context.arc(node.x, node.y, r, 0, Math.PI * 2);
        context.fillStyle = color(node); context.globalAlpha = selected && node !== selected && !isNeighbor(selected, node) ? .3 : 1; context.fill();
        if (node === selected || node === hovered) { context.strokeStyle = '#fff'; context.lineWidth = 2 / scale; context.stroke(); }
      });
      visibleNodes.forEach(node => {
        if(!showLabel(node))return;
        const text=displayLabel(node), fontSize=12/scale, padding=3/scale, x=node.x+radius(node)+5/scale, y=node.y;
        context.font='600 '+fontSize+'px ui-sans-serif, system-ui, sans-serif'; context.textBaseline='middle';
        const textWidth=context.measureText(text).width;
        context.globalAlpha=1; context.fillStyle='#10121ddd';
        context.fillRect(x-padding,y-fontSize*.72,textWidth+padding*2,fontSize*1.44);
        context.fillStyle='#f5f6fb'; context.fillText(text,x,y);
      });
      context.globalAlpha = 1; context.restore();
      requestAnimationFrame(draw);
    }

    function isNeighbor(a, b) { return edges.some(edge => enabledEdges.has(edge.type) && ((edge.source === a && edge.target === b) || (edge.source === b && edge.target === a))); }
    function screenNode(event) {
      const x = (event.clientX - width / 2 - offsetX) / scale; const y = (event.clientY - height / 2 - offsetY) / scale;
      let result = null, best = 16 / scale;
      visibleNodes.forEach(node => { const distance = Math.hypot(node.x - x, node.y - y); if (distance < Math.max(radius(node), best)) { result = node; best = distance; } });
      return result;
    }
    function showDetails(node) {
      const incident = edges.filter(edge => edge.source === node || edge.target === node);
      const counts = incident.reduce((result, edge) => ({ ...result, [edge.type]: (result[edge.type] || 0) + 1 }), {});
      const location = node.data.nodeType === 'symbol' ? node.data.location.file + ':' + node.data.location.line + ':' + node.data.location.column : node.data.filePath;
      document.getElementById('detail-content').innerHTML = '<h2>' + escapeHtml(label(node)) + '</h2><dl>' +
        '<dt>Type</dt><dd>' + escapeHtml(node.data.nodeType === 'file' ? 'file' : node.data.declarationKind) + '</dd>' +
        '<dt>Location</dt><dd><a class="source-link" href="' + editorHref(node) + '">' + escapeHtml(location) + '</a></dd><dt>Connections</dt><dd>' + incident.length + '</dd>' +
        '<dt>Relationships</dt><dd>' + escapeHtml(Object.entries(counts).map(([key,value]) => key + ': ' + value).join(' · ') || 'None') + '</dd></dl>';
      document.getElementById('details').classList.add('visible');
    }
    function editorHref(node) {
      if(data.openMode==='server')return '/open?node='+encodeURIComponent(node.id);
      const relativePath=file(node), suffix=node.data.nodeType==='symbol'?':'+node.data.location.line+':'+node.data.location.column:'';
      const absolutePath=(data.rootDirectory.replace(/\\\/$/,'')+'/'+relativePath).split('/').map((part,index)=>index===0?'':encodeURIComponent(part)).join('/');
      return 'vscode://file'+absolutePath+suffix;
    }
    function focusNode(node, related) {
      selected=node; visibleNodes=new Set([node,...related]); showDetails(node); fit(); restart();
    }
    function normalizedWords(value) { return value.toLowerCase().replace(/[^a-z0-9_.$/\\-]+/g,' ').trim().split(/\\s+/).filter(word => word.length > 1); }
    function bestQuestionNode(question) {
      const ignored=new Set(['what','which','where','who','does','call','calls','called','uses','use','used','imports','import','imported','defines','define','defined','depends','dependents','dependencies','on','by','is','are','the','a','an','of','for','from','show','find','me']);
      const terms=normalizedWords(question).filter(word => !ignored.has(word));
      let best=null, bestScore=0;
      nodes.forEach(node => { const name=label(node).toLowerCase(), location=file(node).toLowerCase(); let score=0; terms.forEach(term => { if(name===term)score+=12; else if(name.endsWith('.'+term)||name.endsWith('/'+term))score+=8; else if(name.includes(term))score+=4; if(location.includes(term))score+=2; }); if(score>bestScore){best=node;bestScore=score;} });
      return best;
    }
    function askQuestion() {
      const question=document.getElementById('question').value.trim(), answer=document.getElementById('answer');
      if(!question){answer.textContent='Ask about a file or symbol, for example: “What calls analyzeProject?”';answer.classList.add('visible');return;}
      const node=bestQuestionNode(question);
      if(!node){answer.textContent='I could not match that question to an indexed file or symbol.';answer.classList.add('visible');return;}
      const lower=question.toLowerCase(); let direction='both', relationship=null;
      if(/what (does|do)|dependencies|depends on|calls from/.test(lower))direction='outgoing';
      if(/what calls|who calls|called by|dependents|what imports|imported by|where .*defined/.test(lower))direction='incoming';
      if(/import/.test(lower))relationship='IMPORTS'; else if(/call|use|depend/.test(lower))relationship='CALLS'; else if(/defin|contain/.test(lower))relationship='DEFINES';
      if(relationship) { enabledEdges.clear(); enabledEdges.add(relationship); document.querySelectorAll('[data-edge]').forEach(input => { input.checked=input.dataset.edge===relationship; }); }
      const matches=edges.filter(edge => (!relationship||edge.type===relationship) && ((direction!=='incoming'&&edge.source===node)||(direction!=='outgoing'&&edge.target===node)));
      const related=matches.map(edge => edge.source===node?edge.target:edge.source).filter((entry,index,array)=>array.indexOf(entry)===index);
      focusNode(node,related);
      const heading=(direction==='incoming'?'Incoming':direction==='outgoing'?'Outgoing':'Connected')+(relationship?' '+relationship.toLowerCase():' relationships');
      answer.innerHTML='<strong>'+escapeHtml(label(node))+'</strong><br>'+escapeHtml(heading)+': '+related.length+(related.length?related.slice(0,8).map(item=>'<div class="result"><button data-node="'+item.index+'">'+escapeHtml(label(item))+'</button><a class="source-link" href="'+editorHref(item)+'">Open file ↗</a></div>').join(''):'')+'<div class="result"><a class="source-link" href="'+editorHref(node)+'">Open matched source ↗</a></div>';
      answer.querySelectorAll('[data-node]').forEach(button=>button.addEventListener('click',()=>{const target=nodes[Number(button.dataset.node)];if(target)focusNode(target,nodes.filter(item=>isNeighbor(target,item)));}));
      answer.classList.add('visible');
    }
    function escapeHtml(value) { const element = document.createElement('span'); element.textContent = String(value); return element.innerHTML; }
    function fit() {
      const active = [...visibleNodes]; if (!active.length) return;
      const xs = active.map(node => node.x), ys = active.map(node => node.y);
      const graphWidth = Math.max(100, Math.max(...xs) - Math.min(...xs)); const graphHeight = Math.max(100, Math.max(...ys) - Math.min(...ys));
      scale = Math.max(.08, Math.min(2.5, Math.min((width - 80) / graphWidth, (height - 80) / graphHeight) * .82));
      offsetX = -((Math.min(...xs) + Math.max(...xs)) / 2) * scale; offsetY = -((Math.min(...ys) + Math.max(...ys)) / 2) * scale;
    }
    function updateStatus() { document.getElementById('status').textContent = visibleNodes.size + ' nodes · ' + activeEdges().length + ' relationships · local visualization'; }
    function restart() { simulationTicks = 0; updateStatus(); }

    canvas.addEventListener('mousedown', event => { dragging = true; moved = false; lastX = event.clientX; lastY = event.clientY; canvas.classList.add('dragging'); });
    window.addEventListener('mousemove', event => { hovered = screenNode(event); if (!dragging) return; const dx = event.clientX-lastX, dy=event.clientY-lastY; if (Math.abs(dx)+Math.abs(dy)>2) moved=true; offsetX+=dx; offsetY+=dy; lastX=event.clientX; lastY=event.clientY; });
    window.addEventListener('mouseup', event => { if (dragging && !moved) { selected = screenNode(event); if (selected) focusNode(selected,nodes.filter(node => isNeighbor(selected,node))); } dragging=false; canvas.classList.remove('dragging'); });
    canvas.addEventListener('wheel', event => { event.preventDefault(); const previous=scale; scale=Math.max(.05,Math.min(8,scale*Math.exp(-event.deltaY*.001))); offsetX=event.clientX-width/2-(event.clientX-width/2-offsetX)*scale/previous; offsetY=event.clientY-height/2-(event.clientY-height/2-offsetY)*scale/previous; }, {passive:false});
    document.querySelectorAll('[data-edge]').forEach(input => input.addEventListener('change', () => { input.checked ? enabledEdges.add(input.dataset.edge) : enabledEdges.delete(input.dataset.edge); restart(); }));
    document.getElementById('search').addEventListener('input', event => { const query=event.target.value.trim().toLowerCase(); if (!query) { visibleNodes=new Set(nodes); selected=null; } else { const matches=nodes.filter(node => label(node).toLowerCase().includes(query) || file(node).toLowerCase().includes(query)); visibleNodes=new Set(matches); selected=matches.length===1?matches[0]:null; } fit(); restart(); });
    document.getElementById('fit').addEventListener('click', fit);
    document.getElementById('ask').addEventListener('click', askQuestion);
    document.getElementById('question').addEventListener('keydown', event => { if(event.key==='Enter')askQuestion(); });
    document.addEventListener('click', async event => { const link=event.target.closest('a.source-link'); if(!link||!link.getAttribute('href').startsWith('/open?'))return; event.preventDefault(); const response=await fetch(link.href); document.getElementById('status').textContent=response.ok?'Opened source in IDE':'Could not open source: '+await response.text(); });
    document.getElementById('reset').addEventListener('click', () => { visibleNodes=new Set(nodes); selected=null; document.getElementById('search').value=''; document.getElementById('details').classList.remove('visible'); fit(); restart(); });
    document.getElementById('close').addEventListener('click', () => document.getElementById('details').classList.remove('visible'));
    document.getElementById('summary').textContent = data.rootDirectory + ' · ' + nodes.length + ' nodes · ' + edges.length + ' relationships';
    window.addEventListener('resize', () => { resize(); fit(); }); resize(); setTimeout(fit, 500); updateStatus(); draw();
  })();
  </script>
</body>
</html>`;
}

export async function writeVisualizationDocument(
  analysis: ProjectAnalysis,
  outputPath: string,
): Promise<string> {
  const absoluteOutputPath = path.resolve(outputPath);
  await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
  await writeFile(
    absoluteOutputPath,
    createVisualizationDocument(analysis),
    "utf8",
  );
  return absoluteOutputPath;
}

export async function startVisualizationServer(
  analysis: ProjectAnalysis,
  options: VisualizationServerOptions = {},
): Promise<VisualizationServer> {
  const host = options.host ?? "127.0.0.1";
  const document = createVisualizationDocument(analysis, "server");
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${host}`);
    if (requestUrl.pathname === "/open") {
      const nodeId = requestUrl.searchParams.get("node");
      const node = nodeId === null ? undefined : analysis.graph.getNode(nodeId);
      if (node === undefined) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Indexed node not found\n");
        return;
      }
      const relativePath = node.data.nodeType === "file"
        ? node.data.filePath
        : node.data.location.file;
      const absolutePath = path.resolve(analysis.rootDirectory, relativePath);
      const relativeToRoot = path.relative(analysis.rootDirectory, absolutePath);
      if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Indexed path is outside the project root\n");
        return;
      }
      const suffix = node.data.nodeType === "symbol"
        ? `:${node.data.location.line}:${node.data.location.column}`
        : "";
      const uri = `vscode://file${encodeEditorPath(absolutePath)}${suffix}`;
      try {
        await (options.openSource ?? openSourceUri)(uri);
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
      } catch (error: unknown) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(`Unable to open IDE: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      return;
    }
    if (requestUrl.pathname !== "/" && requestUrl.pathname !== "/index.html") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'",
    });
    response.end(document);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Unable to determine visualization server address");
  const url = `http://${host}:${address.port}/`;
  if (options.openBrowser !== false) openBrowser(url);
  return { server, url, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

function encodeEditorPath(filePath: string): string {
  return filePath.split(path.sep).map((part, index) =>
    index === 0 ? "" : encodeURIComponent(part)
  ).join("/");
}

async function openSourceUri(uri: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", uri] : [uri];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${String(code)}`)));
  });
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
