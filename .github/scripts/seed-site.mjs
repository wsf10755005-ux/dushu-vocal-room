import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const manifestText=await readFile('.github/site-files.json','utf8');
const manifestSha=createHash('sha256').update(manifestText).digest('hex');
try{const prior=JSON.parse(await readFile('site/.import-complete.json','utf8'));await access('site/index.html');if(prior.manifestSha===manifestSha){console.log('Using the application source already in this repository.');process.exit(0)}}catch{}
const files=JSON.parse(manifestText);
const origin='https://vocal-lab-shaofu.wsf10755005.chatgpt.site/';
const root=path.resolve('site');
for(let offset=0;offset<files.length;offset+=4){await Promise.all(files.slice(offset,offset+4).map(async entry=>{
  if(typeof entry.path!=='string'||entry.path.startsWith('/')||entry.path.split('/').some(x=>x==='..'))throw new Error('Invalid asset path');
  const target=path.resolve(root,entry.path);if(!target.startsWith(root+path.sep))throw new Error('Asset outside site directory');
  try{const existing=await readFile(target);if(createHash('sha256').update(existing).digest('hex')===entry.sha256){console.log(`Retained verified ${entry.path}`);return;}}catch{}
  let bytes;if(entry.path==='index.html')bytes=new Uint8Array(await readFile('.github/site-index.html'));else{const response=await fetch(new URL(entry.path,origin));if(!response.ok)throw new Error(`Could not download ${entry.path}: ${response.status}`);bytes=new Uint8Array(await response.arrayBuffer());}
  if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error(`Source changed for ${entry.path}; update the verified manifest before publishing.`);
  await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);console.log(`Imported ${entry.path}`);
}));}
await writeFile(path.join(root,'.nojekyll'),'');
await writeFile(path.join(root,'.import-complete.json'),JSON.stringify({version:3,files:files.length,manifestSha}));
console.log('All application assets verified. Later deployments use this repository and do not download the original site.');
