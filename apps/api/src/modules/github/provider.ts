import { createPrivateKey, createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Config } from '../../config.js';
import { AppError } from '../../core.js';

export interface GitHubInstallation { installationId:string; accountLogin:string; status:'active'|'suspended'|'deleted' }
export interface GitHubRepository { repositoryId:string; owner:string; name:string; fullName:string; isPrivate:boolean }
export interface PullRequestEvidence {
  repositoryId:string; number:number; headSha:string; authorGithubId:string; merged:boolean; url:string;
  checks:{name:string;status:string;conclusion:string|null}[]; fetchedAt:string;
}
export type GitHubContributionKind='commit'|'pull_request'|'issue';
export type GitHubContributionHistoryCursor=
  | {phase:'branches';page:number}
  | {phase:'commits';heads:string[];headIndex:number;page:number;nextBranchPage:number|null}
  | {phase:'issues';page:number};
export interface GitHubContributionEvidence {
  repositoryId:string; kind:GitHubContributionKind; objectId:string; authorGithubId:string|null;
  url:string; title:string; createdAt:string;
}
export interface GitHubRepositoryProvider {
  getInstallation(input:{installationId:string}):Promise<GitHubInstallation>;
  getRepository(input:{installationId:string;owner:string;name:string}):Promise<GitHubRepository>;
  getPullRequest(input:{installationId:string;repositoryId:string;owner:string;name:string;number:number}):Promise<PullRequestEvidence>;
  getContribution?(input:{installationId:string;repositoryId:string;owner:string;name:string;kind:GitHubContributionKind;objectId:string}):Promise<GitHubContributionEvidence>;
  listContributionHistory?(input:{installationId:string;repositoryId:string;owner:string;name:string;cursor:GitHubContributionHistoryCursor|null}):Promise<{
    items:{kind:GitHubContributionKind;objectId:string}[];nextCursor:GitHubContributionHistoryCursor|null;
  }>;
}

const apiOrigin='https://api.github.com';
const numericId=(value:unknown):string=>{
  if ((typeof value==='number' && Number.isSafeInteger(value) && value>0) || (typeof value==='string' && /^[1-9][0-9]*$/.test(value))) return String(value);
  throw new AppError('GITHUB_INVALID_RESPONSE',502);
};
const segment=(value:string)=>encodeURIComponent(value);

