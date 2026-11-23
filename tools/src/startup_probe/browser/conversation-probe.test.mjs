import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const dir = new URL('./', import.meta.url);
const accept = readFileSync(new URL('conversation-accept.js', dir), 'utf8');
const stored = readFileSync(new URL('conversation-stored-work.js', dir), 'utf8');
const prompt = 'Replay the plan and reads fixture.';
const user = {id:'message-fixture', role:'user', text:prompt};
const command = {commandId:'command-fixture', threadId:'thread-fixture', projectId:'conversation-fixture', modelSelection:{instanceId:'devReplay',model:'todo-list'}, initialMessage:{messageId:user.id,text:prompt}};
const request = {_tag:'Request',id:'42',tag:'orchestration.launchThread',payload:command};
const success = {_tag:'Exit',requestId:'42',exit:{_tag:'Success',value:{sequence:7,resumed:false,threadId:command.threadId,projection:{thread:{id:command.threadId},messages:[user]}}}};
function observer() {
  class Socket {
    listeners=new Set(); sent=[];
    send(data){this.sent.push(data);}
    addEventListener(_,fn){this.listeners.add(fn);}
    removeEventListener(_,fn){this.listeners.delete(fn);}
    receive(frame){for(const fn of this.listeners) fn({data:typeof frame === 'string' ? frame : JSON.stringify(frame)});}
  }
  const context={TextEncoder,WebSocket:Socket,window:{},performance:{timeOrigin:1000,now:()=>10}};
  vm.runInNewContext('(function(){'+accept+'}).apply(null, '+JSON.stringify([prompt])+')',context);
  return {socket:new Socket(),state:context.window.fixtureConversationAccept,Socket};
}
const clone=x=>structuredClone(x);
let checks=0;
function okCase(name, run){run();checks++;console.log('PASS '+name);}
okCase('matches the launch request and preserves original send',()=>{
 const {socket,state,Socket}=observer(); socket.send(JSON.stringify([request]));
 socket.receive({...success,requestId:'other'});assert.equal(state.result,null);
 socket.receive(success);assert.equal(state.result.commandId,command.commandId);assert.equal(state.result.sequence,7);
 assert.equal(socket.sent.length,1);state.stop();assert.equal(socket.listeners.size,0);
 assert.equal(Socket.prototype.send.name,'send');
});
okCase('joins production split frames before matching',()=>{
 const {socket,state}=observer();socket.send(JSON.stringify(request));
 const text=JSON.stringify([success]);socket.receive('\u001e'+text.slice(0,25));socket.receive(text.slice(25));assert.equal(state.result.messageId,user.id);
});
for (const [name,mutate] of [
 ['missing sequence',x=>delete x.exit.value.sequence],['zero sequence',x=>x.exit.value.sequence=0],
 ['resumed launch',x=>x.exit.value.resumed=true],['wrong thread',x=>x.exit.value.threadId='other'],
 ['wrong message',x=>x.exit.value.projection.messages[0].id='other'],['wrong prompt',x=>x.exit.value.projection.messages[0].text='other'],
 ['failed exit',x=>x.exit._tag='Failure'],
]) okCase('rejects '+name,()=>{const {socket,state}=observer();socket.send(JSON.stringify(request));const x=clone(success);mutate(x);socket.receive(x);assert.ok(state.error);assert.equal(state.result,null);});
okCase('ignores unrelated commands',()=>{const {socket,state}=observer();socket.send(JSON.stringify({...request,tag:'orchestration.dispatchCommand'}));socket.receive(success);assert.equal(state.requests,0);assert.equal(state.result,null);});
okCase('refuses duplicate fixture launches',()=>{const {socket,state}=observer();socket.send(JSON.stringify(request));socket.send(JSON.stringify(request));assert.ok(state.error);});
const projection={thread:{id:command.threadId,modelSelection:command.modelSelection}, messages:[user,
 {role:'assistant',text:"I'll track the three steps and inspect both files.",streaming:false},
 {role:'assistant',text:'todo list fixture complete',streaming:false}],runs:[{status:'completed'}],
 plans:[{kind:'todo_list',steps:['Inspect package.json','Inspect tsconfig.json','Report completion'].map(text=>({text,status:'completed'}))}],
 turnItems:[['package.json','{"name":"t3"}'],['tsconfig.json','{"compilerOptions":{}}']].map(([path,content])=>({id:path,threadId:command.threadId,type:'dynamic_tool',toolName:'Read',title:`Read ${path}`,status:'completed',input:{path},output:{content}}))};
