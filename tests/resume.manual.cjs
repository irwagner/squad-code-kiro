'use strict';
// Verifies session resume end-to-end through the bridge: run 1 states a fact, run 2 resumes (--resume-id) and must recall it.
// Requires kiro-cli authenticated; consumes a small amount of credits. Run with: npm run test:resume
const os=require('node:os'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'sq-resume-'));const projDir=fs.mkdtempSync(path.join(os.tmpdir(),'sq-resume-proj-'));
process.env.SQUAD_DATA_DIR=dataDir;process.env.SQUAD_PROJECTS_DIR=projDir;process.env.SQUAD_PORT='4348';
const {server}=require('../server.js');const PORT=4348,HOST='127.0.0.1';
const MIN_WS={version:2,agents:[{id:'a1',name:'Cmd',role:'commander'}],projects:[{id:'p1',code:'OPR',name:'Op R',folder:'op-resume',squadId:null,adrs:[],sprints:[],features:[],logs:[],handoffs:[]}],squads:[],conventionLibrary:{templates:[],subsets:[]}};
function req(m,p,b,t){return new Promise((res,rej)=>{const data=b?Buffer.from(JSON.stringify(b)):null;const r=http.request({host:HOST,port:PORT,path:p,method:m,headers:{'content-type':'application/json','host':`${HOST}:${PORT}`,...(t?{'x-squad-token':t}:{}),...(data?{'content-length':data.length}:{})}},rs=>{let o='';rs.on('data',d=>o+=d);rs.on('end',()=>res({status:rs.statusCode,body:o}));});r.on('error',rej);if(data)r.write(data);r.end();});}
function tk(){return new Promise((res,rej)=>{http.get({host:HOST,port:PORT,path:'/',headers:{host:`${HOST}:${PORT}`}},r=>{let o='';r.on('data',d=>o+=d);r.on('end',()=>{const m=o.match(/squad-bridge-token" content="([^"]+)"/);res(m?m[1]:null);});}).on('error',rej);});}
function stream(runId,t){return new Promise((resolve)=>{const ev=[];http.get({host:HOST,port:PORT,path:`/api/runs/${runId}/events?token=${t}`,headers:{host:`${HOST}:${PORT}`}},r=>{let buf='';r.on('data',d=>{buf+=d;let c;while((c=buf.indexOf('\n\n'))>=0){const ch=buf.slice(0,c);buf=buf.slice(c+2);const line=ch.split('\n').filter(l=>l.startsWith('data: ')).map(l=>l.slice(6)).join('\n');if(!line)continue;try{const e=JSON.parse(line);ev.push(e);if(e.type==='exit')resolve(ev);}catch{}}});r.on('end',()=>resolve(ev));}).on('error',()=>resolve(ev));setTimeout(()=>resolve(ev),60000);});}
function ok(m){console.log('ok -',m);}function fail(m){console.error('FAIL:',m);process.exitCode=1;}
(async()=>{await new Promise(r=>server.listen(PORT,HOST,r));try{
 const t=await tk();await req('POST','/api/setup',MIN_WS,t);
 const r1=await req('POST','/api/runs',{prompt:'Lembre o numero 77 para a proxima pergunta. Responda apenas OK.',label:'r1',options:{project:'op-resume'}},t);
 const e1=(await stream(JSON.parse(r1.body).runId,t)).find(e=>e.type==='exit');const sid=e1&&e1.sessionId;
 e1&&e1.status==='done'&&sid?ok('run1 done, sessionId='+String(sid).slice(0,8)):fail('run1 sem sessionId');
 const r2=await req('POST','/api/runs',{prompt:'Qual numero pedi para lembrar? Responda apenas o numero.',label:'r2',options:{project:'op-resume',resumeId:sid}},t);
 const e2=(await stream(JSON.parse(r2.body).runId,t)).find(e=>e.type==='exit');
 e2&&e2.status==='done'?ok('run2 (resume) done'):fail('run2 falhou: '+(e2&&e2.error));
 e2&&/77/.test(e2.result||'')?ok('contexto retomado: run2 respondeu "'+String(e2.result).trim().slice(0,30)+'"'):fail('run2 nao lembrou: "'+String(e2&&e2.result).trim().slice(0,60)+'"');
}catch(e){fail(e.message);}finally{server.close();try{fs.rmSync(dataDir,{recursive:true,force:true});}catch{}try{fs.rmSync(projDir,{recursive:true,force:true});}catch{}console.log(process.exitCode?'\nRESUME TEST FAILED':'\nRESUME TEST PASSED');setTimeout(()=>process.exit(process.exitCode||0),200);}})();