// Installation tokens are used only in this call chain, never saved in the database or receipts.
export function githubRepositoryProvider(config:Config,fetcher:typeof fetch=fetch):GitHubRepositoryProvider {
  async function request(path:string,token:string,method='GET',body?:unknown):Promise<any> {
    let response:Response;
    try {
      response=await fetcher(`${apiOrigin}${path}`,{
        method,redirect:'error',signal:AbortSignal.timeout(15000),
        headers:{accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'x-github-api-version':'2026-03-10','user-agent':'AgentZero','content-type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
      });
    } catch { throw new AppError('GITHUB_UNAVAILABLE',503,'GitHub 暂时无法连接，请稍后重试'); }
    if (!response.ok) throw new AppError(response.status===404 || response.status===401 || response.status===403?'GITHUB_ACCESS_DENIED':'GITHUB_UNAVAILABLE',response.status===429 || response.status>=500?503:409,'无法读取 GitHub 安装或仓库，请检查授权及调用额度');
    try { return await response.json(); } catch { throw new AppError('GITHUB_INVALID_RESPONSE',502); }
  }
  async function jwt():Promise<string> {
    if (!config.githubAppId || (!config.githubPrivateKey && !config.githubPrivateKeyPath)) throw new AppError('GITHUB_NOT_CONFIGURED',503,'请先配置 GitHub App ID 和私钥');
    let key;
    try { key=createPrivateKey(config.githubPrivateKey || await readFile(config.githubPrivateKeyPath!,'utf8')); }
    catch { throw new AppError('GITHUB_NOT_CONFIGURED',503,'GitHub App 私钥不可用'); }
    const now=Math.floor(Date.now()/1000);
    const data=`${Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url')}.${Buffer.from(JSON.stringify({iat:now-60,exp:now+540,iss:config.githubAppId})).toString('base64url')}`;
    return `${data}.${createSign('RSA-SHA256').update(data).sign(key,'base64url')}`;
  }
  async function installation(installationId:string) {
    const authorization=await jwt();
    const value=await request(`/app/installations/${segment(installationId)}`,authorization);
    if (numericId(value.id)!==installationId) throw new AppError('GITHUB_ACCESS_DENIED',409);
    return {value,authorization};
  }
  async function tokenFor(installationId:string) {
    const {value,authorization}=await installation(installationId);
    if (value.suspended_at) throw new AppError('GITHUB_ACCESS_DENIED',409,'GitHub App 安装已暂停');
    const result=await request(`/app/installations/${segment(installationId)}/access_tokens`,authorization,'POST');
    if (typeof result.token!=='string' || !result.token) throw new AppError('GITHUB_INVALID_RESPONSE',502);
    return result.token as string;
  }
  async function repositoryWithToken(token:string,owner:string,name:string) {
    const repo=await request(`/repos/${segment(owner)}/${segment(name)}`,token);
    const id=numericId(repo.id);
    // Public metadata alone is readable without installation access. Require actual installation membership.
    let found=false;
    for(let page=1;;page++) {
      const result=await request(`/installation/repositories?per_page=100&page=${page}`,token);
      if (!Array.isArray(result.repositories)) throw new AppError('GITHUB_INVALID_RESPONSE',502);
      found=result.repositories.some((item:any)=>numericId(item.id)===id);
      if(found || result.repositories.length<100) break;
    }
    if(!found || repo.private || repo.archived || repo.disabled) throw new AppError('REPOSITORY_UNAVAILABLE',409,'仅支持已安装 App 且可用的公开仓库');
    if (typeof repo.owner?.login!=='string' || typeof repo.name!=='string' || typeof repo.full_name!=='string') throw new AppError('GITHUB_INVALID_RESPONSE',502);
    return {repositoryId:id,owner:repo.owner.login,name:repo.name,fullName:repo.full_name,isPrivate:repo.private===true} satisfies GitHubRepository;
  }
  return {
    async getInstallation({installationId}) {
      const {value}=await installation(installationId);
      if (typeof value.account?.login!=='string') throw new AppError('GITHUB_INVALID_RESPONSE',502);
      return {installationId,accountLogin:value.account.login,status:value.suspended_at?'suspended':'active'};
    },
    async getRepository({installationId,owner,name}) {return repositoryWithToken(await tokenFor(installationId),owner,name);},
    async listContributionHistory({installationId,repositoryId,owner,name,cursor}) {
      const token=await tokenFor(installationId);
      const repo=await repositoryWithToken(token,owner,name);
      if(repo.repositoryId!==repositoryId) throw new AppError('REPOSITORY_UNAVAILABLE',409);
      const base=`/repos/${segment(repo.owner)}/${segment(repo.name)}`;
      const current:GitHubContributionHistoryCursor=cursor??{phase:'branches',page:1};
      if(current.phase==='branches') {
        const branches=await request(`${base}/branches?per_page=100&page=${current.page}`,token);
        if(!Array.isArray(branches)) throw new AppError('GITHUB_INVALID_RESPONSE',502);
        const heads:string[]=[...new Set<string>(branches.map((branch:any)=>{
          if(typeof branch.commit?.sha!=='string' || !/^[0-9a-f]{40}$/.test(branch.commit.sha)) throw new AppError('GITHUB_INVALID_RESPONSE',502);
          return branch.commit.sha;
        }))];
        return {items:[],nextCursor:heads.length
          ? {phase:'commits',heads,headIndex:0,page:1,nextBranchPage:branches.length===100?current.page+1:null}
          : {phase:'issues',page:1}};
      }
      if(current.phase==='commits') {
        // Pin each branch's head so new pushes cannot shift pages during this scan.
        const commits=await request(`${base}/commits?sha=${segment(current.heads[current.headIndex]!)}&per_page=100&page=${current.page}`,token);
        if(!Array.isArray(commits)) throw new AppError('GITHUB_INVALID_RESPONSE',502);
        const items=commits.map((commit:any)=>{
          if(typeof commit.sha!=='string' || !/^[0-9a-f]{40}$/.test(commit.sha)) throw new AppError('GITHUB_INVALID_RESPONSE',502);
          return {kind:'commit' as const,objectId:commit.sha};
        });
        const nextCursor:GitHubContributionHistoryCursor=commits.length===100?{...current,page:current.page+1}
          : current.headIndex+1<current.heads.length?{...current,headIndex:current.headIndex+1,page:1}
          : current.nextBranchPage!==null?{phase:'branches',page:current.nextBranchPage}:{phase:'issues',page:1};
        return {items,nextCursor};
      }
      // The issues endpoint includes pull requests; keep their distinct reward kind.
      const issues=await request(`${base}/issues?state=all&sort=created&direction=asc&per_page=100&page=${current.page}`,token);
      if(!Array.isArray(issues)) throw new AppError('GITHUB_INVALID_RESPONSE',502);
      return {items:issues.map((issue:any)=>({kind:issue.pull_request?'pull_request' as const:'issue' as const,objectId:numericId(issue.number)})),
        nextCursor:issues.length===100?{phase:'issues',page:current.page+1}:null};
    },
    async getContribution({installationId,repositoryId,owner,name,kind,objectId}) {
      if(!['commit','pull_request','issue'].includes(kind) || !(kind==='commit'?/^[0-9a-f]{40}$/:/^[1-9][0-9]*$/).test(objectId)) throw new AppError('INVALID_INPUT',400,'请提供完整的小写 commit SHA 或有效的 PR、Issue 编号');
      const token=await tokenFor(installationId);
      const repo=await repositoryWithToken(token,owner,name);
      if(repo.repositoryId!==repositoryId) throw new AppError('REPOSITORY_UNAVAILABLE',409);
      const base=`/repos/${segment(repo.owner)}/${segment(repo.name)}`;
      const path=kind==='commit'?'commits':kind==='pull_request'?'pulls':'issues';
      const value=await request(`${base}/${path}/${objectId}`,token);
      let authorGithubId:string|null,title:string,createdAt:string;
      if(kind==='commit') {
        if(value.sha!==objectId) throw new AppError('CONTRIBUTION_BINDING_MISMATCH',409,'GitHub 提交与所选贡献不一致');
        // Git author metadata and the committer cannot substitute for GitHub's linked author.
        authorGithubId=value.author===null?null:numericId(value.author?.id);
        title=value.commit?.message;
        createdAt=value.commit?.author?.date;
      } else {
        if(numericId(value.number)!==objectId || (kind==='pull_request'?numericId(value.base?.repo?.id)!==repositoryId:Boolean(value.pull_request) || value.repository_url!==`${apiOrigin}${base}`)) throw new AppError('CONTRIBUTION_BINDING_MISMATCH',409,'GitHub 仓库、类型或编号与所选贡献不一致');
        authorGithubId=numericId(value.user?.id);
        title=value.title;
        createdAt=value.created_at;
      }
      if(typeof title!=='string' || typeof createdAt!=='string' || !Number.isFinite(Date.parse(createdAt))) throw new AppError('GITHUB_INVALID_RESPONSE',502);
      return {repositoryId,kind,objectId,authorGithubId,title:kind==='commit'?title.split(/\r?\n/,1)[0]!:title,createdAt,url:`https://github.com/${segment(repo.owner)}/${segment(repo.name)}/${kind==='pull_request'?'pull':kind==='commit'?'commit':'issues'}/${objectId}`};
    },
    async getPullRequest({installationId,repositoryId,owner,name,number}) {
      const token=await tokenFor(installationId);
      const repo=await repositoryWithToken(token,owner,name);
      if(repo.repositoryId!==repositoryId) throw new AppError('REPOSITORY_UNAVAILABLE',409);
      const base=`/repos/${segment(repo.owner)}/${segment(repo.name)}`;
      const pr=await request(`${base}/pulls/${number}`,token);
      if(numericId(pr.base?.repo?.id)!==repositoryId || pr.number!==number || !/^[0-9a-f]{40}$/.test(pr.head?.sha??'')) throw new AppError('PR_BINDING_MISMATCH',409);
      const headSha=pr.head.sha as string;
      const checks:PullRequestEvidence['checks']=[];
      for(let page=1;;page++) {
        const result=await request(`${base}/commits/${headSha}/check-runs?filter=latest&per_page=100&page=${page}`,token);
        if(!Array.isArray(result.check_runs)) throw new AppError('GITHUB_INVALID_RESPONSE',502);
        for(const run of result.check_runs) {
          if(run.head_sha!==headSha || typeof run.name!=='string') throw new AppError('GITHUB_INVALID_RESPONSE',502);
          checks.push({name:run.name,status:run.status,conclusion:run.conclusion});
        }
        if(result.check_runs.length<100) break;
      }
      // Statuses are newest first; retain the latest result per context across every page.
      const contexts=new Set<string>();
      for(let page=1;;page++) {
        const statuses=await request(`${base}/commits/${headSha}/statuses?per_page=100&page=${page}`,token);
        if(!Array.isArray(statuses)) throw new AppError('GITHUB_INVALID_RESPONSE',502);
        for(const status of statuses) if(!contexts.has(status.context)) {
          contexts.add(status.context);
          checks.push({name:status.context,status:status.state==='pending'?'pending':'completed',conclusion:status.state==='success'?'success':status.state==='pending'?null:'failure'});
        }
        if(statuses.length<100) break;
      }
      // Detect a force-push while the checks were being read. No evidence is accepted for a different head.
      const current=await request(`${base}/pulls/${number}`,token);
      if(current.head?.sha!==headSha || numericId(current.base?.repo?.id)!==repositoryId || current.number!==number) throw new AppError('PR_BINDING_MISMATCH',409,'PR 提交已改变，请重新提交成果');
      return {repositoryId,number,headSha,authorGithubId:numericId(current.user?.id),merged:current.merged===true,url:`https://github.com/${segment(repo.owner)}/${segment(repo.name)}/pull/${number}`,checks,fetchedAt:new Date().toISOString()};
    },
  };
}
