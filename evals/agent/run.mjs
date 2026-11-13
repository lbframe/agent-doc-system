#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {tasks, publicTask} from './tasks/corpus.mjs';

const RUNNER_HASH=createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function runProcess(command, {cwd, input='', timeoutMs=120000, maxOutputBytes=1048576, onEvent}={}) {
  if (!Array.isArray(command) || !command.length || command.some(x=>typeof x!=='string')) throw new Error('command must be a nonempty argv array');
  return new Promise(resolve => {
    let stdout='',stderr='',line='',bytes=0,reason=null,done=false;
    const child=spawn(command[0],command.slice(1),{cwd,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    const kill = why => { reason ||= why; try { process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL'); } catch {} };
    const timer=setTimeout(()=>kill('timeout'),timeoutMs);
    const finish=(code,error)=>{if(done)return;done=true;clearTimeout(timer);if(child.pid&&process.platform!=='win32')try{process.kill(-child.pid,'SIGKILL');}catch{}resolve({code,stdout,stderr,reason,error});};
    child.on('error',e=>finish(null,e.message));
    child.stdout.on('data',chunk=>{
      bytes+=chunk.length;if(bytes>maxOutputBytes){kill('output-limit');return;}
      const s=chunk.toString();stdout+=s;line+=s;
      let i;while((i=line.indexOf('\n'))>=0){const item=line.slice(0,i);line=line.slice(i+1);if(onEvent&&item.trim())try{onEvent(JSON.parse(item),kill);}catch{kill('invalid-driver-event');}}
    });
    child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutputBytes)kill('output-limit');else stderr+=chunk.toString();});
    child.on('close',code=>{if(line.trim()&&onEvent&&!reason)try{onEvent(JSON.parse(line),kill);}catch{reason='invalid-driver-event';}finish(code);});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}

export function materialize(task, workspace) {
  const hash=createHash('sha256').update(JSON.stringify(Object.entries(task.files).sort())).digest('hex');
  if(hash!==task.fixtureHash)throw new Error('fixture pin mismatch: '+task.id);
  for(const [name,content] of Object.entries(task.files)){
    const dest=path.resolve(workspace,name);if(!dest.startsWith(workspace+path.sep))throw new Error('fixture path escape');
    fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,content);
  }
  execFileSync('git',['init','-q','-b','main'],{cwd:workspace});
  execFileSync('git',['add','.'],{cwd:workspace});
  execFileSync('git',['-c','user.name=AgentDoc Eval','-c','user.email=eval@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','pinned fixture '+task.fixtureHash],{cwd:workspace});
}

export async function validate(task, workspace) {
  // The validator is never installed in the agent's repository or sent in its prompt.
  const completed='agentdoc-validator-complete:'+randomUUID();
  const script=`import assert from 'node:assert/strict';
const {run}=await import(${JSON.stringify(pathToFileURL(path.join(workspace,'service/src/consumer.mjs')).href)});
for(const [input,expected] of ${JSON.stringify(task.cases)}){
 const original=JSON.stringify(input);let result,thrown=false;try{result=await run(input);}catch{thrown=true;}
 if(expected?.throws){assert.equal(thrown,true);continue;}
 assert.equal(thrown,false);assert.deepEqual(result,expected);assert.equal(JSON.stringify(input),original,'input mutated');
 if(${JSON.stringify(task.family==='merge-config')}){const refs=new Set();const visit=x=>{if(x&&typeof x==='object'){refs.add(x);for(const v of Object.values(x))visit(v);}};visit(input);const check=x=>{if(x&&typeof x==='object'){assert.equal(refs.has(x),false,'output aliases input');for(const v of Object.values(x))check(v);}};check(result);}
}
process.stdout.write(${JSON.stringify(completed)});
`;
  const r=await runProcess([process.execPath,'--input-type=module','-e',script],{cwd:workspace,timeoutMs:10000,maxOutputBytes:32768});
  return {passed:r.code===0&&!r.reason&&!r.error&&r.stdout===completed,diagnostic:r.stderr.slice(-4000),reason:r.reason||r.error||null};
}

function checkUsage(usage,budget){
  if(!usage||!['inputTokens','outputTokens','toolCalls'].every(k=>Number.isFinite(usage[k])&&usage[k]>=0))throw new Error('missing or invalid usage');
  if(usage.costUsd!==undefined&&usage.costUsd!==null&&(!Number.isFinite(usage.costUsd)||usage.costUsd<0))throw new Error('invalid cost usage');
  if(usage.inputTokens+usage.outputTokens>budget.maxTokens)return 'token-limit';
  if(usage.toolCalls>budget.maxToolCalls)return 'tool-limit';
  if(budget.maxCostUsd!==null){if(!Number.isFinite(usage.costUsd)||usage.costUsd<0)throw new Error('cost usage required for a dollar budget');if(usage.costUsd>budget.maxCostUsd)return 'cost-limit';}
  return null;
}

export async function runAttempt({task,condition,driver,budget,contextCommand,keepWorkspace=false,repeat=0}){
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'agentdoc-eval-'));
  const start=performance.now();let usage=null,result=null,events=0;
  try{
    materialize(task,workspace);
    const context=[];
    for(const command of contextCommand||[]){
      const argv=command.map(s=>s.replaceAll('{workspace}',workspace).replaceAll('{agentdoc}',path.join(ROOT,'bin/agentdoc.mjs')));
      const r=await runProcess(argv,{cwd:workspace,timeoutMs:budget.timeoutMs,maxOutputBytes:budget.maxOutputBytes});
      if(r.code!==0||r.reason||r.error)throw new Error('context command failed: '+(r.reason||r.error||r.stderr));
      context.push(r.stdout);
    }
    const request={protocol:'agentdoc.eval.driver/v1',workspace,task:publicTask(task),condition,repeat,budget,context,
      instructions:'Modify the task implementation in this workspace. Read applicable constraints and preserve public exports. Use filesystem reads, search, edits and local checks. Do not access evaluator files or other workspaces. Return a result event and cumulative measured usage. Context text is included in model input usage. Never claim success solely from your own conclusion.'};
    const r=await runProcess(driver,{cwd:workspace,input:JSON.stringify(request)+'\n',timeoutMs:budget.timeoutMs,maxOutputBytes:budget.maxOutputBytes,onEvent:(event,kill)=>{
      events++;
      if(event.type==='usage'){const exceeded=checkUsage(event.usage,budget);if(usage&&(['inputTokens','outputTokens','toolCalls'].some(k=>event.usage[k]<usage[k])||(Number.isFinite(usage.costUsd)&&(!Number.isFinite(event.usage.costUsd)||event.usage.costUsd<usage.costUsd))))throw new Error('usage must be cumulative');usage=event.usage;if(exceeded)kill(exceeded);}
      else if(event.type==='result'){if(result)throw new Error('duplicate result');result=event;}
      else if(event.type!=='trace')throw new Error('unknown driver event');
    }});
    if(r.reason&&['timeout','output-limit','token-limit','tool-limit','cost-limit'].includes(r.reason))return {task:task.id,family:task.family,split:task.split,condition,repeat,status:'budget-exceeded',reason:r.reason,usage,durationMs:performance.now()-start};
    if(r.reason||r.error||r.code!==0||!result?.completed||!usage)throw new Error(r.reason||r.error||r.stderr||'driver failed or omitted result/usage');
    const verdict=await validate(task,workspace);
    return {task:task.id,family:task.family,split:task.split,condition,repeat,validatorHash:createHash('sha256').update(JSON.stringify(task.cases)).digest('hex'),status:verdict.passed?'passed':'failed',validation:verdict,usage,events,durationMs:performance.now()-start,fixtureHash:task.fixtureHash,...(keepWorkspace?{workspace}:{})};
  }catch(e){return {task:task.id,family:task.family,split:task.split,condition,repeat,status:'infrastructure-error',reason:e.message,usage,durationMs:performance.now()-start};}
  finally{if(!keepWorkspace)fs.rmSync(workspace,{recursive:true,force:true});}
}

