#!/usr/bin/env node
// Bounded offline selection of agent-proposed context variants. Never edits core code.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {campaign,runProcess,selectCandidate} from './run.mjs';
import {tasks,publicTask} from './tasks/corpus.mjs';

export async function optimize(config){
  if(!Number.isInteger(config.maxCandidates)||config.maxCandidates<1||config.maxCandidates>20)throw new Error('maxCandidates must be an integer in [1,20]');
  const variants=config.variants;
  if(!variants||!Object.keys(variants).length||Object.keys(variants).length>config.maxCandidates)throw new Error('declare at most maxCandidates context variants');
  if(Object.keys(variants).some(id=>id==='reference'||!(/^[a-z][a-z0-9-]*$/).test(id)))throw new Error('variant names must be unique non-reference identifiers');
  if(!config.reference)throw new Error('reference condition required');
  let ids=Object.keys(variants);
  if(config.proposer){
    const r=await runProcess(config.proposer,{cwd:process.cwd(),timeoutMs:config.proposerTimeoutMs||30000,maxOutputBytes:65536,input:JSON.stringify({protocol:'agentdoc.eval.proposal/v1',developmentTasks:tasks.filter(t=>t.split==='development').map(publicTask),allowedVariants:variants,maxCandidates:config.maxCandidates})+'\n'});
    if(r.code!==0||r.reason||r.error)throw new Error('proposal driver failed');
    const proposed=JSON.parse(r.stdout);
    if(!Array.isArray(proposed.variants)||!proposed.variants.length||proposed.variants.length>config.maxCandidates||new Set(proposed.variants).size!==proposed.variants.length||proposed.variants.some(id=>!Object.hasOwn(variants,id)))throw new Error('proposal contains an undeclared variant');
    ids=proposed.variants;
  }
  const base=config.campaign;
  if(!base||!Number.isFinite(config.maxTotalCostUsd)||config.maxTotalCostUsd<=0||!Number.isFinite(base.budget?.maxCostUsd)||base.budget.maxCostUsd<=0)throw new Error('optimization requires measured per-attempt and total dollar caps');
  let spent=0;
  const run=async(split,conditions)=>{
    const remaining=config.maxTotalCostUsd-spent;
    if(remaining<base.budget.maxCostUsd)throw new Error('optimization campaign budget exhausted');
    const report=await campaign({...base,tasks:undefined,split,conditions,maxCampaignCostUsd:remaining});
    if(report.summary.totalCostUsd===null)throw new Error('optimization stopped: unmeasured cost');
    spent+=report.summary.totalCostUsd;
    return report;
  };
  const conditions={reference:config.reference,...Object.fromEntries(ids.map(id=>[id,variants[id]]))};
  const development=await run('development',conditions);
  if(development.stopped||development.summary.infrastructureErrors)return {status:'inconclusive',reason:development.stopped||'infrastructure-errors',spent,development};
  const ranked=ids.sort((a,b)=>{
    const x=development.conditions[a],y=development.conditions[b];
    return y.successRate-x.successRate||(x.costPerSuccess??Infinity)-(y.costPerSuccess??Infinity)||a.localeCompare(b);
  });
  const candidate=ranked[0];
  const validation=await run('holdout',{reference:config.reference,[candidate]:variants[candidate]});
  const decision=validation.stopped?{adopt:false,reason:validation.stopped}:selectCandidate(validation.attempts.filter(x=>x.condition==='reference'),validation.attempts.filter(x=>x.condition===candidate),config.criteria);
  return {schemaVersion:'agentdoc.eval.optimization/v1',status:decision.adopt?'candidate-selected':'inconclusive',candidate,decision,spent,development,validation,publication:'not-performed',finalTest:'required-on-independent-tasks-before-production-performance-claims'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const report=await optimize(config);const text=JSON.stringify(report,null,2)+'\n';if(process.argv[3])fs.writeFileSync(process.argv[3],text);else process.stdout.write(text);if(report.status!=='candidate-selected')process.exitCode=1;}catch(e){console.error(e.message);process.exitCode=2;}
}
