// live-spike.ts — THROWAWAY spike for GPT-Live-1 (full-duplex voice).
//
// Isolated from Converse: GET /live-spike (page) + POST /api/live-spike/sdp (mint).
// Served straight from the server, NOT part of the React bundle. Safe to delete.
//
// Two modes (toggle on the page), so if one misbehaves you flip to the other:
//  - "assistant"  → delegation: responses (OpenAI gpt-5.6 brain). Reliable; no tools
//                   of ours. This is v0, the full-duplex feel test.
//  - "tools"      → delegation: client. GPT-Live is voice-only; OUR brain runs via the
//                   existing /api/voice/rt/chat loop (all 10 vault tools, runVaultTool),
//                   and we speak the result back with session.commentary.append.
//
// The real production engine (gpt-realtime Converse) is untouched and remains the
// ultimate fallback in the app; a proper in-app engine setting is the provider-adapter
// step, to be done once this proves out.
//
// Event wire details (delegation.created / input-transcript / commentary.append) come
// partly from Microsoft's Foundry GPT-Live reference (secondary). The page logs full
// JSON for delegation/transcript/error events, so the first real phone run reveals the
// true shapes — if a name is off, the log shows it and it's a one-line fix.

function json(obj: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}
function err(status: number, message: string): Response {
  return json({ error: message }, { status });
}

const LIVE_URL = "https://api.openai.com/v1/live/sessions";

/** POST /api/live-spike/sdp — take the browser's SDP offer + mode, mint a GPT-Live
 *  session server-side (key stays here), return the answer SDP. */
