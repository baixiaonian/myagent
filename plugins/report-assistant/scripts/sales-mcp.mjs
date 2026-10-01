/** 离线示例 MCP：以标准输入输出 JSON-RPC 提供固定样例数据，无网络、凭证或业务副作用。 */
import readline from 'node:readline';
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{try{const m=JSON.parse(line);if(m.id===undefined)return;let result;
 if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'report-sales-example',version:'1.0.0'}};
 else if(m.method==='tools/list')result={tools:[{name:'get_sales',description:'读取离线样例销售数据，不是真实营业数据。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}}]};
 else if(m.method==='tools/call'&&m.params.name==='get_sales')result={content:[{type:'text',text:JSON.stringify({source:'离线演示数据',sales:[{product:'A',revenue:1200},{product:'B',revenue:800}],total:2000})}]};
 else if(m.method==='ping')result={};else{process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}})}\n`);return;}
 process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id:m.id,result})}\n`);
 }catch{console.error('无法解析请求');}});
