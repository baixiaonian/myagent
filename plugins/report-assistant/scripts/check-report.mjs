/** 报告助手示例 Hook：只校验 write_file 参数，返回协议 JSON，不修改文件或执行命令。 */
import fs from 'node:fs';
import path from 'node:path';
const event=JSON.parse(fs.readFileSync(0,'utf8'));
const file=event.tool?.arguments?.path;
const local=typeof file==='string'?path.relative(path.resolve(event.workspace.path,'reports'),path.resolve(event.workspace.path,file)):null;
const valid=local!==null&&local!==''&&local!=='..'&&!local.startsWith(`..${path.sep}`)&&!path.isAbsolute(local);
console.log(JSON.stringify(valid?{decision:'continue'}:{decision:'deny',reason:'报告必须保存到 reports/ 目录；无法读取完整参数时请减少单次写入内容。'}));