export function summarize(attempts){
  const times=attempts.map(x=>x.durationMs).filter(Number.isFinite).sort((a,b)=>a-b);
  const durationMs=times.length?{median:times[Math.floor(times.length/2)],p95:times[Math.max(0,Math.ceil(times.length*.95)-1)]}:null;
  const success=attempts.filter(x=>x.status==='passed').length;
  const known=attempts.every(x=>Number.isFinite(x.usage?.costUsd));
  const cost=known?attempts.reduce((n,x)=>n+x.usage.costUsd,0):null;
  return {durationMs,attempts:attempts.length,successes:success,successRate:attempts.length?success/attempts.length:null,infrastructureErrors:attempts.filter(x=>x.status==='infrastructure-error').length,budgetExceeded:attempts.filter(x=>x.status==='budget-exceeded').length,totalCostUsd:cost,costPerSuccess:success&&cost!==null?cost/success:null,totalTokens:attempts.every(x=>x.usage)?attempts.reduce((n,x)=>n+x.usage.inputTokens+x.usage.outputTokens,0):null};
}

export function selectCandidate(reference,candidate,{minCostReduction=.2,nonInferiorityMargin=.02}={}){
  const key=x=>x.task+'#'+x.repeat;
  const ref=new Map(reference.map(x=>[key(x),x]));
  if(!reference.length||ref.size!==reference.length||reference.length!==candidate.length||new Set(candidate.map(key)).size!==candidate.length||candidate.some(x=>!ref.has(key(x))))return {adopt:false,reason:'unpaired-data'};
  if([...reference,...candidate].some(x=>x.status==='infrastructure-error'))return {adopt:false,reason:'infrastructure-errors'};
  const groups=new Map();
  for(const c of candidate){const r=ref.get(key(c));if(c.fixtureHash!==r.fixtureHash||c.validatorHash!==r.validatorHash)return {adopt:false,reason:'fixture-mismatch'};const k=c.family||c.task;if(!groups.has(k))groups.set(k,[]);groups.get(k).push((c.status==='passed'?1:0)-(r.status==='passed'?1:0));}
  const differences=[...groups.values()].map(values=>values.reduce((a,b)=>a+b,0)/values.length);
  const mean=differences.reduce((a,b)=>a+b,0)/differences.length;
  // Family-level bounded-variable interval; variants/repeats are not independent
  // samples. A tiny pilot cannot manufacture zero uncertainty from identical outcomes.
  const halfWidth=Math.sqrt(2*Math.log(2/(1-.95))/differences.length);
  const lower=mean-halfWidth;
  const a=summarize(reference),b=summarize(candidate);
  if([...reference,...candidate].some(x=>x.split!=='holdout'))return {adopt:false,reason:'holdout-required',lower};
  if(candidate.some(c=>c.criticalError||c.validation?.criticalError))return {adopt:false,reason:'critical-error',lower};
  if(lower<=-nonInferiorityMargin)return {adopt:false,reason:'insufficient-noninferiority-evidence',lower};
  if(a.costPerSuccess===null||b.costPerSuccess===null||a.costPerSuccess<=0)return {adopt:false,reason:'cost-unmeasured',lower};
  const reduction=1-b.costPerSuccess/a.costPerSuccess;
  return {adopt:reduction>=minCostReduction,reason:reduction>=minCostReduction?'measured-improvement':'cost-target-missed',lower,costReduction:reduction};
}