export async function handleLiveSpikeSdp(req: Request): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return err(503, "OPENAI_API_KEY not set on the server");

  let body: { sdp?: string; mode?: string } | null = null;
  try {
    body = (await req.json()) as { sdp?: string; mode?: string };
  } catch {
    return err(400, "bad json body");
  }
  const offer = body?.sdp;
  if (!offer || typeof offer !== "string") return err(400, "missing sdp offer");
  const mode = body?.mode === "tools" ? "tools" : "assistant";

  const delegation =
    mode === "tools"
      ? { type: "client" }
      : {
          type: "responses",
          responses: {
            model: "gpt-5.6",
            instructions: "Answer briefly and naturally. Don't narrate what you're doing.",
          },
        };

  const session = {
    model: "gpt-live-1",
    instructions:
      "You are a warm, brief voice assistant in a test call. Keep spoken replies to one or two sentences and sound natural. Speak results concisely.",
    delegation,
  };

  let res: Response;
  try {
    res = await fetch(LIVE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session, transport: { type: "webrtc", sdp: offer } }),
    });
  } catch (e) {
    return err(502, `live request failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    console.error("[live-spike] mint failed", mode, res.status, text.slice(0, 500));
    return err(res.status, `live ${res.status}: ${text.slice(0, 400)}`);
  }

  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = null;
  }
  const transport = (data?.transport ?? null) as { sdp?: string } | null;
  const answer =
    transport?.sdp ??
    (typeof data?.sdp === "string" ? (data.sdp as string) : null) ??
    (text.startsWith("v=") ? text : null);

  if (!answer) {
    console.error("[live-spike] no answer sdp; keys:", data ? Object.keys(data) : "(non-json)", text.slice(0, 400));
    return err(502, `no answer sdp in response: ${text.slice(0, 300)}`);
  }

  const sess = (data?.session ?? null) as { id?: string } | null;
  return json({ sdp: answer, session_id: sess?.id ?? (data?.id as string) ?? null, mode });
}

const PAGE = [
  "<!doctype html><html><head>",
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  "<title>GPT-Live spike</title>",
  "<style>",
  "body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#0b0b0c;color:#eaeaea}",
  "h1{font-size:18px;font-weight:600;margin:0 0 4px}",
  "p.sub{color:#9a9a9a;margin:0 0 16px;font-size:14px}",
  ".modes{display:flex;gap:8px;margin-bottom:16px}",
  ".modes button{flex:1;font-size:14px;padding:10px;border:1px solid #2a2a2c;border-radius:10px;background:#161617;color:#c7c7c7}",
  ".modes button.on{background:#4f46e5;color:#fff;border-color:#4f46e5}",
  "button#connect{font-size:17px;padding:14px 22px;border:0;border-radius:12px;background:#22c55e;color:#06240f;font-weight:600;width:100%;margin-bottom:8px}",
  "button#stop{font-size:15px;padding:12px;border:1px solid #3a3a3c;border-radius:12px;background:transparent;color:#eaeaea;width:100%;margin-bottom:16px}",
  "button:active{transform:scale(.98)}button:disabled{opacity:.5}",
  "#status{font-size:15px;margin-bottom:14px;color:#c7c7c7}",
  "pre#log{background:#161617;border-radius:12px;padding:12px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;height:42vh;overflow:auto;margin:0}",
  "</style></head><body>",
  "<h1>GPT-Live-1 spike</h1>",
  '<p class="sub">Full-duplex voice. Pick a mode, tap Connect, allow the mic, then talk.</p>',
  '<div class="modes">',
  '<button id="m-tools" class="on">Our tools</button>',
  '<button id="m-assistant">Assistant (OpenAI brain)</button>',
  "</div>",
  '<button id="connect">Connect &amp; talk</button>',
  '<button id="stop" disabled>Stop</button>',
  '<div id="status">Idle.</div>',
  '<audio id="audio" autoplay playsinline></audio>',
  '<pre id="log"></pre>',
  "<script>",
  "var logEl=document.getElementById('log');",
  "function log(m){try{console.log(m);}catch(e){} logEl.textContent+=m+'\\n'; logEl.scrollTop=logEl.scrollHeight;}",
  "var mode='tools';",
  "function setMode(m){mode=m; document.getElementById('m-tools').className=(m==='tools'?'on':''); document.getElementById('m-assistant').className=(m==='assistant'?'on':'');}",
  "document.getElementById('m-tools').addEventListener('click',function(){setMode('tools');});",
  "document.getElementById('m-assistant').addEventListener('click',function(){setMode('assistant');});",
  "var pc, dc, mic;",
  "var history=[];",   // {role,content} turns for our brain
  "var utter='';",      // accumulating user transcript for the current turn
  "var delegationId=null;",
  "var evN=0;",
  "function send(obj){ try{ dc.send(JSON.stringify(obj)); }catch(e){ log('send err: '+e); } }",
  "async function runBrain(){",
  "  var u=utter.trim(); utter='';",
  "  if(!u){ log('(delegation with empty transcript; skipping)'); return; }",
  "  log('you: '+u);",
  "  history.push({role:'user',content:u});",
  "  try{",
  "    var r=await fetch('/api/voice/rt/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:history})});",
  "    if(!r.ok){ var t=await r.text(); log('brain error '+r.status+': '+t.slice(0,200)); send({type:'session.commentary.append',event_id:'e'+(++evN),delegation_id:delegationId,content:'Sorry, something went wrong.'}); return; }",
  "    var d=await r.json();",
  "    var reply=(d.text||'').trim()||'Done.';",
  "    if(d.toolCalls&&d.toolCalls.length){ log('tools: '+d.toolCalls.map(function(c){return c.name;}).join(', ')); }",
  "    log('reply: '+reply);",
  "    history.push({role:'assistant',content:reply});",
  "    send({type:'session.commentary.append',event_id:'e'+(++evN),delegation_id:delegationId,content:reply});",
  "  }catch(e){ log('brain exception: '+e); }",
  "}",
  "function onEvent(ev){",
  "  var t=ev.type||'';",
  "  // accumulate the user's words",
  "  if(/input.*transcript/.test(t)){ var d=ev.delta||ev.text||(ev.transcript&&ev.transcript.text)||''; if(d){utter+=d;} log('evt: '+t); return; }",
  "  // a unit of work to do",
  "  if(/delegation.*created/.test(t)){ delegationId=(ev.delegation&&ev.delegation.id)||ev.delegation_id||ev.id||null; log('DELEGATION: '+JSON.stringify(ev).slice(0,300)); if(mode==='tools'){ runBrain(); } return; }",
  "  if(/error/.test(t)){ log('ERR evt: '+JSON.stringify(ev).slice(0,400)); return; }",
  "  if(/commentary|thinking|delegation|response|session\\./.test(t)){ log('evt: '+t); return; }",
  "  log('evt: '+t);",
  "}",
  "async function connect(){",
  "  var btn=document.getElementById('connect'); btn.disabled=true; document.getElementById('m-tools').disabled=true; document.getElementById('m-assistant').disabled=true;",
  "  document.getElementById('status').textContent='Connecting ('+mode+')...';",
  "  history=[]; utter=''; delegationId=null;",
  "  try{",
  "    log('mode: '+mode+' | requesting mic...');",
  "    mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});",
  "    pc=new RTCPeerConnection();",
  "    pc.oniceconnectionstatechange=function(){log('ice: '+pc.iceConnectionState);};",
  "    pc.onconnectionstatechange=function(){log('conn: '+pc.connectionState); if(pc.connectionState==='connected'){document.getElementById('status').textContent='Connected ('+mode+') \\u2014 talk!';}};",
  "    pc.ontrack=function(e){log('remote audio track'); var a=document.getElementById('audio'); a.srcObject=e.streams[0]; var p=a.play(); if(p&&p.catch){p.catch(function(err){log('tap to allow audio'); document.body.addEventListener('click',function(){a.play();},{once:true});});}};",
  "    mic.getTracks().forEach(function(x){pc.addTrack(x,mic);});",
  "    dc=pc.createDataChannel('oai-events');",
  "    dc.onopen=function(){log('data channel open');};",
  "    dc.onmessage=function(e){ try{ onEvent(JSON.parse(e.data)); }catch(_){ log('evt(raw): '+String(e.data).slice(0,120)); } };",
  "    var offer=await pc.createOffer(); await pc.setLocalDescription(offer);",
  "    log('minting session...');",
  "    var res=await fetch('/api/live-spike/sdp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sdp:offer.sdp,mode:mode})});",
  "    if(!res.ok){log('mint failed '+res.status+': '+(await res.text())); reset(); document.getElementById('status').textContent='Mint failed.'; return;}",
  "    var data=await res.json();",
  "    if(!data.sdp){log('no answer sdp: '+JSON.stringify(data).slice(0,300)); reset(); return;}",
  "    log('got answer, connecting media...');",
  "    await pc.setRemoteDescription({type:'answer',sdp:data.sdp});",
  "    log('negotiated \\u2014 start talking.');",
  "    document.getElementById('stop').disabled=false;",
  "  }catch(err){log('error: '+(err&&err.message?err.message:err)); document.getElementById('status').textContent='Error.'; reset();}",
  "}",
  "function reset(){ try{if(pc)pc.close();}catch(e){} try{if(mic)mic.getTracks().forEach(function(t){t.stop();});}catch(e){} document.getElementById('connect').disabled=false; document.getElementById('stop').disabled=true; document.getElementById('m-tools').disabled=false; document.getElementById('m-assistant').disabled=false; }",
  "function stop(){ log('stopped.'); document.getElementById('status').textContent='Stopped.'; reset(); }",
  "document.getElementById('connect').addEventListener('click',connect);",
  "document.getElementById('stop').addEventListener('click',stop);",
  "</script></body></html>",
].join("\n");

/** GET /live-spike — the standalone test page. */
export function handleLiveSpikePage(): Response {
  return new Response(PAGE, {
    headers: { "Content-Type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
