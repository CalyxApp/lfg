// live-spike.ts — THROWAWAY spike for GPT-Live-1 (full-duplex voice).
//
// Goal: feel full-duplex on a phone before any production work. Isolated from
// Converse: two routes (GET /live-spike page, POST /api/live-spike/sdp mint),
// served straight from the server — NOT part of the React bundle, NOT wired to
// the real voice stack. Delete freely.
//
// v0 uses `delegation: responses` (an OpenAI backend brain, gpt-5.6) so there's a
// working talking agent with zero client-delegation code — this answers the only
// question that matters first: does full-duplex actually feel better on a phone?
// Client delegation + our own tools is the next increment.
//
// Flow (mirrors the proven Converse WebRTC path, pointed at /v1/live/sessions):
// browser makes an SDP offer -> POST here -> we POST it to OpenAI with the server
// key -> return the answer SDP -> browser plays the media. Access + mint shape
// were probed live 2026-10-09 (we have gpt-live-1 access; transport must be webrtc).

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

/** POST /api/live-spike/sdp — take the browser's SDP offer, mint a GPT-Live
 *  session server-side (key stays here), return the answer SDP. */
export async function handleLiveSpikeSdp(req: Request): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return err(503, "OPENAI_API_KEY not set on the server");

  let body: { sdp?: string } | null = null;
  try {
    body = (await req.json()) as { sdp?: string };
  } catch {
    return err(400, "bad json body");
  }
  const offer = body?.sdp;
  if (!offer || typeof offer !== "string") return err(400, "missing sdp offer");

  const session = {
    model: "gpt-live-1",
    instructions:
      "You are a warm, brief voice assistant in a quick test call. Keep spoken replies to one or two sentences and sound natural.",
    delegation: {
      type: "responses",
      responses: {
        model: "gpt-5.6",
        instructions: "Answer briefly and naturally. Don't narrate what you're doing.",
      },
    },
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
    console.error("[live-spike] mint failed", res.status, text.slice(0, 500));
    return err(res.status, `live ${res.status}: ${text.slice(0, 400)}`);
  }

  // The answer may come back as JSON ({ transport: { sdp }, session: { id } } or
  // { sdp }) or as a raw SDP body. Handle both; log the shape for debugging the
  // first real connect.
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
    console.error(
      "[live-spike] no answer sdp; keys:",
      data ? Object.keys(data) : "(non-json)",
      text.slice(0, 400),
    );
    return err(502, `no answer sdp in response: ${text.slice(0, 300)}`);
  }

  const sess = (data?.session ?? null) as { id?: string } | null;
  return json({ sdp: answer, session_id: sess?.id ?? (data?.id as string) ?? null });
}

const PAGE = [
  "<!doctype html><html><head>",
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  "<title>GPT-Live spike</title>",
  "<style>",
  "body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#0b0b0c;color:#eaeaea}",
  "h1{font-size:18px;font-weight:600;margin:0 0 4px}",
  "p.sub{color:#9a9a9a;margin:0 0 20px;font-size:14px}",
  "button{font-size:17px;padding:14px 22px;border:0;border-radius:12px;background:#4f46e5;color:#fff;width:100%;margin-bottom:16px}",
  "button:active{transform:scale(.98)}button:disabled{opacity:.5}",
  "#status{font-size:15px;margin-bottom:16px;color:#c7c7c7}",
  "pre#log{background:#161617;border-radius:12px;padding:12px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;height:45vh;overflow:auto;margin:0}",
  "</style></head><body>",
  "<h1>GPT-Live-1 spike</h1>",
  '<p class="sub">Full-duplex voice feel test. Tap Connect, allow the mic, then talk.</p>',
  '<button id="connect">Connect &amp; talk</button>',
  '<div id="status">Idle.</div>',
  '<audio id="audio" autoplay playsinline></audio>',
  '<pre id="log"></pre>',
  "<script>",
  "var logEl=document.getElementById('log');",
  "function log(m){try{console.log(m);}catch(e){} logEl.textContent+=m+'\\n'; logEl.scrollTop=logEl.scrollHeight;}",
  "var pc;",
  "async function connect(){",
  " var btn=document.getElementById('connect'); btn.disabled=true; document.getElementById('status').textContent='Connecting...';",
  " try{",
  "  log('requesting mic...');",
  "  var mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});",
  "  pc=new RTCPeerConnection();",
  "  pc.oniceconnectionstatechange=function(){log('ice: '+pc.iceConnectionState);};",
  "  pc.onconnectionstatechange=function(){log('conn: '+pc.connectionState); if(pc.connectionState==='connected'){document.getElementById('status').textContent='Connected \\u2014 talk!';}};",
  "  pc.ontrack=function(e){log('remote audio track'); var a=document.getElementById('audio'); a.srcObject=e.streams[0]; var p=a.play(); if(p&&p.catch){p.catch(function(err){log('tap anywhere to allow audio ('+err+')'); document.body.addEventListener('click',function(){a.play();},{once:true});});}};",
  "  mic.getTracks().forEach(function(t){pc.addTrack(t,mic);});",
  "  var dc=pc.createDataChannel('oai-events');",
  "  dc.onopen=function(){log('data channel open');};",
  "  dc.onmessage=function(e){try{var ev=JSON.parse(e.data); log('evt: '+(ev.type||'?'));}catch(_){log('evt(raw)');}};",
  "  var offer=await pc.createOffer(); await pc.setLocalDescription(offer);",
  "  log('minting session...');",
  "  var res=await fetch('/api/live-spike/sdp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sdp:offer.sdp})});",
  "  if(!res.ok){log('mint failed '+res.status+': '+(await res.text())); btn.disabled=false; document.getElementById('status').textContent='Mint failed.'; return;}",
  "  var data=await res.json();",
  "  if(!data.sdp){log('no answer sdp: '+JSON.stringify(data).slice(0,300)); btn.disabled=false; return;}",
  "  log('got answer, connecting media...');",
  "  await pc.setRemoteDescription({type:'answer',sdp:data.sdp});",
  "  log('negotiated \\u2014 start talking.');",
  " }catch(err){log('error: '+(err&&err.message?err.message:err)); document.getElementById('status').textContent='Error.'; btn.disabled=false;}",
  "}",
  "document.getElementById('connect').addEventListener('click',connect);",
  "</script></body></html>",
].join("\n");

/** GET /live-spike — the standalone test page. */
export function handleLiveSpikePage(): Response {
  return new Response(PAGE, {
    headers: { "Content-Type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