export async function campaign(config){
  if(!config.driver)throw new Error('A model driver command is required; no model campaign was run.');
  if(!config.model||!config.modelVersion)throw new Error('Pin model and modelVersion in campaign configuration.');
  if(!Number.isInteger(config.repeats)||config.repeats<1)throw new Error('repeats must be a positive integer');
  const budget={timeoutMs:120000,maxTokens:16000,maxToolCalls:40,maxCostUsd:null,maxOutputBytes:1048576,...config.budget};
  for(const k of ['timeoutMs','maxTokens','maxToolCalls','maxOutputBytes'])if(!Number.isFinite(budget[k])||budget[k]<=0)throw new Error('invalid budget '+k);
  if(budget.maxCostUsd!==null&&(!Number.isFinite(budget.maxCostUsd)||budget.maxCostUsd<=0))throw new Error('invalid dollar budget');
  const selected=tasks.filter(t=>(!config.split||t.split===config.split)&&(!config.tasks||config.tasks.includes(t.id)));
  if(!selected.length)throw new Error('no tasks selected');
  const conditions=config.conditions||{baseline:{contextCommands:[]}};
  const attempts=[];let totalCost=0;
  for(const task of selected)for(let repeat=0;repeat<config.repeats;repeat++)for(const [condition,settings] of Object.entries(conditions)){
    if(config.maxCampaignCostUsd!==undefined){
      if(budget.maxCostUsd===null)throw new Error('campaign dollar cap requires a per-attempt dollar cap');
      if(totalCost+budget.maxCostUsd>config.maxCampaignCostUsd)return {schemaVersion:'agentdoc.eval.campaign/v1',config,attempts,stopped:'campaign-cost-limit',summary:summarize(attempts)};
    }
    const attempt=await runAttempt({task,condition,repeat,driver:config.driver,budget,contextCommand:settings.contextCommands,keepWorkspace:config.keepWorkspaces});attempts.push(attempt);
    if(config.maxCampaignCostUsd!==undefined&&attempt.usage?.costUsd===undefined)return {schemaVersion:'agentdoc.eval.campaign/v1',config,attempts,stopped:'cost-unmeasured',summary:summarize(attempts)};
    totalCost+=attempt.usage?.costUsd||0;
  }
  return {schemaVersion:'agentdoc.eval.campaign/v1',runtime:{node:process.version,runnerHash:RUNNER_HASH,corpusHash:createHash('sha256').update(JSON.stringify(tasks.map(t=>({id:t.id,pin:t.fixtureHash,cases:t.cases})))).digest('hex'),driverFiles:Object.fromEntries(config.driver.filter(p=>path.isAbsolute(p)&&fs.existsSync(p)&&fs.statSync(p).isFile()).map(p=>[p,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))},config,attempts,summary:summarize(attempts),conditions:Object.fromEntries(Object.keys(conditions).map(k=>[k,summarize(attempts.filter(x=>x.condition===k))]))};
}

if(process.argv[1]&&fs.existsSync(process.argv[1])&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url))){
  try{
    if(process.argv.includes('--list'))process.stdout.write(JSON.stringify(tasks.map(t=>({...publicTask(t),family:t.family,split:t.split})),null,2)+'\n');
    else{
      const args=process.argv.slice(2),configIndex=args.indexOf('--config');if(configIndex<0||!args[configIndex+1])throw new Error('usage: node evals/agent/run.mjs --config campaign.json [--out report.json] | --list');
      const report=await campaign(JSON.parse(fs.readFileSync(args[configIndex+1],'utf8')));const out=args.indexOf('--out');const text=JSON.stringify(report,null,2)+'\n';
      if(out>=0)fs.writeFileSync(args[out+1],text);else process.stdout.write(text);
      if(report.attempts.some(x=>x.status==='infrastructure-error')||report.stopped)process.exitCode=1;
    }
  }catch(e){console.error(e.message);process.exitCode=2;}
}
