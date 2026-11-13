import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {optimize} from '../evals/agent/optimize.mjs';
import {tasks} from '../evals/agent/tasks/corpus.mjs';
import {runAttempt,materialize,validate,runProcess,campaign,selectCandidate,summarize} from '../evals/agent/run.mjs';

const budget={timeoutMs:10000,maxTokens:1000,maxToolCalls:4,maxCostUsd:.1,maxOutputBytes:65536};
function temporary(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentdoc-driver-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function driver(t,body){const file=path.join(temporary(t),'driver.mjs');fs.writeFileSync(file,`import fs from 'node:fs';let s='';for await(const c of process.stdin)s+=c;const request=JSON.parse(s);${body}`);return [process.execPath,file];}
const usage=`console.log(JSON.stringify({type:'usage',usage:{inputTokens:50,outputTokens:30,toolCalls:1,costUsd:.01}}));console.log(JSON.stringify({type:'result',completed:true}));`;

test('agent eval corpus pins 30 fixtures and separates held-out families',()=>{
 assert.equal(tasks.length,30);assert.equal(new Set(tasks.map(t=>t.id)).size,30);
 const dev=new Set(tasks.filter(t=>t.split==='development').map(t=>t.family));assert.ok(tasks.filter(t=>t.split==='holdout').every(t=>!dev.has(t.family)));
 assert.ok(tasks.every(t=>/^[a-f0-9]{64}$/.test(t.fixtureHash)));
});
test('independent validation rejects original implementation and preserves input requirements',async t=>{
 const workspace=temporary(t);materialize(tasks[0],workspace);assert.equal((await validate(tasks[0],workspace)).passed,false);
 fs.writeFileSync(path.join(workspace,'service/src/logic.mjs'),'export function solve(rows){return rows.reduce((n,r)=>n+Math.round((r.price+Number.EPSILON)*100)*r.quantity,0)}');
 assert.equal((await validate(tasks[0],workspace)).passed,true);
});
test('agent eval validates actual patch rather than driver success claim',async t=>{
 const bad=await runAttempt({task:tasks[0],condition:'baseline',driver:driver(t,usage),budget});assert.equal(bad.status,'failed');
 const good=await runAttempt({task:tasks[0],condition:'candidate',driver:driver(t,`fs.writeFileSync('service/src/logic.mjs','export function solve(rows){return rows.reduce((n,r)=>n+Math.round((r.price+Number.EPSILON)*100)*r.quantity,0)}');${usage}`),budget});assert.equal(good.status,'passed');assert.equal(good.usage.costUsd,.01);
});
test('agent eval rejects absent usage and detects token, cost and tool limits',async t=>{
 const absent=await runAttempt({task:tasks[0],condition:'baseline',driver:driver(t,"console.log(JSON.stringify({type:'result',completed:true}));"),budget});assert.equal(absent.status,'infrastructure-error');
 for(const [key,value,reason] of [['inputTokens',1001,'token-limit'],['costUsd',.2,'cost-limit'],['toolCalls',5,'tool-limit']]){
  const data={inputTokens:10,outputTokens:10,toolCalls:1,costUsd:.01,[key]:value};const r=await runAttempt({task:tasks[0],condition:'baseline',driver:driver(t,`console.log(JSON.stringify({type:'usage',usage:${JSON.stringify(data)}}));setInterval(()=>{},1000);`),budget});assert.equal(r.reason,reason);assert.equal(r.status,'budget-exceeded');
 }
});
test('process timeout kills descendant process group',async t=>{
 if(process.platform==='win32')return;
 const marker=path.join(temporary(t),'orphan');
 const program=`const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),400)`)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
 const r=await runProcess([process.execPath,'-e',program],{timeoutMs:100});assert.equal(r.reason,'timeout');await new Promise(resolve=>setTimeout(resolve,600));assert.equal(fs.existsSync(marker),false);
});
test('campaign cap reserves attempt maximum before starting and requires pinned model',async t=>{
 await assert.rejects(campaign({driver:['node'],repeats:1}),/Pin model/);
 const r=await campaign({driver:driver(t,usage),model:'test-driver',modelVersion:'1',repeats:1,tasks:[tasks[0].id],budget,maxCampaignCostUsd:.05});assert.equal(r.stopped,'campaign-cost-limit');assert.equal(r.attempts.length,0);
});
test('candidate selection rejects tiny samples, development leakage and unmeasured cost',()=>{
 const ref=tasks.slice(18).map(t=>({task:t.id,family:t.family,split:t.split,fixtureHash:t.fixtureHash,repeat:0,status:'passed',usage:{inputTokens:100,outputTokens:10,costUsd:1}}));
 const candidate=ref.map(t=>({...t,usage:{...t.usage,costUsd:.5}}));
 assert.equal(selectCandidate(ref,candidate).reason,'insufficient-noninferiority-evidence');
 assert.equal(selectCandidate(ref,candidate.slice(1)).reason,'unpaired-data');
 assert.equal(selectCandidate(ref,candidate.map(t=>({...t,criticalError:true}))).reason,'critical-error');
 assert.equal(summarize([{status:'failed'}]).costPerSuccess,null);
});