async function snapshot(p,status=200,path='/env/thread-fixture',detailMode='ok') {
 return await new Promise((resolve,reject)=>{
   class DetailSocket {
     listeners=new Map();
     constructor(url){assert.equal(url.pathname,'/ws');assert.equal(url.search,'?orchestrationProtocol=2');queueMicrotask(()=>this.listeners.get('open')?.());}
     addEventListener(name,fn){this.listeners.set(name,fn);}
     send(text){const req=JSON.parse(text);assert.equal(req.tag,'orchestration.getTurnItem');assert.equal(req.payload.threadId,command.threadId);queueMicrotask(()=>this.listeners.get('message')?.({data:JSON.stringify({_tag:'Exit',requestId:req.id,exit:{_tag:'Success',value:{item:detailMode==='missing' ? null : detailMode==='wrong-thread' ? {...p.turnItems.find(item=>item.id===req.payload.itemId),threadId:'other'} : p.turnItems.find(item=>item.id===req.payload.itemId)}}})}));}
     close(){}
   }
   const compact=clone(p);for(const item of compact.turnItems){delete item.output;item.outputOmitted=true;}
   const context={URL,WebSocket:DetailSocket,setTimeout,clearTimeout,location:{pathname:path,href:'http://127.0.0.1:1234'+path},fetch:async()=>({ok:status===200,json:async()=>({projection:compact})}),fixtureArgs:[prompt,{threadId:command.threadId,messageId:user.id},resolve]};
   try{vm.runInNewContext('(function(){'+stored+'}).apply(null, fixtureArgs)',context);}catch(e){reject(e);}
 });
}
assert.equal((await snapshot(projection)).valid,true);checks++;console.log('PASS exact stored fixture');
for(const [name,mutate] of [
 ['extra user',x=>x.messages.push(user)],['wrong user id',x=>x.messages[0].id='other'],
 ['extra answer bytes',x=>x.messages[2].text+='!'],['streaming',x=>x.messages[1].streaming=true],
 ['incomplete run',x=>x.runs[0].status='running'],['extra run',x=>x.runs.push({status:'completed'})],
 ['missing plan step',x=>x.plans[0].steps.pop()],['pending plan',x=>x.plans[0].steps[0].status='pending'],
 ['missing read',x=>x.turnItems.pop()],['wrong read input',x=>x.turnItems[0].input.path='other'],
 ['wrong read output',x=>x.turnItems[0].output.content='other'],['failed read',x=>x.turnItems[0].status='failed'],
]) {const x=clone(projection);mutate(x);assert.equal((await snapshot(x)).valid,false,name);checks++;console.log('PASS rejects '+name);}
assert.equal((await snapshot(projection,401)).valid,false);checks++;
assert.equal((await snapshot(projection,200,'/env/other')).valid,false);checks++;
for(const mode of ['missing','wrong-thread']) {assert.equal((await snapshot(projection,200,'/env/thread-fixture',mode)).valid,false);checks++;console.log('PASS rejects detail '+mode);}


// Opt-in diagnostic boundaries must not affect acknowledgement validity.
function diagnosticObserver(enabled=true) {
 class Socket {
  listeners=new Set();sent=[];
  send(data){this.sent.push(data);}
  addEventListener(_,fn){this.listeners.add(fn);}
  removeEventListener(_,fn){this.listeners.delete(fn);}
  receive(data){for(const fn of this.listeners) fn({data:typeof data==='string'?data:JSON.stringify(data)});}
 }
 let now=10;
 const context={TextEncoder,WebSocket:Socket,window:{},performance:{timeOrigin:1000,now:()=>now}};
 vm.runInNewContext('(function(){'+accept+'}).apply(null, '+JSON.stringify([prompt,enabled])+')',context);
 return {socket:new Socket(),state:context.window.fixtureConversationAccept,tick:()=>now+=10};
}
const textEvent=(thread=command.threadId,text="I'll track the")=>({_tag:'Chunk',requestId:'subscription',values:[{kind:'event',sequence:8,event:{threadId:thread,type:'message.updated',payload:{role:'assistant',text}}}]});
okCase('diagnostic matches thread text before ack without sending extra RPCs',()=>{
 const {socket,state,tick}=diagnosticObserver();socket.send(JSON.stringify(request));
 assert.equal(state.attribution.sendEpochMillis,1010);tick();
 socket.receive(textEvent('other'));socket.receive(textEvent(command.threadId,'unrelated'));
 assert.equal(state.attribution.firstTextWireEpochMillis,null);
 const text=JSON.stringify(textEvent());socket.receive('\u001e'+text.slice(0,18));tick();socket.receive(text.slice(18));
 assert.equal(state.attribution.firstTextWireEpochMillis,1030);tick();socket.receive(textEvent());socket.receive(success);
 assert.equal(state.attribution.firstTextWireEpochMillis,1030);assert.equal(state.result.ackEpochMillis,1040);
 assert.equal(socket.sent.length,1);state.stop();assert.equal(socket.listeners.size,0);
});
okCase('diagnostic missing wire text remains unknown with a valid ack',()=>{
 const {socket,state}=diagnosticObserver();socket.send(JSON.stringify(request));socket.receive(success);
 assert.equal(state.attribution.firstTextWireEpochMillis,null);assert.equal(state.result.sequence,7);
});
okCase('ordinary observer emits no attribution fields',()=>{
 const {socket,state}=diagnosticObserver(false);socket.send(JSON.stringify(request));socket.receive(textEvent());socket.receive(success);
 assert.equal('attribution' in state,false);assert.equal(state.result.sequence,7);
});
okCase('diagnostic recognizes a same-thread uncompressed snapshot',()=>{
 const {socket,state}=diagnosticObserver();socket.send(JSON.stringify(request));
 socket.receive({_tag:'Chunk',values:[{kind:'snapshot',projection:{thread:{id:command.threadId},messages:[{role:'assistant',text:"I'll track the"}]}}]});
 assert.equal(state.attribution.firstTextWireEpochMillis,1010);
});

