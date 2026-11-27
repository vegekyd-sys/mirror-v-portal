// Internal JSON pipe for Python compatibility. Caller captures stdout in memory;
// do not run this helper with stdout redirected to user logs/raw datasets.
import { client, runActor, loadCredential, BASE } from './apify-client.mjs';
import { writeFileSync } from 'node:fs';
let text=''; for await (const chunk of process.stdin) text+=chunk;
try {
 const req=JSON.parse(text);
 if(req.operation==='run') {
  const result=await runActor(req.actor,req.input,req.options);
  process.stdout.write(JSON.stringify(result));
 } else if(req.operation==='download') {
  const u=new URL(req.url);
  if(u.protocol!=='https:') throw Error('HTTPS media required');
  const headers={'User-Agent':'Mozilla/5.0'};
  if(u.hostname==='api.apify.com') {
   if(!u.pathname.startsWith('/v2/key-value-stores/')) throw Error('Unsupported Apify media path');
   u.searchParams.delete('token');
   headers.Authorization=`Bearer ${loadCredential(req.account).value}`;
  }
  const r=await fetch(u,{headers,signal:AbortSignal.timeout(90000)});
  if(!r.ok) throw Error(`Media download HTTP ${r.status}`);
  writeFileSync(req.destination,Buffer.from(await r.arrayBuffer()),{mode:0o600});
  process.stdout.write(JSON.stringify({status:'downloaded'}));
 } else throw Error('Unknown private pipe operation');
} catch(e) {process.stderr.write(e.message+'\n');process.exitCode=1;}