test('offline optimizer bounds candidates and rejects arbitrary proposal commands',async t=>{
 await assert.rejects(optimize({maxCandidates:21}),/maxCandidates/);
 await assert.rejects(optimize({maxCandidates:1,variants:{reference:{}},reference:{}}),/variant names/);
 const malicious=driver(t,"console.log(JSON.stringify({variants:['undeclared']}));");
 await assert.rejects(optimize({maxCandidates:1,variants:{compact:{}},reference:{},proposer:malicious,campaign:{budget:{maxCostUsd:.1}},maxTotalCostUsd:1}),/undeclared/);
});

test('every pinned initial defect is rejected by its independent behavior validator',async t=>{
 for(const task of tasks){
  const workspace=temporary(t);
  for(const name of ['service/src/logic.mjs','service/src/consumer.mjs']){const dest=path.join(workspace,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,task.files[name]);}
  assert.equal((await validate(task,workspace)).passed,false,task.id);
 }
});

test('independent validator rejects a premature successful process exit',async t=>{
 const workspace=temporary(t);materialize(tasks[0],workspace);
 fs.writeFileSync(path.join(workspace,'service/src/logic.mjs'),'export function solve(){process.exit(0)}');
 assert.equal((await validate(tasks[0],workspace)).passed,false);
});

test('cumulative dollar costs cannot decrease or disappear even without a dollar cap',async t=>{
 for(const cost of [.01,null,-1]){
  const first={inputTokens:10,outputTokens:10,toolCalls:1,costUsd:.08};
  const second={inputTokens:20,outputTokens:20,toolCalls:2,costUsd:cost};
  const d=driver(t,`console.log(JSON.stringify({type:'usage',usage:${JSON.stringify(first)}}));console.log(JSON.stringify({type:'usage',usage:${JSON.stringify(second)}}));console.log(JSON.stringify({type:'result',completed:true}));`);
  const r=await runAttempt({task:tasks[0],condition:'baseline',driver:d,budget:{...budget,maxCostUsd:null}});
  assert.equal(r.status,'infrastructure-error');
  assert.equal(r.usage.costUsd,.08);
 }
});

test('evaluation entrypoints execute through symlinked paths',async t=>{
 const dir=temporary(t);
 for(const [name,args,expected] of [['run.mjs',['--list'],0],['optimize.mjs',[path.join(dir,'missing.json')],2]]){
  const target=path.resolve('evals/agent',name),link=path.join(dir,name);
  fs.symlinkSync(target,link);
  const r=await runProcess([process.execPath,link,...args],{timeoutMs:10000});
  assert.equal(r.code,expected,r.stderr);
  if(name==='run.mjs')assert.equal(JSON.parse(r.stdout).length,30);
  else assert.match(r.stderr,/ENOENT/);
 }
});