const receiptRequest = {...request,payload:{...command,responseMode:'receipt'}};
const receiptSuccess = {...success,exit:{_tag:'Success',value:{responseMode:'receipt',threadId:command.threadId,resumed:false,sequence:7}}};
okCase('records advertised mode and matching UTF-8 response sizes',()=>{
 for (const [req,reply,kind] of [[receiptRequest,receiptSuccess,'receipt'],[receiptRequest,success,'projection'],[request,success,'projection']]) {
  const {socket,state}=observer();const sent=JSON.stringify(req);socket.send(sent);
  socket.receive({...reply,requestId:'unrelated'});assert.equal(state.result,null);
  const text=JSON.stringify([reply]);socket.receive('\u001e'+text.slice(0,25));socket.receive(text.slice(25));
  assert.equal(state.error,null);assert.equal(state.result.responseKind,kind);
  assert.equal(state.result.requestResponseMode,req.payload.responseMode??null);
  assert.equal(state.result.ackValueBytes,Buffer.byteLength(JSON.stringify(reply.exit.value)));
  assert.equal(state.result.ackExitBytes,Buffer.byteLength(JSON.stringify(reply)));
  assert.equal(socket.sent[0],sent);assert.equal(socket.sent.length,1);
 }
});
for (const [name,mutate] of [
 ['receipt zero sequence',x=>x.exit.value.sequence=0],
 ['receipt missing sequence',x=>delete x.exit.value.sequence],
 ['receipt unsafe sequence',x=>x.exit.value.sequence=Number.MAX_SAFE_INTEGER+1],
 ['receipt resumed',x=>x.exit.value.resumed=true],
 ['receipt wrong thread',x=>x.exit.value.threadId='other'],
 ['receipt with projection',x=>x.exit.value.projection=success.exit.value.projection],
 ['receipt extra field',x=>x.exit.value.unexpected=true],
 ['receipt missing discriminator',x=>delete x.exit.value.responseMode],
 ['receipt unknown discriminator',x=>x.exit.value.responseMode='future'],
 ['receipt failure',x=>x.exit._tag='Failure'],
]) okCase('rejects '+name,()=>{
 const {socket,state}=observer();socket.send(JSON.stringify(receiptRequest));
 const reply=clone(receiptSuccess);mutate(reply);socket.receive(reply);
 assert.ok(state.error);assert.equal(state.result,null);
});
okCase('rejects unadvertised receipt',()=>{
 const {socket,state}=observer();socket.send(JSON.stringify(request));socket.receive(receiptSuccess);
 assert.ok(state.error);assert.equal(state.result,null);
});
okCase('rejects malformed legacy sibling after receipt advertisement',()=>{
 for (const mutate of [x=>delete x.exit.value.projection.messages,x=>x.exit.value.projection.thread.id='other',x=>x.exit.value.projection.messages[0].id='other']) {
  const {socket,state}=observer();socket.send(JSON.stringify(receiptRequest));
  const reply=clone(success);mutate(reply);socket.receive(reply);
  assert.ok(state.error);assert.equal(state.result,null);
 }
});
okCase('rejects duplicate receipt exit',()=>{
 const {socket,state}=observer();socket.send(JSON.stringify(receiptRequest));socket.receive(receiptSuccess);socket.receive(receiptSuccess);
 assert.equal(state.error,'duplicate launch exit');
});
okCase('counts UTF-8 bytes rather than UTF-16 code units',()=>{
 const {socket,state}=observer();socket.send(JSON.stringify(request));
 const reply=clone(success);reply.exit.value.projection.extra='雪';socket.receive(reply);
 assert.equal(state.result.ackValueBytes,Buffer.byteLength(JSON.stringify(reply.exit.value)));
 assert.ok(state.result.ackValueBytes>JSON.stringify(reply.exit.value).length);
});

console.log(`Passed ${checks} synthetic checks; no browser, provider, network or installed profile used.`);
