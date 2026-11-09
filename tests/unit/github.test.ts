import { createHmac,createVerify,generateKeyPairSync } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { githubRepositoryProvider } from '../../apps/api/src/modules/github/provider.js';
import { verifyWebhookSignature } from '../../apps/api/src/modules/github/service.js';
import type { Config } from '../../apps/api/src/config.js';

const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const config:Config={databaseUrl:'unused',publicOrigin:'http://localhost:5173',githubClientId:'client',githubClientSecret:'',bootstrapAdminGithubId:'',production:false,host:'127.0.0.1',port:3000,githubAppId:'123',githubPrivateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
const sha='a'.repeat(40);
const repo={id:81,owner:{login:'allowed'},name:'repo',full_name:'allowed/repo',private:false,archived:false,disabled:false};
const createdAt='2026-11-07T08:30:00Z';
const pr={number:7,base:{repo:{id:81}},head:{sha},user:{id:42},merged:true,title:'Improve the README',created_at:createdAt};
const commit={sha,author:{id:42},committer:{id:99},commit:{author:{name:'Local author',email:'ignored@example.test',date:createdAt},message:'Improve the README\n\nExplain the setup.'}};
const issue={number:8,user:{id:42},title:'Setup instructions are unclear',created_at:createdAt,repository_url:'https://api.github.com/repos/allowed/repo'};
const input={installationId:'9',repositoryId:'81',owner:'allowed',name:'repo',number:7};
function fixture(overrides:Record<string,unknown|((count:number)=>unknown)>={}) {
  const counts:Record<string,number>={};
  const paths:string[]=[];
  const defaults:Record<string,unknown>={
    '/app/installations/9':{id:9,account:{login:'allowed'},suspended_at:null},
    '/app/installations/9/access_tokens':{token:'installation-secret'},
    '/repos/allowed/repo':repo,
    '/installation/repositories?per_page=100&page=1':{repositories:[repo]},
    '/repos/allowed/repo/pulls/7':pr,
    [`/repos/allowed/repo/commits/${sha}`]:commit,
    '/repos/allowed/repo/issues/8':issue,
    [`/repos/allowed/repo/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`]:{check_runs:[{name:'CI',head_sha:sha,status:'completed',conclusion:'success'}]},
    [`/repos/allowed/repo/commits/${sha}/statuses?per_page=100&page=1`]:[{context:'lint',state:'failure'},{context:'lint',state:'success'}],
  };
  const fetcher=async(url:string|URL|Request,init?:RequestInit)=>{
    const path=String(url).replace('https://api.github.com','');paths.push(path);counts[path]=(counts[path]??0)+1;
    const authorization=(init!.headers as Record<string,string>).authorization;
    if(path.startsWith('/app/')) {
      const [header,payload,signature]=authorization.slice(7).split('.');
      expect(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(keys.publicKey,signature!,'base64url')).toBe(true);
      const claims=JSON.parse(Buffer.from(payload!,'base64url').toString());
      expect(claims.iss).toBe('123');expect(claims.exp-claims.iat).toBeLessThanOrEqual(600);
    } else expect(authorization).toBe('Bearer installation-secret');
    let value=Object.hasOwn(overrides,path)?overrides[path]:defaults[path];
    if(typeof value==='function') value=value(counts[path]!);
    if(value instanceof Response) return value;
    if(value===undefined) throw new Error(`Unexpected GitHub request ${path}`);
    return Response.json(value);
  };
  return {provider:githubRepositoryProvider(config,fetcher as typeof fetch),paths};
}

describe('GitHub installation verification and signed evidence',()=>{
  it('verifies the signature over exact bytes and rejects tampering/malformed signatures',()=>{
    const body=Buffer.from('{ "message": "中文" }');
    const signature=`sha256=${createHmac('sha256','secret').update(body).digest('hex')}`;
    expect(()=>verifyWebhookSignature(body,signature,'secret')).not.toThrow();
    expect(()=>verifyWebhookSignature(Buffer.from('{"message":"中文"}'),signature,'secret')).toThrow('WEBHOOK_SIGNATURE_INVALID');
    expect(()=>verifyWebhookSignature(body,'sha256=bad','secret')).toThrow('WEBHOOK_SIGNATURE_INVALID');
    expect(()=>verifyWebhookSignature(body,signature,undefined)).toThrow('GITHUB_NOT_CONFIGURED');
  });
  it('authenticates the installation and retains the newest failed commit status',async()=>{
    const {provider}=fixture();
    const evidence=await provider.getPullRequest(input);
    expect(evidence).toMatchObject({repositoryId:'81',number:7,headSha:sha,authorGithubId:'42',merged:true});
    expect(evidence.checks).toEqual([{name:'CI',status:'completed',conclusion:'success'},{name:'lint',status:'completed',conclusion:'failure'}]);
    expect(JSON.stringify(evidence)).not.toContain('installation-secret');
  });
  it('rejects public repositories outside this installation and suspended installations',async()=>{
    const outside=fixture({'/installation/repositories?per_page=100&page=1':{repositories:[]}});
    await expect(outside.provider.getPullRequest(input)).rejects.toThrow('仅支持');
    expect(outside.paths).not.toContain('/repos/allowed/repo/pulls/7');
    const suspended=fixture({'/app/installations/9':{id:9,account:{login:'allowed'},suspended_at:new Date().toISOString()}});
    await expect(suspended.provider.getPullRequest(input)).rejects.toThrow('已暂停');
    expect(suspended.paths).not.toContain('/app/installations/9/access_tokens');
  });
  it('rejects private metadata, wrong target repository and a head changed during checks',async()=>{
    await expect(fixture({'/repos/allowed/repo':{...repo,private:true}}).provider.getPullRequest(input)).rejects.toThrow('仅支持');
    await expect(fixture({'/repos/allowed/repo/pulls/7':{...pr,base:{repo:{id:82}}}}).provider.getPullRequest(input)).rejects.toThrow('PR_BINDING_MISMATCH');
    await expect(fixture({'/repos/allowed/repo/pulls/7':(count:number)=>count===1?pr:{...pr,head:{sha:'b'.repeat(40)}}}).provider.getPullRequest(input)).rejects.toThrow('提交已改变');
  });
  it('reads check pagination instead of treating missing later results as success',async()=>{
    const {provider,paths}=fixture({
      [`/repos/allowed/repo/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`]:{check_runs:Array.from({length:100},(_,index)=>({name:`check-${index}`,head_sha:sha,status:'completed',conclusion:'success'}))},
      [`/repos/allowed/repo/commits/${sha}/check-runs?filter=latest&per_page=100&page=2`]:{check_runs:[{name:'required-security',head_sha:sha,status:'completed',conclusion:'failure'}]},
    });
    const evidence=await provider.getPullRequest(input);
    expect(evidence.checks).toContainEqual({name:'required-security',status:'completed',conclusion:'failure'});
    expect(paths.some(path=>path.includes('check-runs')&&path.endsWith('page=2'))).toBe(true);
  });
  it('fails closed on missing credentials and upstream authorization failure',async()=>{
    await expect(githubRepositoryProvider({...config,githubPrivateKey:undefined}).getPullRequest(input)).rejects.toThrow('请先配置');
    await expect(fixture({'/app/installations/9':new Response('{}',{status:403})}).provider.getPullRequest(input)).rejects.toThrow('无法读取');
  });
});

describe('GitHub contribution evidence',()=>{
  const contribution={installationId:'9',repositoryId:'81',owner:'allowed',name:'repo'};
  it('reads a commit by full SHA and uses the linked GitHub author instead of committer or local metadata',async()=>{
    const {provider}=fixture();
    expect(await provider.getContribution!({...contribution,kind:'commit',objectId:sha})).toEqual({repositoryId:'81',kind:'commit',objectId:sha,authorGithubId:'42',title:'Improve the README',createdAt,url:`https://github.com/allowed/repo/commit/${sha}`});
  });
  it('leaves an unlinked commit author unassigned and preserves a different author identity',async()=>{
    const unlinked=fixture({[`/repos/allowed/repo/commits/${sha}`]:{...commit,author:null,committer:{id:42}}});
    expect((await unlinked.provider.getContribution!({...contribution,kind:'commit',objectId:sha})).authorGithubId).toBeNull();
    const different=fixture({[`/repos/allowed/repo/commits/${sha}`]:{...commit,author:{id:84},committer:{id:42}}});
    expect((await different.provider.getContribution!({...contribution,kind:'commit',objectId:sha})).authorGithubId).toBe('84');
  });
  it('accepts an unmerged PR without fetching checks and an open issue',async()=>{
    const {provider,paths}=fixture({'/repos/allowed/repo/pulls/7':{...pr,merged:false,state:'open'},'/repos/allowed/repo/issues/8':{...issue,state:'open'}});
    expect(await provider.getContribution!({...contribution,kind:'pull_request',objectId:'7'})).toEqual({repositoryId:'81',kind:'pull_request',objectId:'7',authorGithubId:'42',title:pr.title,createdAt,url:'https://github.com/allowed/repo/pull/7'});
    expect(await provider.getContribution!({...contribution,kind:'issue',objectId:'8'})).toEqual({repositoryId:'81',kind:'issue',objectId:'8',authorGithubId:'42',title:issue.title,createdAt,url:'https://github.com/allowed/repo/issues/8'});
    expect(paths.some(path=>path.includes('/check-runs')||path.includes('/statuses'))).toBe(false);
  });
  it('rejects PR objects returned by the issues API and mismatched repository or issue number',async()=>{
    for(const value of [{...issue,pull_request:{url:'https://api.github.com/repos/allowed/repo/pulls/8'}},{...issue,repository_url:'https://api.github.com/repos/other/repo'},{...issue,number:9}]) {
      await expect(fixture({'/repos/allowed/repo/issues/8':value}).provider.getContribution!({...contribution,kind:'issue',objectId:'8'})).rejects.toMatchObject({code:'CONTRIBUTION_BINDING_MISMATCH'});
    }
    await expect(fixture({'/repos/allowed/repo/pulls/7':{...pr,base:{repo:{id:82}}}}).provider.getContribution!({...contribution,kind:'pull_request',objectId:'7'})).rejects.toMatchObject({code:'CONTRIBUTION_BINDING_MISMATCH'});
  });
  it('rejects short, uppercase, or symbolic commit references before contacting GitHub',async()=>{
    const {provider,paths}=fixture();
    for(const objectId of ['a'.repeat(7),'A'.repeat(40),'main','heads/main']) {
      await expect(provider.getContribution!({...contribution,kind:'commit',objectId})).rejects.toMatchObject({code:'INVALID_INPUT'});
    }
    for(const objectId of ['0','07','1/../8']) {
      await expect(provider.getContribution!({...contribution,kind:'issue',objectId})).rejects.toMatchObject({code:'INVALID_INPUT'});
    }
    expect(paths).toEqual([]);
  });
  it('rejects a response for a different commit and malformed author or timestamp',async()=>{
    await expect(fixture({[`/repos/allowed/repo/commits/${sha}`]:{...commit,sha:'b'.repeat(40)}}).provider.getContribution!({...contribution,kind:'commit',objectId:sha})).rejects.toMatchObject({code:'CONTRIBUTION_BINDING_MISMATCH'});
    for(const value of [{...commit,author:{id:0}},{...commit,commit:{...commit.commit,author:{date:'invalid'}}}]) {
      await expect(fixture({[`/repos/allowed/repo/commits/${sha}`]:value}).provider.getContribution!({...contribution,kind:'commit',objectId:sha})).rejects.toMatchObject({code:'GITHUB_INVALID_RESPONSE'});
    }
  });
  it('retains installation and repository admission checks for every contribution type',async()=>{
    const outside=fixture({'/installation/repositories?per_page=100&page=1':{repositories:[]}});
    await expect(outside.provider.getContribution!({...contribution,kind:'commit',objectId:sha})).rejects.toMatchObject({code:'REPOSITORY_UNAVAILABLE'});
    expect(outside.paths).not.toContain(`/repos/allowed/repo/commits/${sha}`);
    await expect(fixture().provider.getContribution!({...contribution,repositoryId:'82',kind:'issue',objectId:'8'})).rejects.toMatchObject({code:'REPOSITORY_UNAVAILABLE'});
  });
});
