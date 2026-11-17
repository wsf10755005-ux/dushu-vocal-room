// Wait until GitHub's artifact listing exposes this exact uploaded artifact.
const {GITHUB_API_URL='https://api.github.com',GITHUB_REPOSITORY,GITHUB_RUN_ID,GH_TOKEN,ARTIFACT_NAME,ARTIFACT_ID}=process.env;
if(!GITHUB_REPOSITORY||!GITHUB_RUN_ID||!GH_TOKEN||!ARTIFACT_NAME||!ARTIFACT_ID)throw new Error('Missing artifact metadata inputs.');
const endpoint=new URL(GITHUB_API_URL+'/repos/'+GITHUB_REPOSITORY+'/actions/runs/'+GITHUB_RUN_ID+'/artifacts');
endpoint.searchParams.set('per_page','100');
let ready=false;
for(let attempt=0;attempt<12;attempt++){
  const response=await fetch(endpoint,{headers:{Authorization:'Bearer '+GH_TOKEN,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
  if(!response.ok)throw new Error('Artifact listing returned HTTP '+response.status);
  const result=await response.json();
  const matches=(result.artifacts||[]).filter(a=>a.name===ARTIFACT_NAME&&!a.expired);
  if(matches.length===1&&String(matches[0].id)===String(ARTIFACT_ID)){ready=true;console.log('Verified uploaded artifact metadata.');break}
  if(attempt<11)await new Promise(resolve=>setTimeout(resolve,5000));
}
if(!ready)throw new Error('Uploaded artifact did not become visible before publication.');
