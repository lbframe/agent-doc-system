#!/usr/bin/env node
// Optional local Codex driver. Uses the user's configured model/provider unchanged.
import readline from 'node:readline';
import {spawn} from 'node:child_process';
const lines=readline.createInterface({input:process.stdin});
let request;
for await(const line of lines){request=JSON.parse(line);break;}
if(!request||request.protocol!=='agentdoc.eval.driver/v1')throw new Error('invalid evaluation request');
const prompt=[request.instructions,request.task.prompt,'Task paths: '+request.task.paths.join(', '),
  'Budget: '+JSON.stringify(request.budget),'Context supplied by '+request.condition+':',...request.context,
  'Work only in this temporary task repository. Finish after implementing and checking the fix.'].join('\n\n');
const child=spawn('codex',['exec','--json','--ephemeral','--skip-git-repo-check','-s','workspace-write','-C',request.workspace,'-'],{stdio:['pipe','pipe','pipe']});
const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
let inputTokens=0,outputTokens=0,cachedInputTokens=0,toolCalls=0,failed=false;
const usage=()=>({inputTokens,outputTokens,cachedInputTokens,toolCalls,costUsd:null});
const stop=()=>{failed=true;child.kill('SIGKILL');};
child.stdin.end(prompt);
child.stderr.on('data',chunk=>process.stderr.write(chunk));
const exited=new Promise(resolve=>{child.on('error',error=>{console.error(error.message);resolve(1);});child.on('close',resolve);});
const reader=readline.createInterface({input:child.stdout});
for await(const line of reader){
  let event;try{event=JSON.parse(line);}catch{continue;}
  if(event.type==='item.completed'&&['command_execution','mcp_tool_call','web_search'].includes(event.item?.type))toolCalls++;
  if(event.type==='turn.completed'){
    inputTokens+=event.usage?.input_tokens||0;outputTokens+=event.usage?.output_tokens||0;cachedInputTokens+=event.usage?.cached_input_tokens||0;
    emit({type:'usage',usage:usage()});
  }
  if(event.type==='turn.failed'||event.type==='error'){failed=true;emit({type:'trace',message:event.error?.message||event.message||event.type});}
  if(inputTokens+outputTokens>request.budget.maxTokens||toolCalls>request.budget.maxToolCalls)stop();
}
const code=await exited;
emit({type:'usage',usage:usage()});emit({type:'result',completed:code===0&&!failed});process.exitCode=code===0&&!failed?0:1;
